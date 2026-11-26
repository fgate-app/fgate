import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {xrayEventCollector,xrayConnectionFinding,diagnoseXrayConnection} from '../server/xray-diagnostics.js';
import {diagnosticSummary} from '../shared/diagnostic-summary.js';
import {exportDiagnosticReport} from '../shared/diagnostic-report.js';

test('Xray events distinguish connection and TLS/REALITY failures without retaining private text',()=>{
 for(const [line,reason] of [
  ['[Warning] proxy/vless/outbound: failed to dial tcp 192.0.2.1:443 > connect: connection refused','server-connect-failed'],
  ['[Warning] transport/internet/tls: failed > tls: failed to verify certificate: x509: certificate signed by unknown authority','secure-handshake-failed'],
  ['[Warning] REALITY: processed invalid connection: verification failed','secure-handshake-failed'],
  ['[Warning] provider private-secret UUID 1234 new unrecognized failure','insufficient-evidence'],
  ['Proxy started successfully','insufficient-evidence'],['','insufficient-evidence']]){
   const collector=xrayEventCollector();collector.push(line.slice(0,12));collector.push(line.slice(12)+'\n');
   const result=xrayConnectionFinding(collector.snapshot());assert.equal(result.reason,reason);
   const exported=JSON.stringify(exportDiagnosticReport({xrayConnection:result}));for(const secret of ['private-secret','192.0.2.1','UUID','1234','unknown authority'])assert.ok(!exported.includes(secret));
  }
 const collector=xrayEventCollector();collector.push('[Error] secret\n'.repeat(10000));collector.push('secret');assert.equal(collector.snapshot().truncated,true);assert.ok(JSON.stringify(collector.snapshot()).length<200);
 assert.equal(xrayConnectionFinding({events:[]},{responseVerified:true}).state,'ok');
 assert.equal(xrayConnectionFinding({events:[]},{responseVerified:true,configChanged:true}).state,'unavailable');
});

test('isolated Xray probe preserves wrapper, requires secure response and cleans up on failure/cancel',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'fg-xray-diag-test-'));let stopped=0,options,rows;
 const create=value=>{options=value;return {prepare:async input=>{rows=input;return {bridges:{diagnostic:{port:23456}},commit:async()=>{}};},stop:async()=>{stopped++;}};};
 const row={engine:'xray',profile_id:'private-id',config:'private-secret',wrapEndpoint:{port:34567,username:'private',password:'private'}};
 try{
  const success=await diagnoseXrayConnection({row,stateDir:dir,target:'https://example.com/',create,request:async(endpoint)=>{assert.equal(endpoint.type,'socks5');assert.equal(endpoint.port,23456);return {exitCode:0,time_appconnect:.2,response_code:200};}});
  assert.equal(success.reason,'secure-response');assert.deepEqual(rows[0].wrapEndpoint,row.wrapEndpoint);assert.equal(rows[0].profile_id,'diagnostic');assert.deepEqual(readdirSync(dir),[]);
  const failure=await diagnoseXrayConnection({row,stateDir:dir,target:'https://example.com/',create,request:async()=>{options.diagnosticLog('[Warning] dial tcp: connection refused\n');throw Error('secret');}});assert.equal(failure.reason,'server-connect-failed');
  const unverified=await diagnoseXrayConnection({row,stateDir:dir,target:'https://example.com/',create,request:async()=>({exitCode:0,response_code:200,time_appconnect:0})});assert.equal(unverified.state,'unavailable');
  await assert.rejects(diagnoseXrayConnection({row,stateDir:dir,create,signal:AbortSignal.abort()}),/cancelled/);assert.equal(stopped,4);assert.deepEqual(readdirSync(dir),[]);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('Xray findings explain the failed step and never infer success from missing errors',()=>{
 for(const reason of ['secure-response','server-connect-failed','secure-handshake-failed','insufficient-evidence']){
  const card=diagnosticSummary({xrayConnection:{reason,state:reason==='secure-response'?'ok':'unavailable'}}).find(card=>card.id==='xray-connection');assert.ok(card.message);if(reason.includes('failed'))assert.ok(card.next);
 }
});
