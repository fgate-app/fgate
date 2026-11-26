import test from 'node:test';
import assert from 'node:assert/strict';
import {diagnoseTlsVersions} from '../server/tls-versions.js';
import {exportDiagnosticReport} from '../shared/diagnostic-report.js';
const fixture=()=>({name:'example.com',endpoint:{port:1234,secret:'fixture-secret'},allocatePort:async()=>45000,resolve:async()=>({attempts:[{state:'ok',rcode:0,answers:[{type:'A',value:'93.184.215.14'}],pathObservation:{state:'verified'}}]}),observe:async()=>({finish:async()=>({state:'verified',connectionId:'private-flow'})}),request:async value=>({version:value.version,state:'ok',localPort:45000,negotiatedVersion:'TLSv'+value.version})});
test('strict TLS comparison pins the same verified peer, name and listener for both versions',async()=>{
 const calls=[],options=fixture();options.request=async(value,config)=>{calls.push({value,config});return {state:'ok',negotiatedVersion:'TLSv'+value.version};};
 const report=await diagnoseTlsVersions(options);assert.equal(report.outcome,'ok');assert.deepEqual(calls.map(row=>row.value.version),['1.2','1.3']);
 assert.ok(calls.every(row=>row.value.address==='93.184.215.14' && row.value.name==='example.com' && row.config.worker==='tls'));
 assert.doesNotMatch(JSON.stringify(exportDiagnosticReport({tlsVersions:report})),/private-flow|fixture-secret/);
});
test('TLS comparison rejects unverified DNS and unverified connections',async()=>{
 const options=fixture();options.resolve=async()=>({attempts:[{state:'ok',rcode:0,answers:[{type:'A',value:'93.184.215.14'}]}]});options.request=()=>assert.fail('must not connect');
 assert.equal((await diagnoseTlsVersions(options)).reason,'dns-address-unavailable');
 const unverified=fixture();unverified.observe=async()=>({finish:async()=>({state:'unavailable'})});assert.equal((await diagnoseTlsVersions(unverified)).outcome,'unavailable');
});
test('one TLS version failure remains a partial result; cancellation and configuration changes invalidate results',async()=>{
 const options=fixture();options.request=async value=>({state:value.version==='1.2'?'ok':'failed',reason:'tls-error'});assert.equal((await diagnoseTlsVersions(options)).outcome,'partial');
 let current=true;const changed=fixture();changed.isCurrent=()=>current;changed.request=async()=>{current=false;return {state:'ok'};};const report=await diagnoseTlsVersions(changed);assert.equal(report.reason,'configuration-changed');assert.ok(report.attempts.every(row=>row.state==='unavailable'));
 const cancelled=fixture(),controller=new AbortController();controller.abort();cancelled.signal=controller.signal;await assert.rejects(diagnoseTlsVersions(cancelled),{name:'AbortError'});
});

test('worker reports missing TLS support before opening a socket',async()=>{
 const {execFileSync}=await import('node:child_process');
 const result=JSON.parse(execFileSync('python3',['-c',`import importlib.util,types,json
s=importlib.util.spec_from_file_location('probe','server/tls-versions.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
m.ssl.TLSVersion=types.SimpleNamespace()
print(json.dumps(m.attempt({'name':'example.com','address':'93.184.215.14','version':'1.3','proxy':{}})))`],{encoding:'utf8'}));
 assert.equal(result.state,'unavailable');assert.equal(result.reason,'tls-version-unavailable');assert.equal(result.failedStage,'prepare');
});
