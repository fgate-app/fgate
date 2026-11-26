import test from 'node:test';
import {buildNetworkArchitectureLayout} from '../web/src/lib/network-architecture-layout.js';
import assert from 'node:assert/strict';
import {currentNetworkArchitecture,currentNetworkSnapshot,prototypeNetworkArchitecture} from '../web/src/fixtures/network-architecture-current.js';
test('physical ports connect directly to one tall module card with a separate DNS branch',()=>{
 const graph=currentNetworkArchitecture(),group=graph.nodeGroups[0];
 assert.ok(!graph.nodes.some(node=>node.id==='router'||node.id==='port:Meta'));
 assert.equal(group.id,'modules');assert.equal(graph.nodes.filter(node=>node.kind==='port').length,2);
 const modules=graph.nodes.filter(node=>group.nodeIds.includes(node.id));assert.deepEqual(group.nodeIds,modules.map(node=>node.id));
 assert.deepEqual(modules.map(node=>node.id),['module:tor','module:lantern','module:outline','module:xray','module:mihomo','module:zapret']);
 for(let i=1;i<modules.length;i++)assert.equal(modules[i].y-modules[i-1].y,94);
 assert.equal(group.height,6*94);
 for(const port of graph.nodes.filter(node=>node.kind==='port')){
  const outgoing=graph.edges.filter(edge=>edge.source===port.id);assert.ok(outgoing.every(edge=>edge.solid));assert.equal(outgoing.filter(edge=>edge.target==='modules').length,1);assert.ok(!outgoing.some(edge=>edge.target.startsWith('module:')));
 }
 const filter=graph.nodes.find(node=>node.id==='filter:adguard');
 assert.equal(filter.x,group.x);assert.equal(group.y-filter.y-94,16);
 assert.equal(graph.edges.filter(edge=>edge.source===filter.id).length,0);
 assert.deepEqual(graph.edges.filter(edge=>edge.target===filter.id).map(edge=>edge.source).sort(),graph.nodes.filter(node=>node.kind==='port').map(node=>node.id).sort());
 const ids=new Set([...graph.nodes.map(node=>node.id),...graph.nodeGroups.map(group=>group.id),...(graph.anchors || []).map(anchor=>anchor.id)]);for(const edge of graph.edges){assert.ok(ids.has(edge.source));assert.ok(ids.has(edge.target));}
});
test('each wired and wireless interface keeps its own RX/TX, including multiple interfaces of one type',()=>{
 const data=currentNetworkSnapshot();
 data.network.interfaces.push({name:'eth1',type:'ethernet',carrier:true,addresses:[]},{name:'wlan1',type:'wifi',carrier:false,addresses:[]});
 data.interfaceTraffic.interfaces.eth1={receiveRate:1234,transmitRate:567};data.interfaceTraffic.interfaces.wlan1={receiveRate:0,transmitRate:0};
 const graph=prototypeNetworkArchitecture(data);assert.equal(graph.nodes.filter(node=>node.kind==='port').length,4);
 for(const name of ['eth0','wlan0','eth1','wlan1']){const edge=graph.edges.find(edge=>edge.source==='port:'+name&&edge.target==='modules');assert.equal(edge.downloadRate,data.interfaceTraffic.interfaces[name].receiveRate);assert.equal(edge.uploadRate,data.interfaceTraffic.interfaces[name].transmitRate);assert.equal(edge.solid,true);}
 assert.equal(graph.edges.find(edge=>edge.source==='port:wlan1'&&edge.target==='modules').state,'offline');
});
test('Tor, Lantern and zapret remain separate modules and gateways with their original links',()=>{
 const data=currentNetworkSnapshot(),graph=prototypeNetworkArchitecture(data);
 for(const engine of ['tor','lantern','zapret']){
  const profile=data.profiles.find(profile=>profile.engine===engine);
  const module=graph.nodes.find(node=>node.id==='module:'+engine),gateway=graph.nodes.find(node=>node.id==='gateway:'+profile.id);
  assert.ok(module&&gateway);assert.ok(module.x<gateway.x);
  assert.ok(graph.edges.some(edge=>edge.source===module.id&&edge.target===gateway.id));
  assert.equal(gateway.enabled,profile.enabled);
 }
 const ids=new Set([...graph.nodes.map(node=>node.id),...graph.nodeGroups.map(group=>group.id),...(graph.anchors || []).map(anchor=>anchor.id)]);for(const edge of graph.edges){assert.notEqual(edge.source,edge.target);assert.ok(ids.has(edge.source)&&ids.has(edge.target));}
});
test('exit order follows module rows so source-to-exit curves never cross',()=>{
 const graph=currentNetworkArchitecture(),map=new Map(graph.nodes.map(node=>[node.id,node]));
 const links=graph.edges.filter(edge=>map.get(edge.source)?.kind==='module'&&map.get(edge.target)?.kind==='gateway').sort((a,b)=>map.get(a.target).y-map.get(b.target).y);
 assert.equal(links.length,8);
 for(let i=1;i<links.length;i++)assert.ok(map.get(links[i-1].source).y<=map.get(links[i].source).y,'exit ordering matches source ordering');
 const engines=links.map(edge=>edge.source);assert.deepEqual(engines,['module:tor','module:lantern','module:outline','module:outline','module:xray','module:xray','module:mihomo','module:zapret']);
 const exits=graph.nodes.filter(node=>node.kind==='gateway'),groups=graph.nodes.filter(node=>node.kind==='gatewayGroup');
 assert.ok(groups.every(group=>group.x>Math.max(...exits.map(node=>node.x))&&group.x<Math.min(...graph.nodes.filter(node=>node.kind==='rule').map(node=>node.x))));
 assert.ok(groups.every(group=>group.icon==='public'));
 for(const edge of graph.edges.filter(edge=>['gateway','gatewayGroup'].includes(map.get(edge.source)?.kind)&&['gateway','gatewayGroup'].includes(map.get(edge.target)?.kind)))assert.equal(edge.side,'right');
});

test('gateway protocol art uses the protocol registry, with local exit overrides',()=>{
 const graph=currentNetworkArchitecture();
 for(const gateway of graph.nodes.filter(node=>node.kind==='gateway')){
  const profile=currentNetworkSnapshot().profiles.find(profile=>'gateway:'+profile.id===gateway.id);
  assert.equal(gateway.protocol,['tor','lantern','zapret','direct'].includes(profile.engine)?profile.engine:profile.protocol);
 }
});

test('connection group inputs are exclusively their member gateways',()=>{
 const data=currentNetworkSnapshot(),graph=prototypeNetworkArchitecture(data);
 for(const group of graph.nodes.filter(node=>node.kind==='gatewayGroup')){
  const inputs=graph.edges.filter(edge=>edge.target===group.id);
  const row=data.connectionGroups.find(row=>'group:'+row.id===group.id);
  assert.deepEqual(inputs.map(edge=>edge.source).sort(),row.members.map(id=>'gateway:'+id).sort());
  assert.ok(inputs.every(edge=>graph.nodes.find(node=>node.id===edge.source)?.kind==='gateway'));
 }
});

test('frp is a separate card below AdGuard in the module column',()=>{
 const graph=currentNetworkArchitecture(),frp=graph.nodes.find(node=>node.id==='module:frp'),filter=graph.nodes.find(node=>node.id==='filter:adguard');
 assert.equal(frp.x,filter.x);assert.equal(frp.y-graph.nodeGroups[0].y-graph.nodeGroups[0].height,16);
 const frame=graph.frames[0];for(const card of [filter,graph.nodeGroups[0],frp]){assert.ok(card.x>frame.x&&card.y>frame.y);assert.ok(card.y+(card.height||94)<frame.y+frame.height);}
 assert.ok(!graph.nodeGroups[0].nodeIds.includes(frp.id));
 assert.equal(frp.state,'healthy');assert.equal(frp.detail,'v0.72.0');
 assert.ok(!graph.edges.some(edge=>edge.source===frp.id||edge.target===frp.id));
});

test('live layout handles loading, partial snapshots and unavailable interface rates',()=>{
 assert.deepEqual(buildNetworkArchitectureLayout(null,{loading:true}).nodes,[]);
 assert.equal(buildNetworkArchitectureLayout(null,{loading:true}).loading,true);
 assert.deepEqual(buildNetworkArchitectureLayout({}).nodes,[]);
 const graph=buildNetworkArchitectureLayout(currentNetworkSnapshot(),{unavailable:true});
 assert.ok(graph.unavailable);
 assert.ok(graph.edges.every(edge=>edge.downloadRate===null&&edge.uploadRate===null));
 const partial=buildNetworkArchitectureLayout({network:{interfaces:[{name:'eth0',type:'ethernet'}]}});
 const ids=new Set(partial.nodes.map(node=>node.id));
 for(const edge of partial.edges)assert.ok(ids.has(edge.source)&&ids.has(edge.target));
});

test('wrapped gateways have an enclosing gateway header and hidden traversal edges',()=>{
 const graph=currentNetworkArchitecture(),wrapped=graph.nodes.filter(node=>node.wrap);assert.equal(wrapped.length,3);
 for(const node of wrapped){
  const profile=currentNetworkSnapshot().profiles.find(profile=>'gateway:'+profile.id===node.id);
  assert.equal(node.wrap.id,'gateway:'+profile.gatewayId);
  assert.ok(node.x>node.wrap.x&&node.y>node.wrap.y&&node.x+node.width<node.wrap.x+node.wrap.width&&node.y+94<node.wrap.y+node.wrap.height);
  assert.equal(graph.edges.find(edge=>edge.source===node.wrap.id&&edge.target===node.id).hidden,true);
 }
});

test('outer and inner gateway cards receive separate left inputs from their own engines',()=>{
 const graph=currentNetworkArchitecture(),map=new Map([...graph.nodes,...graph.anchors].map(node=>[node.id,node]));
 for(const node of graph.nodes.filter(node=>node.wrap)){
  const outerInput=graph.edges.find(edge=>edge.target===node.wrap.anchorId&&!edge.hidden);
  const parentInput=graph.edges.find(edge=>edge.target===node.wrap.id&&edge.source.startsWith('module:'));
  assert.equal(outerInput.source,parentInput.source);assert.ok(map.get(outerInput.source).x<node.wrap.x);
  assert.equal(outerInput.downloadRate,null);assert.equal(outerInput.uploadRate,null);
  assert.ok(graph.edges.some(edge=>edge.target===node.id&&edge.source.startsWith('module:')&&!edge.hidden));
  assert.ok(!graph.edges.some(edge=>edge.source===node.wrap.anchorId&&!edge.hidden));
 }
});

test('gateway spacing uses visible outer bounds for plain and wrapped cards',()=>{
 const graph=currentNetworkArchitecture();
 const cards=graph.nodes.filter(node=>node.kind==='gateway').map(node=>({y:node.wrap?.y ?? node.y,height:node.wrap?.height ?? 94})).sort((a,b)=>a.y-b.y);
 assert.ok(graph.nodes.some(node=>node.wrap)&&graph.nodes.some(node=>node.kind==='gateway'&&!node.wrap));
 for(let i=1;i<cards.length;i++)assert.equal(cards[i].y-cards[i-1].y-cards[i-1].height,42);
});

test('column titles share one module heading and hide only empty client column',()=>{
 const data=currentNetworkSnapshot();
 assert.deepEqual(currentNetworkArchitecture().columns.map(([key])=>key),['architecture.ports','architecture.modules','architecture.gateways','architecture.connectionGroup','architecture.rules','architecture.clients']);
 data.clients.forEach(client=>client.online=false);
 assert.deepEqual(prototypeNetworkArchitecture(data).columns.map(([key])=>key),['architecture.ports','architecture.modules','architecture.gateways','architecture.connectionGroup','architecture.rules']);
 const empty=prototypeNetworkArchitecture({network:{interfaces:[]},profiles:[],connectionGroups:[],rules:{groups:[],devices:[]},modules:[],clients:[]});
 assert.deepEqual(empty.columns.map(([key])=>key),['architecture.ports','architecture.modules','architecture.gateways','architecture.connectionGroup','architecture.rules']);
});
