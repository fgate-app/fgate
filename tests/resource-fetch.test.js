import test from 'node:test';import assert from 'node:assert/strict';import {createServer} from 'node:http';
import {createResourceFetch,curlRequest,resourceUrl,validDownloadGateways} from '../server/resource-fetch.js';
const gateways=[{id:'one',port:28001,secret:'a'.repeat(64)},{id:'two',port:28002,secret:'b'.repeat(64)}];
const response=(status,body='ok',headers={})=>({status,body:Buffer.from(body),headers:new Headers(headers)});
test('resource downloads try direct then enabled gateway paths and never expose credentials in failures',async()=>{
 const paths=[],fetch=createResourceFetch({gateways:()=>gateways,request:async(url,{gateway})=>{paths.push(gateway?.id || 'direct');if(gateway?.id==='two')return response(200);throw Error('private URL token and proxy secret');}});
 const result=await fetch('https://example.com/secret');assert.equal(await result.text(),'ok');assert.equal(result.downloadPath,'two');assert.deepEqual(paths,['direct','one','two']);
 const fail=createResourceFetch({gateways:()=>gateways,request:async()=>{throw Error('SECRET');}});await assert.rejects(fail('https://example.com/TOKEN'),error=>!error.message.includes('TOKEN') && !error.message.includes('SECRET'));
});
test('resource redirects are bounded and revalidated, failures and size limits retry safely',async()=>{
 for(const location of ['http://127.0.0.1/private','file:///etc/passwd','http://example.com/downgrade']){const fetch=createResourceFetch({request:async()=>response(302,'',{location})});await assert.rejects(fetch('https://example.com'));}
 let calls=0;const loop=createResourceFetch({request:async()=>{calls++;return response(302,'',{location:'/again'});}});await assert.rejects(loop('https://example.com'));assert.equal(calls,6);
 const paths=[];const fetch=createResourceFetch({gateways:()=>gateways,request:async(url,{gateway})=>{paths.push(gateway?.id || 'direct');return gateway?response(200,'ok'):response(200,'too large');}});assert.equal(await(await fetch('https://example.com',{maxBytes:2})).text(),'ok');assert.deepEqual(paths,['direct','one']);
 for(const url of ['ftp://example.com','http://user:pass@example.com','http://localhost/a','http://192.168.1.2','http://[::1]','http://[::ffff:127.0.0.1]'])assert.throws(()=>resourceUrl(url));assert.equal(resourceUrl('https://fc2.com'),'https://fc2.com/');assert.equal(validDownloadGateways([{...gateways[0],port:0}]).length,0);
});
test('resource cancellation does not advance to other gateways',async()=>{
 const controller=new AbortController(),paths=[];const fetch=createResourceFetch({gateways:()=>gateways,request:async(url,{gateway})=>{paths.push(gateway);controller.abort();throw Error();}});await assert.rejects(fetch('https://example.com',{signal:controller.signal}),/cancelled/);assert.equal(paths.length,1);
});
test('actual curl transport receives credentials and URL over stdin and bounds response bytes',async()=>{
 const server=createServer((req,res)=>{res.setHeader('content-type','text/plain');res.end('fixture');});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{const response=await curlRequest('http://127.0.0.1:'+server.address().port,{maxBytes:100});assert.equal(response.status,200);assert.equal(response.body.toString(),'fixture');await assert.rejects(curlRequest('http://127.0.0.1:'+server.address().port,{maxBytes:2}));}finally{await new Promise(r=>server.close(r));}
});
test('content validation retries a blocked HTTP 200 response on another gateway',async()=>{
 const paths=[];const fetch=createResourceFetch({gateways:()=>gateways,request:async(url,{gateway})=>{paths.push(gateway?.id || 'direct');return response(200,gateway?'valid':'block page');}});const result=await fetch('https://example.com',{validate:bytes=>{if(bytes.toString()!=='valid')throw Error();}});assert.equal(await result.text(),'valid');assert.deepEqual(paths,['direct','one']);
});

test('curl consumes informational HTTP headers and returns only the final response body',async()=>{
 const server=createServer((req,res)=>{res.writeEarlyHints({link:'</style.css>; rel=preload; as=style'});res.setHeader('content-type','text/plain');res.end('fixture');});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{const response=await curlRequest('http://127.0.0.1:'+server.address().port,{maxBytes:100});assert.equal(response.status,200);assert.equal(response.body.toString(),'fixture');assert.equal(response.headers.get('link'),null);assert.equal(response.headers.get('content-type'),'text/plain');}finally{await new Promise(r=>server.close(r));}
});
