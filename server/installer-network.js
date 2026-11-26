import {createServer} from 'node:http';
import {randomBytes} from 'node:crypto';
import {createResourceFetch,resourceUrl} from './resource-fetch.js';
// Private, short-lived adapter for build tools. Original lockfile integrity and
// Go checksum-database verification remain enabled; no credentials leave the job.
export async function startInstallerNetwork({gateways=[],fetchImpl=createResourceFetch({gateways:()=>gateways})}={}){
 const token=randomBytes(24).toString('hex'),prefix='/'+token+'/',shutdown=new AbortController();
 const server=createServer(async(req,res)=>{
  res.on('error',()=>{});
  try{
   if(req.method!=='GET'||!req.url.startsWith(prefix)){res.writeHead(404).end();return;}
   const path=req.url.slice(prefix.length);let url;
   if(path.startsWith('go/'))url='https://proxy.golang.org/'+path.slice(3);
   else if(path.startsWith('sumdb/'))url='https://sum.golang.org/'+path.slice(6);
   else if(path.startsWith('resource/'))url=Buffer.from(path.slice(9),'base64url').toString();
   else{res.writeHead(404).end();return;}
   url=resourceUrl(url);
   const response=await fetchImpl(url,{timeoutMs:30000,signal:AbortSignal.any([shutdown.signal,AbortSignal.timeout(300000)])});
   const bytes=Buffer.from(await response.arrayBuffer());res.writeHead(200,{'Content-Length':bytes.length,'Content-Type':response.headers.get('content-type')||'application/octet-stream'});res.end(bytes);
  }catch{if(!res.headersSent&&!res.destroyed)res.writeHead(502).end('Could not download the build resource.');else res.destroy();}
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 const base='http://127.0.0.1:'+server.address().port+prefix;
 return {environment:{FREEDOMGATE_BUILD_PROXY:base,GOPROXY:base+'go',GOSUMDB:'sum.golang.org '+base+'sumdb'},close:()=>new Promise(resolve=>{shutdown.abort();server.close(resolve);server.closeAllConnections();})};
}
