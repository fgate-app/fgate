import {spawn} from 'node:child_process';
import {PublicError} from './public-error.js';
export function resourceUrl(value){
 let url;try{if(typeof value!=='string' || value.length>8192)throw Error();url=new URL(value);}catch{throw new PublicError('Enter a valid HTTP(S) subscription URL.');}
 const host=url.hostname.replace(/^\[|\]$/g,'').toLowerCase();
 if(!['http:','https:'].includes(url.protocol) || url.username || url.password || url.hash || host==='localhost' || host.endsWith('.localhost') || /^(?:127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(host) || host==='::1' || host==='::' || host.includes(':') && /^(?:fc|fd|fe80:|::ffff:)/i.test(host))throw new PublicError('Enter a public HTTP(S) URL without credentials.');
 return url.href;
}
export function downloadGateways(store,supervisor){
 return store.profiles().filter(p=>p.enabled!==false && !['direct','zapret'].includes(p.engine)).flatMap(profile=>{
  const endpoint=supervisor?.locationEndpoint?.(profile);return endpoint && endpoint.transportState!=='unavailable'?[{id:profile.id,port:endpoint.port,secret:endpoint.secret}]:[];
 });
}
export function validDownloadGateways(rows){return Array.isArray(rows)?rows.slice(0,200).filter(p=>p && typeof p.id==='string' && Number.isInteger(p.port) && p.port>=28000 && p.port<=37999 && typeof p.secret==='string' && /^[a-zA-Z0-9_-]{16,256}$/.test(p.secret)).map(({id,port,secret})=>({id,port,secret})):[];}
function readCurlResponse(bytes,maxBytes){
 let offset=0;
 while(true){
  const end=bytes.indexOf('\r\n\r\n',offset);
  if(end<0 || end+4>65536)throw Error();
  const lines=bytes.subarray(offset,end).toString('latin1').split('\r\n');
  const match=/^HTTP\/\S+ ([1-5]\d{2})(?:\s|$)/.exec(lines.shift());
  if(!match)throw Error();
  const status=Number(match[1]);offset=end+4;
  // 100 Continue and 103 Early Hints precede the final HTTP response.
  if(status<200){if(status===101)throw Error();continue;}
  const headers=new Headers();
  for(const line of lines){const at=line.indexOf(':');if(at<=0)throw Error();headers.append(line.slice(0,at),line.slice(at+1).trim());}
  const body=bytes.subarray(offset);if(body.length>maxBytes)throw Error();
  return {status,headers,body};
 }
}
export function curlRequest(url,{gateway,signal,maxBytes,timeoutMs=25000,headers={}},spawnProcess=spawn){
 return new Promise((resolve,reject)=>{
  const child=spawnProcess('curl',['--disable','--config','-','--silent','--show-error','--suppress-connect-headers','--dump-header','-','--output','-','--proto','=http,https','--connect-timeout','5','--max-time',String(Math.min(120000,Math.max(1000,timeoutMs))/1000),'--max-filesize',String(maxBytes),'--noproxy',gateway?'':'*'],{stdio:['pipe','pipe','pipe']});
  const chunks=[];let size=0,done=false;
  function finish(error,value){if(done)return;done=true;signal?.removeEventListener('abort',abort);error?reject(error):resolve(value);}
  function abort(){child.kill('SIGKILL');finish(new PublicError('Download cancelled.'));}
  child.on('error',()=>finish(new PublicError('The download transport is unavailable.')));child.stderr.on('data',()=>{});
  child.stdout.on('data',chunk=>{size+=chunk.length;if(size>maxBytes+65536){child.kill('SIGKILL');finish(new PublicError('The downloaded file is too large.'));}else chunks.push(chunk);});
  child.once('close',code=>{
   if(code!==0)return finish(new PublicError('Could not download the resource.'));
   try{finish(null,readCurlResponse(Buffer.concat(chunks),maxBytes));}catch{finish(new PublicError('Invalid download response.'));}
  });
  signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted){abort();return;}
  const config=[`url = ${JSON.stringify(url)}`,`proxy = ${JSON.stringify(gateway?'http://127.0.0.1:'+gateway.port:'')}`,...(gateway?[`proxy-user = ${JSON.stringify('fg-geo:'+gateway.secret)}`]:[]),...Object.entries(headers).map(([key,value])=>`header = ${JSON.stringify(key+': '+value)}`)];
  child.stdin.on('error',()=>{});child.stdin.end(config.join('\n')+'\n');
 });
}
// Both module updates and subscriptions use this adapter. Complete bodies are
// bounded before returning, so a truncated download can retry on another path.
export function createResourceFetch({gateways=()=>[],request=curlRequest,maxBytes=128*1024*1024,allowDirect=true}={}){
 return async (input,options={})=>{
  const original=resourceUrl(String(input)),paths=[...(allowDirect?[null]:[]),...validDownloadGateways(await gateways())],limit=options.maxBytes ?? maxBytes;
  for(const gateway of paths){
   if(options.signal?.aborted)throw new PublicError('Download cancelled.');
   try{let url=original;
    for(let redirects=0;redirects<=5;redirects++){
     const response=await request(url,{gateway,signal:options.signal,maxBytes:limit,timeoutMs:options.timeoutMs,headers:{'User-Agent':'FreedomGate',...options.headers}});
     if([301,302,303,307,308].includes(response.status)){
      if(options.redirect==='error' || redirects===5)throw Error();const location=response.headers.get('location');if(!location)throw Error();const next=resourceUrl(new URL(location,url).href);if(url.startsWith('https:') && !next.startsWith('https:'))throw Error();url=next;continue;
     }
     if(response.status<200 || response.status>=300 || response.body.length>limit)throw Error();
     await options.validate?.(response.body,response.headers);
     const result=new Response(response.body,{status:response.status,headers:response.headers});Object.defineProperty(result,'downloadPath',{value:gateway?.id || 'direct'});return result;
    }
   }catch{if(options.signal?.aborted)throw new PublicError('Download cancelled.');}
  }
  throw new PublicError('The resource is unavailable directly and through the available gateways.');
 };
}
