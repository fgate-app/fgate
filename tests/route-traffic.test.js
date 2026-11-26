import test from 'node:test';import assert from 'node:assert/strict';
import {createRouteTrafficCollector} from '../server/route-traffic.js';
import {buildMihomoConfig} from '../server/mihomo.js';import {defaultDnsSettings} from '../server/dns-resolvers.js';

test('route bytes use the matched rule, accumulate once, survive closed flows and never duplicate shared exits',async()=>{
 let flows=[{id:'a',rule:'DomainSuffix',rulePayload:'a.example',upload:10,download:100,metadata:{host:'private.example'}}];
 let rules=[{type:'DomainSuffix',payload:'a.example'},{type:'DomainSuffix',payload:'b.example'},{type:'SrcIPCIDR',payload:'10.20.0.5/32'}];
 const collector=createRouteTrafficCollector(async path=>path==='/rules'?{rules}:{connections:flows});
 collector.setOwners([{kind:'groups',id:'a'},{kind:'groups',id:'b'},{kind:'devices',id:'phone'}]);
 await collector.sample();let result=collector.snapshot();assert.deepEqual(result.groups.a,{upload:10,download:100});assert.equal(result.groups.b.download,0);
 flows[0].download=150;await collector.sample();assert.equal(collector.snapshot().groups.a.download,150);
 flows=[{id:'phone',rule:'SrcIPCIDR',rulePayload:'10.20.0.5/32',upload:30,download:400}];await collector.sample();result=collector.snapshot();assert.equal(result.groups.a.download,150);assert.equal(result.devices.phone.download,400);assert.equal(result.groups.b.download,0);
 assert.ok(!JSON.stringify(result).includes('private.example'));
 collector.setOwners([{kind:'groups',id:'a'},{kind:'groups',id:'b'},{kind:'devices',id:'phone'}]);await collector.sample();assert.equal(collector.snapshot().devices.phone.download,400);
});
test('duplicate rules retain first owner, and pause discards in-flight samples during configuration changes',async()=>{
 let release,hold=false;const request=async path=>{if(path==='/rules')return {rules:[{type:'DomainSuffix',payload:'example.com'},{type:'DomainSuffix',payload:'example.com'}]};if(hold)await new Promise(resolve=>release=resolve);return {connections:[{id:'x',rule:'DomainSuffix',rulePayload:'example.com',download:100,upload:0}]};};
 const collector=createRouteTrafficCollector(request);collector.setOwners([{kind:'groups',id:'first'},{kind:'groups',id:'second'}]);await collector.sample();assert.equal(collector.snapshot().groups.first.download,100);assert.equal(collector.snapshot().groups.second.download,0);
 hold=true;const pending=collector.sample();await new Promise(resolve=>setImmediate(resolve));collector.pause();release();await pending;assert.equal(collector.snapshot().available,false);assert.equal(collector.snapshot().groups.first.download,100);
});
test('generated route ownership follows saved domain order before device fallback order and rejects ungenerated destinations',()=>{
 let owners;
 buildMihomoConfig(defaultDnsSettings,{onRuleOwners:value=>owners=value},{profiles:[{id:'direct',engine:'direct'},{id:'missing',engine:'outline'}],configs:[],devices:[{id:'phone',identifier:'10.20.0.5',routeId:'direct'}],groups:[{id:'normal',entries:['normal.example'],routeId:'direct'},{id:'block',entries:['full:exact.example'],routeId:'block'},{id:'skip',entries:['skip.example'],routeId:'missing'}]});
 assert.deepEqual(owners,[{kind:'groups',id:'block'},{kind:'groups',id:'skip'},{kind:'groups',id:'normal'},{kind:'devices',id:'phone'},null]);
});

test('traffic survives rule removal/re-enable and a collector restart independently of configuration',async()=>{
 let stored,bytes=100,time=20000;
 const storage={load:()=>stored,save:value=>{stored=structuredClone(value);}};
 const request=async path=>path==='/rules'?{rules:[{type:'DomainSuffix',payload:'a.example'}]}:{connections:[{id:'flow',rule:'DomainSuffix',rulePayload:'a.example',download:bytes,upload:10}]};
 const owner={kind:'groups',id:'a'};
 const collector=createRouteTrafficCollector(request,{storage,now:()=>time});collector.setOwners([owner]);await collector.sample();
 collector.setOwners([]);collector.setOwners([owner]);bytes=150;await collector.sample();assert.equal(collector.snapshot().groups.a.download,150);
 collector.flush();const restored=createRouteTrafficCollector(async path=>path==='/rules'?{rules:[{type:'DomainSuffix',payload:'a.example'}]}:{connections:[]},{storage,now:()=>++time});
 restored.setOwners([owner]);await restored.sample();assert.equal(restored.snapshot().groups.a.download,150);assert.equal(restored.snapshot().startedAt,collector.snapshot().startedAt);
});
