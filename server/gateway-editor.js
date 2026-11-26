import {nativePrefix,mihomoDraft,mihomoFromDraft} from '../shared/mihomo-proxy.js';
import {normalizeTorSettings} from '../shared/tor.js';
import {normalizeHysteria2} from '../shared/hysteria2.js';
import {normalizeSsProfile} from './ss-profile.js';
import {normalizeXrayProfile} from './xray-profile.js';
import {manualFields,manualConfig,visibleFields} from '../shared/manual-gateway.js';
const xpaths={server:['settings','vnext',0,'address'],port:['settings','vnext',0,'port'],uuid:['settings','vnext',0,'users',0,'id'],flow:['settings','vnext',0,'users',0,'flow'],security:['streamSettings','security'],network:['streamSettings','network']};
function paths(out){
 const stream=out.streamSettings || {},security=stream.security==='reality'?'realitySettings':'tlsSettings';
 const transport=['xhttp','splithttp'].includes(stream.network)?'xhttpSettings':stream.network==='httpupgrade'?'httpupgradeSettings':'wsSettings';
 return {...xpaths,sni:['streamSettings',security,'serverName'],fingerprint:['streamSettings',security,'fingerprint'],publicKey:['streamSettings','realitySettings','publicKey'],shortId:['streamSettings','realitySettings','shortId'],path:['streamSettings',transport,'path'],host:['streamSettings',transport,...(transport==='wsSettings'?['headers','Host']:['host'])],serviceName:['streamSettings','grpcSettings','serviceName']};
}
export function gatewayEditor(snapshot){
 const row=snapshot?.config;if(!row || snapshot.profile.builtin && row.engine!=='tor')throw new Error("The configuration is not available for editing.");
 if(row.engine==='tor')return {type:'tor',settings:normalizeTorSettings(JSON.parse(row.config))};
 let type,fields={};
 if(row.engine==='xray'){
  type='vless';const out=normalizeXrayProfile(row.config).outbounds[0];
  for(const [f,path] of Object.entries(paths(out)))fields[f]=path.reduce((v,k)=>v?.[k],out) ?? '';
  fields.publicKey ||= out.streamSettings?.realitySettings?.password || '';
  fields.security ||= 'none';fields.network ||= 'tcp';
 }else if(row.engine==='outline' || row.config.startsWith('ss://')){
  type='ss';const node=normalizeSsProfile(row.config);fields={server:node.server,port:node.port,cipher:node.cipher,password:node.password,prefix:node.prefix_hex || ''};
 }else if(row.engine==='mihomo'){
  const saved=JSON.parse(row.config);
  if(saved.mihomo)return {type:nativePrefix+saved.mihomo.type,gatewayId:snapshot.profile.gateway_id || null,fields:mihomoDraft(saved.mihomo)};
  const p=saved.type==='hysteria2'?normalizeHysteria2(saved):saved;type=p.type;
  for(const f of manualFields[type] || [])fields[f]=Array.isArray(p[f])?p[f].join(', '):(p[f] ?? '');
 }else if(/^socks5?:\/\//i.test(row.config)){
  type='socks5';const u=new URL(row.config);fields={server:u.hostname.replace(/^\[|\]$/g,''),port:Number(u.port || 1080),username:decodeURIComponent(u.username),password:decodeURIComponent(u.password)};
 }else throw new Error("The configuration is not available for editing.");
 return {type,gatewayId:snapshot.profile.gateway_id || null,dpiBypass:row.engine==='outline' && snapshot.profile.dpi_bypass===1,fields:Object.fromEntries(Object.entries(fields).map(([k,v])=>[k,String(v)]))};
}
export function editGatewayConfig(snapshot,input){
 const original=gatewayEditor(snapshot);
 if(!input || input.type!==original.type || !input.fields || typeof input.fields!=='object' || Array.isArray(input.fields))throw new Error("Invalid connection fields.");
 const fields={...original.fields};
 for(const [k,v] of Object.entries(input.fields)){
  if(!(manualFields[original.type] || []).includes(k) || typeof v!=='string')throw new Error("Invalid connection fields.");fields[k]=v;
 }
 if(original.type.startsWith(nativePrefix))return JSON.stringify({mihomo:mihomoFromDraft(original.type.slice(nativePrefix.length),fields)});
 const changes=Object.keys(fields).filter(k=>fields[k]!==original.fields[k]);
 if(!changes.length)return snapshot.config.config;
 // Validate the form, then patch only represented fields in the saved config.
 const generated=manualConfig(original.type,fields);
 if(original.type==='vless'){
  const active=visibleFields('vless',fields);
  const dependent=[...(changes.includes('security')?['sni','fingerprint','publicKey','shortId']:[]),...(changes.includes('network')?['path','host','serviceName']:[])];
  for(const f of dependent)if(active.includes(f) && !changes.includes(f))changes.push(f);
  const root=normalizeXrayProfile(snapshot.config.config),out=root.outbounds[0];
  const location=paths({...out,streamSettings:{...out.streamSettings,security:fields.security,network:fields.network}});
  for(const f of changes){const path=location[f];let target=out;for(const k of path.slice(0,-1))target=target[k] ||= {};target[path.at(-1)]=f==='port'?Number(fields[f]):fields[f];}
  return JSON.stringify(root);
 }
 if(['wireguard','openvpn'].includes(original.type)){
  const root=JSON.parse(snapshot.config.config),next=JSON.parse(generated);
  for(const f of changes){if(next[f]===undefined)delete root[f];else root[f]=next[f];}
  return JSON.stringify(root);
 }
 if(original.type==='ss'){
  const suffix=snapshot.config.config.split('?')[1]?.split('#')[0];
  if(!changes.includes('prefix') && suffix)return generated.split('?')[0]+'?'+suffix;
 }
 return generated;
}
