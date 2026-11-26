import {buildNetworkArchitecture} from './network-architecture.js';

export function buildNetworkArchitectureLayout(data,options={}){
 const base=buildNetworkArchitecture(data,options),byId=new Map(base.nodes.map(node=>[node.id,node]));
 if(!data)return base;
 const ports=base.nodes.filter(node=>node.kind==='port'&&(data.network?.interfaces || []).some(port=>port.name===node.name&&['ethernet','wifi'].includes(port.type)));
 const moduleOrder=['tor','lantern','outline','xray','mihomo','zapret'];
 const modules=moduleOrder.map(id=>byId.get('module:'+id)).filter(Boolean);
 const filter=byId.get('module:adguard'),frp=byId.get('module:frp');
 const protocolFor=node=>{const profile=(data.profiles || []).find(profile=>'gateway:'+profile.id===node.id);return ['direct','tor','lantern','zapret'].includes(profile?.engine)?profile.engine:profile?.protocol || 'other';};
 // Preserve the same source/target order across this band. All exits served by
 // one module stay adjacent; mixed connection groups follow individual exits.
 const ranks=new Map(modules.map((module,index)=>[module.id,index]));
 const exitRank=node=>{
  const source=base.edges.find(edge=>edge.target===node.id&&ranks.has(edge.source))?.source;
  return ranks.get(source) ?? modules.length;
 };
 const exits=base.nodes.filter(node=>node.kind==='gateway').sort((a,b)=>exitRank(a)-exitRank(b));
 const connectionGroups=base.nodes.filter(node=>node.kind==='gatewayGroup').map(node=>({...node,icon:'public'}));

 // World-coordinate equivalent of space-4 between separate module cards.
 const standaloneGap=16,modulesY=126+(filter?94+standaloneGap:0),frpY=modulesY+modules.length*94+standaloneGap;
 const columnGap=160,nodeWidth=180,framePadding=16,frameWidth=nodeWidth+framePadding*2;
 const portX=32,frameX=portX+nodeWidth+columnGap,moduleX=frameX+framePadding;
 const gatewayX=frameX+frameWidth+columnGap,groupX=gatewayX+nodeWidth+columnGap;
 const ruleX=groupX+nodeWidth+columnGap,clientX=ruleX+nodeWidth+columnGap;
 const categories=[
  {key:'architecture.ports',x:portX,nodes:ports},
  {key:'architecture.dnsFilter',x:moduleX,nodes:filter?[{...filter,id:'filter:adguard',kind:'filter'}]:[]},
  {key:'architecture.modules',x:moduleX,nodes:[...modules,...(frp?[frp]:[])]},
  {key:'architecture.gateways',x:gatewayX,nodes:exits},
  {key:'architecture.connectionGroup',x:groupX,nodes:connectionGroups},
  {key:'architecture.rules',x:ruleX,nodes:base.nodes.filter(node=>node.kind==='rule')},
  {key:'architecture.clients',x:clientX,nodes:base.nodes.filter(node=>node.kind==='device')},
 ];
 const nodes=categories.flatMap(category=>category.nodes.map((node,index)=>({
  ...node,name:node.id==='module:outline'?'Outline':node.name,
  ...(['filter:adguard','module:frp'].includes(node.id)?{hideIcon:true}:{}),
  ...(node.kind==='gateway'?{protocol:protocolFor(node)}:{}),
  x:category.x,y:node.id==='module:frp'?frpY:node.id==='filter:adguard'?126:(category.key==='architecture.modules'?modulesY+index*94:126+index*136),
  // Interface-wide rates belong on physical links in this layout.
  ...(node.kind==='port'?{traffic:null}:{})
 })));
 // The outer header names the actual configured wrapping gateway. Keep the
 // original edge for selection traversal, but nesting replaces its visible wire.
 // Match the 42-unit space between 94-unit cards in the other columns.
 // Advance by the visible outer height, including a wrapping gateway.
 const gatewayGap=42;let gatewayY=126;
 for(const gateway of exits){
  const node=nodes.find(row=>row.id===gateway.id),profile=(data.profiles || []).find(row=>'gateway:'+row.id===gateway.id);
  node.y=gatewayY;
  const parent=byId.get('gateway:'+profile?.gatewayId);
  if(parent){
   node.wrap={anchorId:'wrap:'+node.id,id:parent.id,name:parent.name,protocol:protocolFor(parent),state:parent.state,x:gatewayX,y:node.y,width:180,height:138};
   node.x+=8;node.y+=36;node.width=164;
  }
  gatewayY+=(node.wrap?.height ?? 94)+gatewayGap;
 }
 const anchors=nodes.filter(node=>node.wrap).map(node=>({
  id:node.wrap.anchorId,x:node.wrap.x,y:node.wrap.y,width:node.wrap.width,
  connectionY:node.wrap.y+19,state:node.wrap.state
 }));
 const nodeGroups=modules.length?[{id:'modules',labelKey:'architecture.modules',nodeIds:modules.map(module=>module.id),x:moduleX,y:modulesY,width:180,height:modules.length*94}]:[];
 const visible=new Set([...nodes.map(node=>node.id),...nodeGroups.map(group=>group.id)]);
 const edges=base.edges.filter(edge=>!edge.source.startsWith('port:')&&!(edge.source.startsWith('module:')&&edge.target.startsWith('module:')))
  .filter(edge=>edge.source!==edge.target&&visible.has(edge.source)&&visible.has(edge.target))
  .map(edge=>['gateway','gatewayGroup'].includes(byId.get(edge.source)?.kind)&&['gateway','gatewayGroup'].includes(byId.get(edge.target)?.kind)?{...edge,side:'right'}:edge);
 for(const edge of edges){
  if(nodes.find(node=>node.id===edge.target)?.wrap?.id===edge.source)edge.hidden=true;
 }
 const connect=(source,target,extra={})=>{
  const state=nodes.find(node=>node.id===source)?.state || 'unknown';
  edges.push({id:source+'→'+target,source,target,state,download:null,upload:null,downloadRate:null,uploadRate:null,...extra});
 };
 for(const node of nodes.filter(node=>node.wrap)){
  const moduleEdge=base.edges.find(edge=>edge.target===node.wrap.id&&ranks.has(edge.source));
  if(moduleEdge)connect(moduleEdge.source,node.wrap.anchorId,{state:moduleEdge.state});
  connect(node.wrap.anchorId,node.id,{state:node.state,hidden:true});
 }
 for(const port of ports){
  const counters=options.unavailable?null:data.interfaceTraffic?.interfaces?.[port.name];
  if(modules.length)connect(port.id,'modules',{solid:true,scope:'architecture.interfaceTraffic',downloadRate:counters?.receiveRate ?? null,uploadRate:counters?.transmitRate ?? null});
  if(filter)connect(port.id,'filter:adguard',{solid:true,label:options.unavailable?null:'DNS'});
 }
 for(const module of modules)connect('modules',module.id,{state:module.state,hidden:true});
 return {...base,nodes,edges,nodeGroups,anchors,frames:modules.length||filter||frp?[{id:'system-modules',x:frameX,y:110,width:frameWidth,height:(frp?frpY+94:modulesY+modules.length*94)-110+16}]:[],columns:categories.filter(({key,nodes})=>key!=='architecture.dnsFilter'&&(key!=='architecture.clients'||nodes.length>0)).map(({key,x})=>[key,x]),width:clientX+nodeWidth+32,
  height:Math.max(810,...nodes.map(node=>node.y+134)),initialFocus:{x:clientX-40,y:360}};
}
