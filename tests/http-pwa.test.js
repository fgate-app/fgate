import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {serveInterface} from '../server/http.js';

test('PWA assets have browser-compatible MIME types and revalidate workers and HTML',async()=>{
 const root=await mkdtemp(join(tmpdir(),'fg-pwa-http-'));
 const files={'index.html':'<html></html>','sw.js':'self.addEventListener("fetch",()=>{});','manifest.webmanifest':'{}','icon.png':Buffer.from([137,80,78,71]),'favicon.ico':Buffer.from([0,0,1,0])};
 for(const [name,data] of Object.entries(files))await writeFile(join(root,name),data);
 const server=http.createServer((req,res)=>serveInterface(req,res,new URL(req.url,'http://localhost'),root));
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
 try{
  for(const [path,type] of [['/manifest.webmanifest','application/manifest+json'],['/sw.js','text/javascript'],['/icon.png','image/png'],['/favicon.ico','image/x-icon'],['/settings/network','text/html']]){
   const response=await fetch(base+path);assert.equal(response.status,200);assert.ok(response.headers.get('content-type').startsWith(type));assert.equal(response.headers.get('x-content-type-options'),'nosniff');
   if(!['/icon.png','/favicon.ico'].includes(path))assert.equal(response.headers.get('cache-control'),'no-cache');
  }
 }finally{await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});}
});
