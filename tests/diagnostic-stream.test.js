import test from 'node:test';
import assert from 'node:assert/strict';
import {createApiClient} from '../web/src/lib/api.js';
import {Store} from '../server/store.js';
import {createServer} from '../server/index.js';
import {exportDiagnosticReport} from '../shared/diagnostic-report.js';

const encoded=value=>new TextEncoder().encode(value);
test('diagnostic client decodes split UTF-8 lines, emits partial progress and requires a final result',async()=>{
 const text=JSON.stringify({type:'progress',report:{label:'Проверка'},progress:{state:'running'}})+'\n'+JSON.stringify({type:'result',report:{ok:true}})+'\n';
 const bytes=encoded(text),events=[];let options;
 const api=createApiClient({getSession:()=>({csrf:'current'}),fetch:async(_,o)=>{options=o;return new Response(new ReadableStream({start(controller){for(const byte of bytes)controller.enqueue(new Uint8Array([byte]));controller.close();}}),{headers:{'Content-Type':'application/x-ndjson'}});}});
 assert.deepEqual(await api('diagnostics',{method:'POST',onDiagnosticEvent:event=>events.push(event)}),{ok:true});
 assert.equal(events[0].report.label,'Проверка');assert.equal(options.headers.get('Accept'),'application/x-ndjson');assert.equal(options.headers.get('X-CSRF-Token'),'current');assert.equal('onDiagnosticEvent' in options,false);
 for(const body of ['{"type":"progress"}\n','{"type":"error","error":"Diagnostic failed."}\n','bad json\n']){
  const client=createApiClient({getSession:()=>null,fetch:async()=>new Response(body,{headers:{'Content-Type':'application/x-ndjson'}})});
  await assert.rejects(client('diagnostics',{onDiagnosticEvent:()=>{}}));
 }
});

test('live progress arrives before completion, local snapshots stay local and cancellation releases the slot',async()=>{
 const store=new Store(':memory:');let release,entered,aborted=false;
 const enteredDns=new Promise(resolve=>entered=resolve);
 const server=createServer(store,{supervisor:{gatewayLocations:{get:()=>({status:'ok',ip:'93.184.215.14',country:'Example country',provider:'Example ISP',asn:'AS123',source:'fixture',checkedAt:'2026-11-18T10:00:00Z'})},diagnoseGateway:async id=>({path:{chain:[{id,engine:'direct'}]},attempts:[{url:'https://example.com',outcome:'ok',pathObservation:{state:'verified'},stages:[{id:'proxy-connect',state:'ok'}]}]}),diagnoseGatewayDns:async(id,{signal})=>{entered();return new Promise((resolve,reject)=>{release=()=>resolve({attempts:[]});signal.addEventListener('abort',()=>{aborted=true;reject(Error('cancelled'));},{once:true});});}}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}/api/`;
 try{
  const setup=await fetch(base+'auth/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:'fixture password 12345'})});const {csrf}=await setup.json(),cookie=setup.headers.get('set-cookie').split(';')[0];
  const profile=store.profiles().find(row=>row.engine==='direct');const events=[];const controller=new AbortController();
  const api=createApiClient({getSession:()=>({csrf}),fetch:(path,o)=>fetch(base+path.slice(5),{...o,headers:{...Object.fromEntries(o.headers),Cookie:cookie}})});
  const pending=api(`profiles/${profile.id}/diagnostics`,{method:'POST',signal:controller.signal,body:JSON.stringify({dns:true,dnsName:'example.com',dnsProviders:['cloudflare']}),onDiagnosticEvent:event=>events.push(event)});
  // Attach the rejection before triggering abort to avoid unhandled rejections.
  const rejected=assert.rejects(pending,/abort/i);
  await enteredDns;
  for(let i=0;i<100 && !events.some(row=>row.progress?.steps.some(step=>step.id==='dns-gateway' && step.state==='running'));i++)await new Promise(resolve=>setTimeout(resolve,5));
  const partial=events.find(row=>row.report)?.report;assert.ok(partial);assert.equal(partial.progress.state,'running');assert.equal(partial.gatewayKind,'direct');assert.equal(partial.attempts[0].stages.length,0);assert.equal(partial.egressIdentity.provider,'Example ISP');assert.equal(partial.egressIdentity.observation,'cached-gateway-location');
  assert.equal(events.some(row=>row.type==='result'),false);
  const exported=exportDiagnosticReport(partial);assert.equal(exported.egressIdentity.ip,'93.184.215.14');assert.notEqual(exported.path.chain[0].id,profile.id);
  controller.abort();await rejected;
  for(let i=0;i<100 && !aborted;i++)await new Promise(resolve=>setTimeout(resolve,5));assert.equal(aborted,true);
  let response;for(let i=0;i<100;i++){response=await fetch(base+`profiles/${profile.id}/diagnostics`,{method:'POST',headers:{Cookie:cookie,'X-CSRF-Token':csrf,'Content-Type':'application/json'},body:'{}'});if(response.status!==409)break;await new Promise(resolve=>setTimeout(resolve,5));}
  assert.equal(response.status,200);const final=await response.json();assert.equal(final.progress.state,'completed');assert.ok(final.progress.steps.every(step=>step.state==='finished'));assert.equal(final.egressIdentity.country,'Example country');
 }finally{release?.();await new Promise(resolve=>server.close(resolve));store.close();}
});
