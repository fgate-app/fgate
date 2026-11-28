export const xraySecurityFields=['alpn','pinnedPeerCertSha256','verifyPeerCertByName','spiderX','mldsa65Verify'];
export const securityFieldVisible=(field,security)=>['alpn','pinnedPeerCertSha256','verifyPeerCertByName'].includes(field)?security==='tls':security==='reality';
const fail=message=>{throw Error(message);};
export function normalizeXraySecurity(stream){
 for(const key of ['tlsSettings','realitySettings'])if(stream[key]!==undefined && (!stream[key] || typeof stream[key]!=='object' || Array.isArray(stream[key])))fail('Invalid Xray security settings.');
 const tls=stream.tlsSettings;
 if(tls){
  if(tls.pinnedPeerCertificateChainSha256?.length)fail('Legacy certificate-chain pins are unsupported. Replace them with SHA-256 certificate pins.');
  if(tls.allowInsecure!==undefined && typeof tls.allowInsecure!=='boolean')fail('Invalid Xray security settings.');
  if(tls.allowInsecure===true)fail('Disabling certificate verification is unsupported. Use a certificate pin or verified certificate name.');
  if(tls.alpn!==undefined && (!Array.isArray(tls.alpn) || tls.alpn.some(v=>typeof v!=='string' || !v || new TextEncoder().encode(v).length>255 || /[\s,\x00-\x1f\x7f]/.test(v))))fail('Enter ALPN protocols separated by commas.');
  if(tls.pinnedPeerCertSha256!==undefined && tls.pinnedPeerCertSha256!==''){
   if(typeof tls.pinnedPeerCertSha256!=='string')fail('Enter SHA-256 certificate fingerprints as hexadecimal values separated by commas.');
   const pins=tls.pinnedPeerCertSha256.split(',').map(v=>v.trim().replaceAll(':','').toLowerCase());
   if(pins.some(v=>!/^([a-f0-9]{64})$/.test(v)))fail('Enter SHA-256 certificate fingerprints as hexadecimal values separated by commas.');
   tls.pinnedPeerCertSha256=[...new Set(pins)].join(',');
  }
  if(tls.verifyPeerCertByName!==undefined && (typeof tls.verifyPeerCertByName!=='string' || tls.verifyPeerCertByName && tls.verifyPeerCertByName.split(',').some(v=>!v.trim() || /[\s/?#@]/.test(v.trim()))))fail('Enter certificate names separated by commas.');
 }
 const reality=stream.realitySettings;
 if(reality){
  if(reality.spiderX!==undefined && (typeof reality.spiderX!=='string' || reality.spiderX && (!reality.spiderX.startsWith('/') || /[\x00-\x1f\x7f]/.test(reality.spiderX))))fail('SpiderX must be a path starting with /.');
  if(reality.mldsa65Verify!==undefined && (typeof reality.mldsa65Verify!=='string' || reality.mldsa65Verify && !/^[A-Za-z0-9_-]{2603}$/.test(reality.mldsa65Verify)))fail('Enter a valid ML-DSA-65 verification key.');
 }
 return stream;
}
export function xraySecuritySettings(fields){
 const stream={};
 if(fields.security==='tls'){
  const settings={};
  if(fields.alpn?.trim())settings.alpn=fields.alpn.split(',').map(v=>v.trim());
  for(const key of ['pinnedPeerCertSha256','verifyPeerCertByName'])if(fields[key]?.trim())settings[key]=fields[key].trim();
  stream.tlsSettings=settings;
 }else if(fields.security==='reality'){
  stream.realitySettings={};for(const key of ['spiderX','mldsa65Verify'])if(fields[key])stream.realitySettings[key]=fields[key];
 }
 return normalizeXraySecurity(stream);
}
export function xrayAlpnHint(fields){
 if(fields.security!=='tls')return '';
 const alpn=(fields.alpn || '').split(',').map(v=>v.trim()).filter(Boolean);
 if(fields.network==='ws')return alpn.length && !alpn.includes('http/1.1')?'WebSocket needs HTTP/1.1. Check ALPN on both client and server.':'WebSocket uses HTTP/1.1. The server must negotiate it even when the client also offers h2.';
 if(fields.network==='grpc')return alpn.length && alpn[0]!=='h2'?'gRPC needs HTTP/2. Check that h2 is first in ALPN.':'gRPC uses HTTP/2. The server must negotiate h2.';
 return '';
}
