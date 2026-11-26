import test from 'node:test';
import assert from 'node:assert/strict';
import {diagnosticVersion,diagnosticEnvironment,diagnosticMetadata} from '../server/diagnostic-metadata.js';
import {exportDiagnosticReport} from '../shared/diagnostic-report.js';

test('diagnostic versions come from bounded actual runtime output; unknown versions never use pinned defaults',async()=>{
 const outputs={mihomo:'Mihomo Meta v1.19.33 linux arm64',xray:'Xray 26.10.31 (Xray, Penetrates Everything.)',curl:'curl 8.14.1 (aarch64)',python:'Python 3.13.5',outline:'{"bridge":"0.2.0","sdk":"v0.1.0"}'};
 for(const [id,text] of Object.entries(outputs)){
  const result=await diagnosticVersion(id,'private-path',{execute:async(binary,args,options)=>{assert.equal(binary,'private-path');assert.ok(args.length===1);assert.equal(options.timeout,1500);assert.equal(options.maxBuffer,8192);return {stdout:text};}});
  assert.equal(result.state,'ok',id);assert.equal(result.source,'runtime-version');assert.doesNotMatch(JSON.stringify(result),/private-path/);
 }
 for(const execute of [async()=>({stdout:'private-credential /var/lib/secrets'}),async()=>{throw Error('private-credential');}])assert.deepEqual(await diagnosticVersion('mihomo','private-path',{execute}),{state:'unavailable',version:null});
 assert.deepEqual(await diagnosticVersion('invented','private-path'),{state:'unavailable',version:null});
});

test('metadata records only selected engines and tools; manifest versions are identified and no paths or raw errors escape',async()=>{
 const calls=[];
 const environment=await diagnosticEnvironment({engines:[{id:'xray',binary:'/private/binary'}],python:true,zapret:true,moduleRoot:'/private/modules',execute:async(binary)=>{calls.push(binary);return {stdout:binary==='curl'?'curl 8.14.1':binary==='python3'?'Python 3.13.5':'Xray 26.10.31'};},read:(path)=>JSON.stringify(String(path).endsWith('package.json')?{version:'0.1.0'}:{version:'v0.9.1'})});
 assert.deepEqual(calls.sort(),['/private/binary','curl','python3']);assert.equal(environment.engines.find(row=>row.id==='mihomo').state,'unavailable');assert.equal(environment.engines.find(row=>row.id==='zapret').source,'installed-manifest');assert.equal(environment.app.version,'0.1.0');assert.equal(environment.tools.python.version,'3.13.5');assert.doesNotMatch(JSON.stringify(environment),/private/);
 const unknown=await diagnosticEnvironment({execute:async()=>{throw Error('private-error');},read:()=>{throw Error('private-error');}});assert.equal(unknown.app.state,'unavailable');assert.equal(unknown.tools.curl.state,'unavailable');assert.equal('python' in unknown.tools,false);
});

test('every new report and its JSON export preserve full run times, normalized options and actual per-section limits',()=>{
 const report={limits:{attempts:3,attemptSeconds:8},localDns:{limits:{budgetSeconds:35}},localSni:{state:'unavailable'},transfer:{limits:{attemptSeconds:12,budgetSeconds:26,expectedBodyBytes:1114112}}};
 const checks={https:true,uplink:false,endpoint:false,dns:true,sni:true,transfer:true},parameters={dns:{name:'example.com',providers:['quad9','google']},sni:{name:'example.com'}};
 const value=diagnosticMetadata(report,{environment:{engines:[{id:'mihomo',state:'unavailable',version:null}]},startedAt:'2026-11-18T10:00:00.000Z',finishedAt:'2026-11-18T10:01:00.000Z',checks,parameters});
 const exported=exportDiagnosticReport(value);assert.equal(exported.schemaVersion,2);assert.equal(exported.startedAt,'2026-11-18T10:00:00.000Z');assert.equal(exported.finishedAt,'2026-11-18T10:01:00.000Z');assert.deepEqual(exported.measurement.checks,checks);assert.deepEqual(exported.measurement.parameters,parameters);assert.equal(exported.measurement.limits.localDns.limits.budgetSeconds,35);assert.equal(exported.measurement.limits.transfer.limits.expectedBodyBytes,1114112);assert.deepEqual(exported.measurement.limits.localSni,{state:'unavailable',limits:null,attemptLimits:[]});assert.equal(exported.measurement.limits.https.limits.attemptSeconds,8);
 report.transfer.limits.attemptSeconds=5;assert.equal(diagnosticMetadata(report,{}).measurement.limits.transfer.limits.attemptSeconds,5);
});
