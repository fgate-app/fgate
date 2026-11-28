import {isXhttp,validateXhttp,parseXhttpObject} from '../shared/xray-xhttp.js';
import {validateXrayMux} from '../shared/xray-mux.js';
import {normalizeXraySecurity} from '../shared/xray-security.js';
import {validateVlessTransport} from '../shared/vless-transport.js';
import {inflateSync} from 'node:zlib';
const LIMIT=1024*1024;
const invalid=()=>new Error("Invalid Amnezia Xray / VLESS configuration.");
const unsupportedLink=()=>Object.assign(Error('This VLESS link contains unsupported options. Import an Xray JSON configuration instead.'),{code:'VLESS_LINK_OPTIONS_UNSUPPORTED'});

export function decodeAmnezia(value){
 try{
  const encoded=value.slice(6).split('#',1)[0];
  if(!/^[\w-]+={0,2}$/.test(encoded) || encoded.length>LIMIT*2)throw invalid();
  const packed=Buffer.from(encoded,'base64url');
  if(packed.length<7)throw invalid();
  const expected=packed.readUInt32BE();
  if(!expected || expected>LIMIT)throw invalid();
  const decoded=inflateSync(packed.subarray(4),{maxOutputLength:LIMIT});
  if(decoded.length!==expected)throw invalid();
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(decoded));
 }catch{throw invalid();}
}

export function normalizeXrayProfile(input){
 let root=input;
 if(typeof root==='string'){
  if(root.startsWith('vpn://'))root=decodeAmnezia(root);
  else if(root.startsWith('vless://'))root=vlessLink(root);
  else {try{root=JSON.parse(root);}catch{throw invalid();}}
 }
 if(root?.containers){
  const container=root.containers.find(item=>item.container===root.defaultContainer) || (root.containers.length===1?root.containers[0]:null);
  if(container?.container!=='amnezia-xray' || !container.xray?.last_config)throw new Error("The Amnezia link does not contain the selected Xray profile.");
  root=container.xray.last_config;
  if(typeof root==='string'){try{root=JSON.parse(root);}catch{throw invalid();}}
 }
 const outbounds=root?.outbounds?.filter(item=>item?.protocol==='vless');
 if(outbounds?.length!==1)throw invalid();
 const source=outbounds[0], peers=source.settings?.vnext;
 const peer=peers?.[0];
 if(peers?.length!==1 || typeof peer.address!=='string' || !peer.address || /[\s/]/.test(peer.address) || !Number.isInteger(peer.port) || peer.port<1 || peer.port>65535 || peer.users?.length!==1 || typeof peer.users[0].id!=='string' || !peer.users[0].id)throw invalid();
 // Only a VLESS transport is imported. No provider listeners, routes, DNS,
 // arbitrary chained outbounds, bind interfaces, socket marks or log files.
 const stream=source.streamSettings || {};
 const network=stream.network || 'tcp';
 const security=stream.security || 'none';
 const user=peer.users[0];
 validateVlessTransport({network,security,flow:user.flow,encryption:(user.encryption===undefined?'none':user.encryption)});
 const outbound={protocol:'vless',settings:{vnext:[{address:peer.address,port:peer.port,users:[{id:user.id,encryption:(user.encryption===undefined?'none':user.encryption),...(user.flow?{flow:user.flow}:{})}]}]},streamSettings:{network,security}};
 normalizeXraySecurity(structuredClone(stream));
 const fields=['tcpSettings','rawSettings','wsSettings','grpcSettings','httpupgradeSettings','xhttpSettings','splithttpSettings','tlsSettings','realitySettings'];
 for(const field of fields)if(stream[field] && typeof stream[field]==='object')outbound.streamSettings[field]=structuredClone(stream[field]);
 if(network==='splithttp' && !outbound.streamSettings.xhttpSettings && outbound.streamSettings.splithttpSettings){
  outbound.streamSettings.xhttpSettings=outbound.streamSettings.splithttpSettings;delete outbound.streamSettings.splithttpSettings;
 }
 // REALITY client fields only: server configuration can reference private files.
 if(outbound.streamSettings.realitySettings){
  const source=outbound.streamSettings.realitySettings;
  outbound.streamSettings.realitySettings=Object.fromEntries(['serverName','fingerprint','publicKey','password','shortId','spiderX','mldsa65Verify'].filter(key=>source[key]!==undefined).map(key=>[key,source[key]]));
 }
 if(outbound.streamSettings.tlsSettings){
  const source=outbound.streamSettings.tlsSettings;
  outbound.streamSettings.tlsSettings=Object.fromEntries(['serverName','fingerprint','alpn','allowInsecure','pinnedPeerCertificateChainSha256','pinnedPeerCertSha256','verifyPeerCertByName'].filter(key=>source[key]!==undefined).map(key=>[key,source[key]]));
 }
 if(source.mux!==undefined && source.mux!==null)validateXrayMux({...outbound,mux:source.mux});
 if(source.mux && typeof source.mux==='object')outbound.mux=structuredClone(source.mux);
 for(const key of ['xhttpSettings','splithttpSettings'])if(outbound.streamSettings[key]!==undefined)validateXhttp(outbound.streamSettings[key]);
 if(isXhttp(network))validateXhttp(outbound.streamSettings.xhttpSettings || {});
 normalizeXraySecurity(outbound.streamSettings);validateXrayMux(outbound);
 return {outbounds:[outbound]};
}

function vlessLink(value){
 try{
  const uri=new URL(value),q=uri.searchParams;
  if((q.has('headerType') && q.get('headerType')!=='none') || (['extra','downloadSettings'].some(key=>q.has(key)) && !isXhttp(q.get('type'))))throw unsupportedLink();
  const network=q.get('type') || 'tcp',security=q.get('security') || 'none';
  const streamSettings={network,security};
  if(security==='reality')streamSettings.realitySettings={serverName:q.get('sni') || '',fingerprint:q.get('fp') || 'chrome',publicKey:q.get('pbk') || '',shortId:q.get('sid') || '',spiderX:q.get('spx') || ''};
  if(security==='tls')streamSettings.tlsSettings={serverName:q.get('sni') || uri.hostname,fingerprint:q.get('fp') || 'chrome',...(q.get('alpn')?{alpn:q.get('alpn').split(',')}:{})};
  if(security==='tls' && (q.has('allowInsecure') || q.has('insecure'))){
   const flag=q.get('allowInsecure') ?? q.get('insecure');
   if(!['0','1','false','true'].includes(flag))throw invalid();
   streamSettings.tlsSettings.allowInsecure=['1','true'].includes(flag);
  }
  if(security==='tls')for(const [key,alias] of [['pinnedPeerCertSha256','pcs'],['verifyPeerCertByName','vcn']]){if(q.has(key) && q.has(alias) && q.get(key)!==q.get(alias))throw unsupportedLink();if(q.has(key) || q.has(alias))streamSettings.tlsSettings[key]=q.get(key) ?? q.get(alias);}
  if(security==='reality')for(const [key,alias] of [['spiderX','spx'],['mldsa65Verify','pqv']]){if(q.has(key) && q.has(alias) && q.get(key)!==q.get(alias))throw unsupportedLink();if(q.has(key) || q.has(alias))streamSettings.realitySettings[key]=q.get(key) ?? q.get(alias);}
  if(network==='ws')streamSettings.wsSettings={path:q.get('path') || '/',headers:{Host:q.get('host') || uri.hostname}};
  if(network==='httpupgrade')streamSettings.httpupgradeSettings={path:q.get('path') || '/',host:q.get('host') || ''};
  if(network==='grpc'){
   if(q.has('mode') && !['gun','multi'].includes(q.get('mode')))throw invalid();
   streamSettings.grpcSettings={serviceName:q.get('serviceName') || '',...(q.has('mode')?{multiMode:q.get('mode')==='multi'}:{}),...(q.has('authority')?{authority:q.get('authority')}:{})};
  }
  if(['xhttp','splithttp'].includes(network))streamSettings.xhttpSettings={path:q.get('path') || '/',host:q.get('host') || '',mode:q.get('mode') || 'auto',...(q.has('extra')?{extra:parseXhttpObject(q.get('extra'))}:{}),...(q.has('downloadSettings')?{downloadSettings:parseXhttpObject(q.get('downloadSettings'))}:{})};
  return {outbounds:[{protocol:'vless',settings:{vnext:[{address:uri.hostname.replace(/^\[|\]$/g,''),port:Number(uri.port || 443),users:[{id:decodeURIComponent(uri.username),encryption:q.get('encryption') ?? 'none',flow:q.get('flow') || ''}]}]},streamSettings}]};
 }catch(error){if(['VLESS_LINK_OPTIONS_UNSUPPORTED','XHTTP_SETTINGS_INVALID'].includes(error.code))throw error;throw invalid();}
}
