import {normalizeXraySecurity} from './xray-security.js';
export const xhttpFields=['xhttpMode','xhttpHeaders','xhttpXmux','xhttpExtra','xhttpDownload'];
export const isXhttp=network=>['xhttp','splithttp'].includes(network);
const fail=()=>{throw Object.assign(Error('Invalid XHTTP settings. Check the mode, JSON fields and supported download transport; local files and socket options are not allowed.'),{code:'XHTTP_SETTINGS_INVALID'});};
const object=v=>!!v && typeof v==='object' && !Array.isArray(v);
const json=value=>{try{const v=JSON.parse(value);if(!object(v))fail();return v;}catch{fail();}};
const range=(v,positive=false)=>{
 const parts=typeof v==='number'?[v]:typeof v==='string' && /^\d+(?:-\d+)?$/.test(v)?v.split('-').map(Number):[];
 if(!parts.length || parts.some(n=>!Number.isInteger(n) || n<(positive?1:0) || n>2147483647) || parts.length===2 && parts[0]>parts[1])fail();
 return parts;
};
const options=['headers','xPaddingBytes','xPaddingObfsMode','xPaddingKey','xPaddingHeader','xPaddingPlacement','xPaddingMethod','uplinkHTTPMethod','sessionIDPlacement','sessionIDKey','sessionIDTable','sessionIDLength','seqPlacement','seqKey','uplinkDataPlacement','uplinkDataKey','uplinkChunkSize','noGRPCHeader','noSSEHeader','scMaxEachPostBytes','scMinPostsIntervalMs','scMaxBufferedPosts','scStreamUpServerSecs','serverMaxHeaderBytes','xmux','downloadSettings','h2Params'];
const token=/^[!#$%&'*+.^_`|~\w-]+$/;
function validateOptions(c,mode,depth){
 for(const k of Object.keys(c))if(!options.includes(k))fail();
 for(const [k,v] of Object.entries(c)){
  if(['xPaddingBytes','sessionIDLength','uplinkChunkSize','scMaxEachPostBytes','scMinPostsIntervalMs','scStreamUpServerSecs'].includes(k))range(v,k==='xPaddingBytes' && v!==0 && v!=='0');
  else if(['xPaddingObfsMode','noGRPCHeader','noSSEHeader'].includes(k)){if(typeof v!=='boolean')fail();}
  else if(['scMaxBufferedPosts','serverMaxHeaderBytes'].includes(k)){if(!Number.isSafeInteger(v) || v<0 || v>(k==='serverMaxHeaderBytes'?2147483647:Number.MAX_SAFE_INTEGER))fail();}
  else if(k==='headers'){
   if(!object(v) || Object.entries(v).some(([name,value])=>!token.test(name) || name.toLowerCase()==='host' || typeof value!=='string' || /[\x00-\x1f\x7f]/.test(value)))fail();
  }else if(k==='xmux'){
   if(!object(v))fail();
   for(const [name,value] of Object.entries(v)){if(!['maxConcurrency','maxConnections','cMaxReuseTimes','hMaxRequestTimes','hMaxReusableSecs','hKeepAlivePeriod'].includes(name))fail();if(name==='hKeepAlivePeriod'){if(!Number.isSafeInteger(value) || value< -1)fail();}else range(value);}
   const nonzero=v=>v!==undefined && String(v).split('-').some(n=>Number(n)>0);
   if(nonzero(v.maxConnections) && nonzero(v.maxConcurrency))fail();
  }else if(k==='downloadSettings'){
   if(depth || mode==='stream-one')fail();validateDownload(v);
  }else if(k==='h2Params'){if(!object(v))fail();}
  else if(typeof v!=='string' || /[\x00-\x1f\x7f]/.test(v))fail();
 }
 if(c.sessionIDTable){const lengths=range(c.sessionIDLength);if(/[^\x00-\x7f]/.test(c.sessionIDTable) || lengths.some(n=>n<1 || n>128))fail();}
 const enums={xPaddingPlacement:['','cookie','header','query','queryInHeader'],xPaddingMethod:['','repeat-x','tokenish'],sessionIDPlacement:['','path','cookie','header','query'],seqPlacement:['','path','cookie','header','query'],uplinkDataPlacement:['','auto','body','cookie','header']};
 for(const [k,values] of Object.entries(enums))if(c[k]!==undefined && !values.includes(c[k]))fail();
 if((['cookie','header'].includes(c.uplinkDataPlacement) || c.uplinkHTTPMethod?.toUpperCase()==='GET') && mode!=='packet-up')fail();
 if(c.uplinkHTTPMethod && !token.test(c.uplinkHTTPMethod))fail();
}
function validateDownload(v){
 if(!object(v) || Object.keys(v).some(k=>!['address','port','network','security','tlsSettings','realitySettings','xhttpSettings','splithttpSettings'].includes(k)))fail();
 if(typeof v.address!=='string' || !v.address || /[\s/?#@]/.test(v.address) || !Number.isInteger(v.port) || v.port<1 || v.port>65535 || !isXhttp(v.network) || !['none','tls','reality'].includes(v.security || 'none'))fail();
 for(const [branch,keys] of [['tlsSettings',['serverName','fingerprint','alpn','allowInsecure','pinnedPeerCertSha256','verifyPeerCertByName']],['realitySettings',['serverName','fingerprint','publicKey','password','shortId','spiderX','mldsa65Verify']]])if(v[branch]!==undefined && (!object(v[branch]) || Object.keys(v[branch]).some(k=>!keys.includes(k))))fail();
 if(v.xhttpSettings!==undefined && v.splithttpSettings!==undefined)fail();
 normalizeXraySecurity(v);
 if(v.security==='reality' && !(v.realitySettings?.password || v.realitySettings?.publicKey))fail();
 validateXhttp(v.xhttpSettings || v.splithttpSettings || {},1);
}
export function validateXhttp(c,depth=0){
 if(!object(c) || Object.keys(c).some(k=>!['host','path','mode','extra',...options].includes(k)))fail();
 for(const k of ['host','path','mode'])if(c[k]!==undefined && (typeof c[k]!=='string' || /[\x00-\x1f\x7f]/.test(c[k])))fail();
 const mode=c.mode || 'auto';if(!['auto','packet-up','stream-up','stream-one'].includes(mode))fail();
 // Xray gives extra precedence over every field except host/path/mode.
 if(c.extra!==undefined && !object(c.extra))fail();
 const rest=Object.fromEntries(Object.entries(c).filter(([k])=>!['host','path','mode','extra'].includes(k)));
 validateOptions(rest,mode,depth);if(c.extra!==undefined)validateOptions(c.extra,mode,depth);
 return c;
}
export function xhttpDraft(c={}){
 const effective=c.extra ?? c,format=v=>v===undefined?'':JSON.stringify(v,null,2);
 return {xhttpMode:c.mode || 'auto',xhttpHeaders:format(effective.headers),xhttpXmux:format(effective.xmux),xhttpDownload:format(effective.downloadSettings),xhttpExtra:format(Object.fromEntries(Object.entries(effective).filter(([k])=>!['host','path','mode','extra','headers','xmux','downloadSettings'].includes(k))))};
}
export const parseXhttpObject=json;
const optionField={xhttpHeaders:'headers',xhttpXmux:'xmux',xhttpDownload:'downloadSettings'};
export function patchXhttp(c,fields,changed=xhttpFields){
 const next=structuredClone(c);if(changed.includes('xhttpMode'))next.mode=fields.xhttpMode || 'auto';
 let effective=next.extra ?? next;
 if(changed.includes('xhttpExtra')){
  const values=fields.xhttpExtra?.trim()?json(fields.xhttpExtra):{};
  if(Object.keys(values).some(k=>!options.includes(k) || ['host','path','mode','extra',...Object.values(optionField)].includes(k)))fail();
  for(const k of Object.keys(effective))if(!['host','path','mode','extra',...Object.values(optionField)].includes(k))delete effective[k];Object.assign(effective,values);
 }
 for(const [field,key] of Object.entries(optionField))if(changed.includes(field)){if(fields[field]?.trim())effective[key]=json(fields[field]);else delete effective[key];}
 return validateXhttp(next);
}
export function xhttpDownloadStream(stream){const c=stream.xhttpSettings || stream.splithttpSettings;return (c?.extra ?? c)?.downloadSettings;}
// Both upload and download must use the same managed outer gateway.
export function wrapXhttpStream(stream,tag){
 stream.sockopt={dialerProxy:tag};
 const download=xhttpDownloadStream(stream);
 if(download)wrapXhttpStream(download,tag);
}
