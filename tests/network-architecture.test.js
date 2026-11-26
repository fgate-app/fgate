import test from 'node:test';
import assert from 'node:assert/strict';
import {createRouteTrafficCollector} from '../server/route-traffic.js';
import {collectNetworkArchitecture} from '../server/network-architecture.js';
import {buildNetworkArchitecture} from '../web/src/lib/network-architecture.js';
const snapshot=()=>({network:{interfaces:[{name:'eth0',carrier:true,type:'ethernet',addresses:['192.0.2.2/24']}],setup:{uplink:{interface:'eth0'}}},profiles:[{id:'direct-id',name:'Direct real',engine:'direct',protocol:'direct',enabled:true},{id:'vless-id',name:'Actual gateway',engine:'xray',protocol:'vless',enabled:true},{id:'off-id',name:'Disabled',engine:'mihomo',enabled:false}],modules:[{id:'mihomo',name:'mihomo',state:'running'},{id:'xray',name:'Xray',state:'running'}],connectionGroups:[{id:'g',name:'Automatic',members:['vless-id','off-id']}],rules:{groups:[{id:'rule-id',name:'Actual rule',routeId:'g',entriesCount:2}],devices:[{id:'device-rule',name:'Laptop route',identifier:'192.0.2.10',routeId:'direct-id'}]},clients:[{hostname:'Actual laptop',ip:'192.0.2.10',mac:'aa:bb:cc:dd:ee:ff',online:true},{hostname:'Other',ip:'192.0.2.11',mac:'bb:bb:cc:dd:ee:ff',online:null}],telemetry:{available:true,profiles:{'direct-id':{httpStatus:'ok',available:true,download:100,upload:10},'vless-id':{httpStatus:'error',available:true,download:null,upload:null,location:{country:'The Netherlands'}}},groups:{g:{selectedId:'vless-id'}}},observations:{available:true,paths:[{routeKind:'groups',routeId:'rule-id',sourceIP:'192.0.2.10',chains:['cg-g','p-vless-id-grp'],downloadRate:20,uploadRate:5}]}});
test('live graph uses actual identities, groups, countries and exact observed client/rule attribution',()=>{
 const graph=buildNetworkArchitecture(snapshot());
 assert.ok(graph.nodes.some(n=>n.name==='Actual gateway'));
 assert.equal(graph.nodes.find(n=>n.id==='gateway:vless-id').country,'NL');
 assert.equal(graph.nodes.find(n=>n.id==='gateway:off-id').state,'disabled');
 assert.equal(graph.nodes.find(n=>n.id==='gateway:vless-id').state,'error');
 assert.equal(graph.nodes.find(n=>n.id==='rule:groups:rule-id').state,'blocked');
 const ruleEdges=graph.edges.filter(e=>e.source==='rule:groups:rule-id');
 assert.equal(ruleEdges.length,1);assert.match(ruleEdges[0].target,/aa:bb:cc:dd:ee:ff/);assert.equal(ruleEdges[0].downloadRate,20);
 assert.ok(graph.edges.some(e=>e.source==='gateway:vless-id'&&e.target==='group:g'));
 assert.ok(!graph.nodes.some(n=>['Berlin','MacBook Pro'].includes(n.name)));
});
test('missing/stale telemetry and old settings do not invent health, traffic, or rule/client links',()=>{
 const data=snapshot();data.observations={available:false,paths:data.observations.paths};data.telemetry={available:false};
 const graph=buildNetworkArchitecture(data);
 assert.equal(graph.nodes.find(n=>n.id==='gateway:vless-id').state,'unknown');
 assert.ok(!graph.edges.some(e=>e.source==='rule:groups:rule-id'&&e.target.startsWith('client:')));
 assert.ok(graph.edges.every(e=>e.downloadRate===null));
 const stale=buildNetworkArchitecture(snapshot(),{unavailable:true});assert.ok(stale.edges.every(e=>e.downloadRate===null));assert.equal(stale.nodes.find(n=>n.id==='gateway:vless-id').state,'unknown');
 assert.deepEqual(buildNetworkArchitecture(null,{loading:true}).nodes,[]);assert.equal(buildNetworkArchitecture({}).nodes.length,0);
});
test('configured device routes connect only the matching identity, and graph grows with real row count',()=>{
 const data=snapshot();data.clients.push(...Array.from({length:12},(_,i)=>({ip:'198.51.100.'+i,hostname:'Device '+i,online:true})));
 const graph=buildNetworkArchitecture(data);
 const deviceEdges=graph.edges.filter(e=>e.source==='rule:devices:device-rule');assert.equal(deviceEdges.length,1);
 assert.ok(graph.height>1800);assert.equal(graph.nodes.filter(n=>n.kind==='device').length,13);
});
test('route observations aggregate exact owners and rates, discard targets/credentials and disappear on outage',async()=>{
 let time=10000,fail=false,bytes=100;
 const collector=createRouteTrafficCollector(async path=>{if(fail)throw Error('offline');return path==='/rules'?{rules:[{type:'DomainSuffix',payload:'private.example'}]}:{connections:[{id:'flow',rule:'DomainSuffix',rulePayload:'private.example',download:bytes,upload:10,chains:['p-vless-id-grp','password=secret'],metadata:{sourceIP:'192.0.2.10',host:'private-target.example',inboundUser:'private-user',inboundName:'fg-remote'}}]};},{now:()=>time});
 collector.setOwners([{kind:'groups',id:'rule-id'}]);await collector.sample();assert.equal(collector.observations().paths[0].downloadRate,null);
 time+=5000;bytes=200;await collector.sample();const observed=collector.observations();assert.equal(observed.paths[0].routeId,'rule-id');assert.equal(observed.paths[0].downloadRate,20);assert.ok(!JSON.stringify(observed).includes('private-target'));assert.ok(!JSON.stringify(observed).includes('password=secret'));assert.ok(!JSON.stringify(collector.snapshot()).includes('private-user'),'internal identities absent from existing public route counters');
 fail=true;await collector.sample();assert.deepEqual(collector.observations().paths,[]);
});
test('snapshot is read-only, projects no configs/passwords, resolves remote clients, isolates partial failures',async()=>{
 const store={networkSettings:()=>({uplink:{interface:'eth0'},client:{interface:'wlan0',password:'wifi-secret'}}),profiles:()=>[{id:'p',name:'Real',engine:'xray',password:'proxy-secret',config:'raw-config'}],connectionGroups:()=>[],routeGroups:()=>[{id:'r',routeId:'p',entries:['private-domain.example']}],deviceRoutes:()=>[{id:'device-rule',name:'Device rule',identifier:'192.0.2.10',routeId:'p',enabled:false}]};
 const dependencies={store,interfaces:()=>[{name:'eth0',carrier:true}],supervisor:{status:()=>({state:'running'}),telemetry:async()=>({available:true,profiles:{p:{httpStatus:'ok',location:{country:'Russia',ip:'private-exit'},secret:'controller-secret'}}}),architecturePaths:()=>({available:true,paths:[{sourceIP:'127.0.0.1',inboundName:'fg-remote',inboundUser:'private-user',routeId:'r',routeKind:'groups'}]})},networkTraffic:async()=>({interfaces:{}}),clients:async()=>[],remoteClients:async()=>[{id:'key-id',accessPointId:'point-id',hostname:'Remote',remote:true}],zapret:async()=>{throw Error('helper-secret');},versions:{},describePaths:rows=>rows.map(row=>({...row,accessClientId:'key-id',accessPointId:'point-id'}))};
 const data=await collectNetworkArchitecture(dependencies),json=JSON.stringify(data);
 for(const secret of ['wifi-secret','proxy-secret','raw-config','private-domain','private-exit','controller-secret','private-user','helper-secret'])assert.ok(!json.includes(secret),secret);
 assert.equal(data.sources.zapret,false);assert.equal(data.observations.paths[0].accessClientId,'key-id');
 assert.equal(data.rules.devices[0].enabled,false);assert.equal(data.rules.groups[0].entriesCount,1);assert.equal(data.profiles[0].name,'Real');
});
test('architecture API requires authentication and returns live projected configuration',async()=>{
 const {Store}=await import('../server/store.js'),{createServer}=await import('../server/index.js');
 const store=new Store(':memory:');const supervisor={status:()=>({state:'running'}),telemetry:async()=>({available:false}),architecturePaths:()=>({available:false,paths:[]})};
 const server=createServer(store,{supervisor,interfaces:()=>[{name:'actual0',type:'ethernet',carrier:true}],networkTraffic:async()=>({interfaces:{actual0:{receiveRate:12,transmitRate:4}}})});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
 try{assert.equal((await fetch(base+'/api/dashboard/architecture')).status,401);
  const setup=await fetch(base+'/api/auth/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:'test password 12345'})});
  const response=await fetch(base+'/api/dashboard/architecture',{headers:{Cookie:setup.headers.get('set-cookie').split(';')[0]}});
  assert.equal(response.status,200);const data=await response.json();assert.equal(data.network.interfaces[0].name,'actual0');assert.equal(data.profiles.length,store.profiles().length);assert.equal(data.observations.available,false);assert.ok(!JSON.stringify(data).includes('password'));
 }finally{await new Promise(resolve=>server.close(resolve));store.close();}
});

test('map shows only confirmed connected local and remote clients, removes stale links and restores reconnects',()=>{
 const data=snapshot();
 data.clients.push({id:'remote-on',accessPointId:'ap',remote:true,online:true,traffic:{upload:0,download:0}},
 {id:'remote-off',accessPointId:'ap',remote:true,online:false},
 {id:'remote-unknown',accessPointId:'ap',remote:true,online:null},
 {ip:'192.0.2.12',online:false},{ip:'192.0.2.13'});
 data.observations.paths.push({routeKind:'groups',routeId:'rule-id',sourceIP:'192.0.2.12',downloadRate:100});
 let graph=buildNetworkArchitecture(data);
 assert.deepEqual(graph.nodes.filter(n=>n.kind==='device').map(n=>n.id),['client:aa:bb:cc:dd:ee:ff','client:remote:ap:remote-on']);
 assert.ok(!graph.edges.some(e=>e.target==='client:192.0.2.12'));
 data.clients[0].online=false;graph=buildNetworkArchitecture(data);
 assert.ok(!graph.nodes.some(n=>n.id==='client:aa:bb:cc:dd:ee:ff'));
 assert.ok(!graph.edges.some(e=>e.target==='client:aa:bb:cc:dd:ee:ff'));
 data.clients[0].online=true;graph=buildNetworkArchitecture(data);
 assert.ok(graph.nodes.some(n=>n.id==='client:aa:bb:cc:dd:ee:ff'));
 assert.ok(graph.edges.some(e=>e.target==='client:aa:bb:cc:dd:ee:ff'));
});
