import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DiagnosticBlocklist,parseDiagnosticBlocklist} from '../server/diagnostic-blocklist.js';
import {diagnoseDomains} from '../server/domain-diagnostics.js';
import {diagnosticGroups,diagnosticOverview} from '../shared/diagnostic-summary.js';
import {exportDiagnosticReport} from '../shared/diagnostic-report.js';
import {Store} from '../server/store.js';
import {createServer} from '../server/index.js';

test('diagnostic list normalizes IDN and case; invalid or excessive data never becomes a list',()=>{
 assert.deepEqual(parseDiagnosticBlocklist('example.com\n203.0.113.1\n'),['example.com']);
 assert.deepEqual(parseDiagnosticBlocklist('# comment\nEXAMPLE.COM.\nпример.рф\nexample.com\n'),['example.com','xn--e1afmkfd.xn--p1ai']);
 for(const value of ['', '<html>Error</html>', '127.0.0.1','https://example.com/a','com','example.com\ninvalid','x'.repeat(16*1024*1024+1)])assert.throws(()=>parseDiagnosticBlocklist(value));
});

test('bounded pinned updates preserve last good data; lookup distinguishes exact, parent and missing entries',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'fg-blocklist-'));let text='example.com\nпример.рф\n',url;
 const list=new DiagnosticBlocklist({directory,fetchImpl:async value=>{url=value;return new Response(text);}}),ref='a'.repeat(40);
 try{
  assert.equal(list.snapshot()('example.com').state,'unavailable');
  await assert.rejects(list.update('main'));await list.update(ref);
  assert.ok(url.includes('/'+ref+'/domains_all.lst'));assert.equal(list.status().count,2);
  const snapshot=list.snapshot();assert.equal(snapshot('EXAMPLE.COM.').match,'exact');assert.equal(snapshot('www.example.com').match,'parent-domain');
  assert.equal(snapshot('notexample.com').state,'not-listed');assert.equal(snapshot('example.com.evil.test').state,'not-listed');assert.equal(snapshot('пример.рф').state,'listed');
  const before=readFileSync(join(directory,'current.json'),'utf8');text='<html>upstream error</html>';
  await assert.rejects(list.update('b'.repeat(40)));assert.equal(readFileSync(join(directory,'current.json'),'utf8'),before);assert.equal(list.status().ref,ref);
  text='second.example\n';await list.update('b'.repeat(40));assert.equal(readFileSync(join(directory,'previous.json'),'utf8'),before);
  assert.equal(snapshot('example.com').state,'listed');assert.equal(list.snapshot()('example.com').state,'not-listed');
  const reopened=new DiagnosticBlocklist({directory});assert.equal(reopened.snapshot()('second.example').state,'listed');
  writeFileSync(join(directory,'current.json'),'{}');assert.equal(reopened.snapshot()('second.example').state,'unavailable');
 }finally{rmSync(directory,{recursive:true,force:true});}
});

test('list membership is per-domain reference evidence and cannot change gateway success or skipped-domain reports',async()=>{
 let lookups=0;
 const services={prepare:async()=>{},identity:()=>({}),endpoint:async()=>({state:'failed',complete:true,addresses:[]}),endpointDetailed:async()=>({state:'failed',complete:true,addresses:[]}),
  blocklist:domain=>{lookups++;return {state:domain==='listed.example'?'listed':'not-listed',source:'Re:filter',ref:'a'.repeat(40),updatedAt:'2026-11-19T00:00:00Z',matchedDomain:domain==='listed.example'?domain:null};},
  gateway:async({targets})=>({attempts:targets.map(url=>({url,outcome:'ok',pathObservation:{state:'verified'}}))})};
 const report=await diagnoseDomains({domains:['listed.example','clear.example'],checks:{},services});
 assert.equal(lookups,2);assert.equal(report.outcome,'ok');assert.equal(diagnosticOverview(report).state,'ok');
 const groups=diagnosticGroups(report);for(const domain of ['listed.example','clear.example'])assert.ok(groups.find(group=>group.id===domain).cards.some(card=>card.id==='blocklist:'+domain));
 assert.equal(exportDiagnosticReport(report).targetReports[0].blocklist.state,'listed');
 assert.equal(report.progress.steps.filter(step=>step.kind==='blocklist' && step.state==='finished').length,2);
 const failed=await diagnoseDomains({domains:['untouched.example'],profile:{engine:'xray'},checks:{endpoint:true},services});
 assert.equal(lookups,2);assert.equal(failed.targetReports,undefined);assert.doesNotMatch(JSON.stringify(failed),/untouched.example/);
 const unavailable=await diagnoseDomains({domains:['clear.example'],checks:{},services:{...services,blocklist:()=>({state:'unavailable'})}});
 assert.equal(diagnosticOverview(unavailable).state,'ok');assert.equal(unavailable.targetReports[0].blocklist.state,'unavailable');
});

test('diagnostic list uses module check/update API and keeps its data separate from routes',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'fg-blocklist-api-')),store=new Store(':memory:'),ref='a'.repeat(40);let helperCalls=0;
 const list=new DiagnosticBlocklist({directory,fetchImpl:async()=>new Response('example.com\n')});
 const server=createServer(store,{diagnosticBlocklist:list,diagnosticListFetch:async()=>new Response(JSON.stringify({sha:ref})),modulesHelper:async()=>{helperCalls++;return {ok:true,modules:[]};}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port+'/api/';
 try{
  const setup=await fetch(base+'auth/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:'test password 12345'})}),auth=await setup.json();
  const headers={'Content-Type':'application/json',Cookie:setup.headers.get('set-cookie').split(';')[0],'X-CSRF-Token':auth.csrf};
  const post=body=>fetch(base+'modules',{method:'POST',headers,body:JSON.stringify({...body,id:'diagnostic-blocklist'})});
  assert.equal((await post({op:'update',version:ref})).status,409);
  assert.equal((await post({op:'check'})).status,202);
  const row=async()=>(await (await fetch(base+'modules',{headers})).json()).modules.find(row=>row.id==='diagnostic-blocklist');
  for(let i=0;i<20 && (await row()).state==='checking';i++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal((await row()).candidate.version,ref);const before=helperCalls;
  assert.equal((await post({op:'update',version:ref})).status,202);assert.equal(helperCalls,before);
  for(let i=0;i<20 && (await row()).state==='downloading';i++)await new Promise(resolve=>setTimeout(resolve,10));
  const current=await row();assert.equal(current.state,'updated');assert.equal(current.loaded,true);assert.equal(current.count,1);assert.equal(current.current,ref.slice(0,7));
  assert.deepEqual(store.routeGroups(),[]);assert.equal(list.snapshot()('example.com').state,'listed');
 }finally{await new Promise(resolve=>server.close(resolve));await server.cleanup;store.close();rmSync(directory,{recursive:true,force:true});}
});
