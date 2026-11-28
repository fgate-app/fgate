import {xhttpDownloadStream} from '../shared/xray-xhttp.js';
import {normalizeXrayProfile} from './xray-profile.js';
import {isIP} from 'node:net';
import {lookup} from 'node:dns/promises';
import {gatewayEditor} from './gateway-editor.js';

export const recursionError='This server belongs to an access point on this system. It cannot be used as a gateway because it would create a routing loop.';
// URL canonicalization also rejects alternate spellings of the same IP address.
export function canonicalGatewayHost(value){
 let host=String(value || '').trim().replace(/^\[|\]$/g,'').replace(/\.$/,'').toLowerCase();
 if(!host)return '';
 try{host=new URL('http://'+(host.includes(':')?'['+host+']':host)).hostname.replace(/^\[|\]$/g,'');}catch{return host;}
 const mapped=/^::ffff:([a-f\d]{1,4}):([a-f\d]{1,4})$/.exec(host);
 if(mapped){const n=parseInt(mapped[1]+mapped[2].padStart(4,'0'),16);return [n>>>24,(n>>>16)&255,(n>>>8)&255,n&255].join('.');}
 return host;
}
export function accessPointHosts(points){
 const configured=points.filter(point=>point.managed && point.cloudAddress).map(point=>{try{return new URL(point.cloudAddress).hostname;}catch{return '';}});
 return [...new Set([...points.map(point=>point.host),...configured].map(canonicalGatewayHost).filter(Boolean))];
}
export function gatewayHost(snapshot){
 if(!snapshot?.config || snapshot.profile.builtin || ['tor','direct','zapret'].includes(snapshot.config.engine))return '';
 return canonicalGatewayHost(gatewayEditor(snapshot).fields?.server);
}
// Native multi-peer gateways can connect without a top-level server field.
export function gatewayHosts(snapshot){
 const hosts=[gatewayHost(snapshot)];
 if(snapshot?.config?.engine==='xray'){const stream=normalizeXrayProfile(snapshot.config.config).outbounds[0].streamSettings;hosts.push(xhttpDownloadStream(stream)?.address);}
 if(snapshot?.config?.engine==='mihomo'){
  const saved=JSON.parse(snapshot.config.config),proxy=saved.mihomo || saved;
  if(proxy.type==='wireguard')hosts.push(...(proxy.peers || []).map(peer=>peer.server));
  if(proxy.type==='easytier')for(const peer of proxy.peers || []){
   try{hosts.push(new URL(peer).hostname);}catch{throw Error('Invalid mihomo proxy configuration.');}
  }
  if(proxy.type==='tailscale' && proxy['control-url']){
   try{hosts.push(new URL(proxy['control-url']).hostname);}catch{throw Error('Invalid mihomo proxy configuration.');}
  }
 }
 return [...new Set(hosts.map(canonicalGatewayHost).filter(Boolean))];
}
export function assertNoAccessPointGateway(snapshot,points){
 const hosts=gatewayHosts(snapshot);
 if(hosts.some(host=>accessPointHosts(points).includes(host)))throw Object.assign(Error(recursionError),{code:'GATEWAY_ACCESS_POINT_LOOP'});
}
// DNS is advisory: an offline import still receives the exact-address check.
// Re-read access points after DNS work so changes during lookup are checked too.
export async function assertNoResolvedAccessPointGateway(snapshots,getPoints,{resolve=lookup,timeoutMs=1500}={}){
 const hosts=[...new Set(snapshots.flatMap(gatewayHosts))];
 snapshots.forEach(snapshot=>assertNoAccessPointGateway(snapshot,getPoints()));
 const addresses=new Map();
 await Promise.all([...new Set([...hosts,...accessPointHosts(getPoints())])].map(async host=>{
  if(isIP(host)){addresses.set(host,[host]);return;}
  let timer;
  try{const rows=await Promise.race([resolve(host,{all:true,verbatim:true}),new Promise(r=>{timer=setTimeout(()=>r([]),timeoutMs);})]);addresses.set(host,rows.map(row=>canonicalGatewayHost(row.address)));}
  catch{addresses.set(host,[]);}finally{clearTimeout(timer);}
 }));
 const forbidden=new Set(accessPointHosts(getPoints()).flatMap(host=>[host,...(addresses.get(host)||[])]));
 for(const snapshot of snapshots){assertNoAccessPointGateway(snapshot,getPoints());const hosts=gatewayHosts(snapshot);if(hosts.some(host=>(addresses.get(host)||[]).some(address=>forbidden.has(address))))throw Object.assign(Error(recursionError),{code:'GATEWAY_ACCESS_POINT_LOOP'});}
}
