import {inflateSync} from 'node:zlib';
const LIMIT=1024*1024;
const invalid=()=>new Error("Invalid Amnezia Xray / VLESS configuration.");

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
 if(!['tcp','raw','ws','grpc','httpupgrade','xhttp','splithttp'].includes(network))throw new Error("This Xray transport is not supported yet.");
 const security=stream.security || 'none';
 if(!['none','tls','reality'].includes(security))throw invalid();
 const user=peer.users[0];
 const outbound={protocol:'vless',settings:{vnext:[{address:peer.address,port:peer.port,users:[{id:user.id,encryption:user.encryption || 'none',...(user.flow?{flow:user.flow}:{})}]}]},streamSettings:{network,security}};
 const fields=['tcpSettings','rawSettings','wsSettings','grpcSettings','httpupgradeSettings','xhttpSettings','splithttpSettings','tlsSettings','realitySettings'];
 for(const field of fields)if(stream[field] && typeof stream[field]==='object')outbound.streamSettings[field]=structuredClone(stream[field]);
 // REALITY client fields only: server configuration can reference private files.
 if(outbound.streamSettings.realitySettings){
  const source=outbound.streamSettings.realitySettings;
  outbound.streamSettings.realitySettings=Object.fromEntries(['serverName','fingerprint','publicKey','password','shortId','spiderX','mldsa65Verify'].filter(key=>source[key]!==undefined).map(key=>[key,source[key]]));
 }
 if(outbound.streamSettings.tlsSettings){
  const source=outbound.streamSettings.tlsSettings;
  outbound.streamSettings.tlsSettings=Object.fromEntries(['serverName','fingerprint','alpn','allowInsecure','pinnedPeerCertificateChainSha256'].filter(key=>source[key]!==undefined).map(key=>[key,source[key]]));
 }
 if(source.mux && typeof source.mux==='object')outbound.mux=structuredClone(source.mux);
 return {outbounds:[outbound]};
}

function vlessLink(value){
 try{
  const uri=new URL(value),q=uri.searchParams;
  const network=q.get('type') || 'tcp',security=q.get('security') || 'none';
  const streamSettings={network,security};
  if(security==='reality')streamSettings.realitySettings={serverName:q.get('sni') || '',fingerprint:q.get('fp') || 'chrome',publicKey:q.get('pbk') || '',shortId:q.get('sid') || '',spiderX:q.get('spx') || ''};
  if(security==='tls')streamSettings.tlsSettings={serverName:q.get('sni') || uri.hostname,fingerprint:q.get('fp') || 'chrome',...(q.get('alpn')?{alpn:q.get('alpn').split(',')}:{})};
  if(network==='ws')streamSettings.wsSettings={path:q.get('path') || '/',headers:{Host:q.get('host') || uri.hostname}};
  if(network==='grpc')streamSettings.grpcSettings={serviceName:q.get('serviceName') || ''};
  if(['xhttp','splithttp'].includes(network))streamSettings.xhttpSettings={path:q.get('path') || '/',host:q.get('host') || '',mode:q.get('mode') || 'auto'};
  return {outbounds:[{protocol:'vless',settings:{vnext:[{address:uri.hostname.replace(/^\[|\]$/g,''),port:Number(uri.port || 443),users:[{id:decodeURIComponent(uri.username),encryption:'none',flow:q.get('flow') || ''}]}]},streamSettings}]};
 }catch{throw invalid();}
}
