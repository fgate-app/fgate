import test from 'node:test';
import assert from 'node:assert/strict';
import {mtuArguments,parseMtuProbe,probePathMtu} from '../server/path-mtu.js';
test('MTU probe distinguishes replies, local limits, ICMP limits and silence',()=>{
 assert.equal(parseMtuProbe('64 bytes from 93.184.215.14: icmp_seq=1',1280).state,'ok');
 assert.deepEqual(parseMtuProbe('ping: local error: message too long, mtu=1280',1500,2),{packetBytes:1500,state:'limited',reason:'local-size-limit',mtu:1280});
 assert.equal(parseMtuProbe('From 10.0.0.1 Frag needed and DF set (mtu = 1400)',1500,1).mtu,1400);
 assert.equal(parseMtuProbe('From fd42::1 Packet too big: mtu=1280',1500,1).reason,'icmp-size-limit');
 assert.equal(parseMtuProbe('100% packet loss',1500,1).reason,'icmp-no-response');
 assert.ok(mtuArguments('2001:db8::2','eth0',1280).includes('1232'));assert.throws(()=>mtuArguments('example.com','eth0',1280));
});
test('MTU probe uses one marked uplink and never interprets silent packets as a limit',async()=>{
 const calls=[],run=async(command,args)=>{calls.push({command,args});if(command==='ip')return {stdout:JSON.stringify([{dev:'eth0',gateway:'10.0.0.1'}])};if(args.includes('548'))return {stdout:'64 bytes from 93.184.215.14:',stderr:''};throw Object.assign(Error(),{code:1,stdout:'100% packet loss'});};
 const report=await probePathMtu({address:'93.184.215.14',interfaceName:'eth0',run});assert.equal(report.lowerBound,576);assert.equal(report.reportedMtu,null);assert.equal(report.outcome,'ok');assert.equal(report.attempts.length,4);assert.ok(calls.filter(row=>row.command==='ping').every(row=>row.args.includes('1073741824') && row.args.includes('do')));
});
test('MTU probes invalidate a changed route and respect caller cancellation',async()=>{
 let routes=0;const run=async(command,args)=>command==='ip' && args.includes('link')?{stdout:'[]'}:command==='ip'?{stdout:JSON.stringify([{dev:'eth0',gateway:++routes===1?'10.0.0.1':'10.0.0.2'}])}:{stdout:'64 bytes from 93.184.215.14:',stderr:''};
 const report=await probePathMtu({address:'93.184.215.14',interfaceName:'eth0',run});assert.equal(report.reason,'route-changed');assert.ok(report.attempts.every(row=>row.state==='unavailable'));
 const controller=new AbortController();controller.abort();await assert.rejects(probePathMtu({address:'93.184.215.14',interfaceName:'eth0',signal:controller.signal,run}),{name:'AbortError'});
});
