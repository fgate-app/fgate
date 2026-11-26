<script setup>
import {computed,onBeforeUnmount,onMounted,ref,useId,watch,nextTick} from 'vue';
import {mdiWifi,mdiEthernet,mdiLaptop,mdiCellphone,mdiTelevision,mdiMinus,mdiPlus,mdiFitToScreenOutline} from '@mdi/js';
import AppDataCard from './AppDataCard.vue';
import AppButton from './AppButton.vue';
import AppIcon from './AppIcon.vue';
import AppSelect from './AppSelect.vue';
import AppSpinner from './AppSpinner.vue';
import AppRowMenu from './AppRowMenu.vue';
import BrandLogo from './BrandLogo.vue';
import ProtocolIcon from './ProtocolIcon.vue';
import {readNetworkMapView,writeNetworkMapView} from '../lib/network-map-view.js';
import {formatNetworkRate} from '../lib/network-traffic.js';
import {usePreferences} from '../preferences.js';
const props=defineProps({graph:{type:Object,required:true},nodeActions:Function,actionsBusy:Boolean,createActions:{type:Array,default:()=>[]}});
const emit=defineEmits(['node-action','create']);
const {t,locale}=usePreferences();
const mapMenu=ref(),menuActions=ref([]),menuNode=ref(null);let menuRequest=0;
function closeMapMenu(){menuRequest++;mapMenu.value?.close();}
async function openNodeMenu(node,element,point){
 if(!node || !props.nodeActions || props.actionsBusy)return;
 const request=++menuRequest,actions=await props.nodeActions(node);
 if(request!==menuRequest || !element?.isConnected)return;
 menuActions.value=actions;menuNode.value=node;await nextTick();
 if(actions.length)await mapMenu.value?.openAt(element,point);
}
function activateNode(node,event){
 if(!node)return;selected.value=props.nodeActions?node.id:(selected.value===node.id?null:node.id);
 const point=event.type==='contextmenu'&&(event.clientX||event.clientY)?{x:event.clientX,y:event.clientY}:undefined;
 openNodeMenu(node,event.currentTarget,point);
}
const viewport=ref(),selected=ref(null),scale=ref(1),offset=ref({x:0,y:0}),dragging=ref(false),viewportSize=ref({width:1,height:1});
const showTrafficCounters=computed(()=>scale.value>=.65);
const marker='architecture-'+useId(),nodeWidth=180,nodeHeight=94;
const canvasWidth=computed(()=>props.graph.width || 1284),canvasHeight=computed(()=>props.graph.height || 810);
const icons={wifi:mdiWifi,ethernet:mdiEthernet,laptop:mdiLaptop,phone:mdiCellphone,tv:mdiTelevision};
let resizeObserver,initial=true,gesture=null,viewSaveTimer;
const pointers=new Map();
const nodeMap=computed(()=>new Map([
 ...props.graph.nodes.map(node=>[node.id,node]),
 ...(props.graph.anchors || []).map(anchor=>[anchor.id,anchor]),
 ...(props.graph.nodeGroups || []).map(group=>[group.id,{id:group.id,x:group.x,y:group.y,connectionY:group.y+group.height/2}])
]));
const nodeClusters=computed(()=>{
 const grouped=new Set();
 const clusters=(props.graph.nodeGroups || []).map(group=>{
  const nodes=group.nodeIds.map(id=>nodeMap.value.get(id)).filter(Boolean);nodes.forEach(node=>grouped.add(node.id));
  return {...group,nodes,bounds:{left:group.x+'px',top:group.y+'px',width:group.width+'px',height:group.height+'px'}};
 });
 return [...clusters,...props.graph.nodes.filter(node=>!grouped.has(node.id)).map(node=>({id:null,key:node.id,nodes:[node]}))];
});
// Follow ancestors and descendants separately, so selecting a client reveals its
// gateways without also highlighting other clients that happen to share a port.
const selectedEdges=computed(()=>{
 const result=new Set();if(!selected.value)return result;
 for(const direction of ['up','down']){
  const visited=new Set([selected.value]),queue=[selected.value];
  while(queue.length){const id=queue.shift();for(const edge of props.graph.edges){
   if((direction==='up'?edge.target:edge.source)!==id)continue;
   result.add(edge.id);const next=direction==='up'?edge.source:edge.target;
   if(!visited.has(next)){visited.add(next);queue.push(next);}
  }}
 }
 return result;
});
const connected=computed(()=>new Set(selected.value?[selected.value,...props.graph.edges.filter(edge=>selectedEdges.value.has(edge.id)).flatMap(edge=>[edge.source,edge.target])]:[]));
const searchQuery=ref('');
const searchOptions=computed(()=>props.graph.nodes.filter(node=>['device','rule','gateway','gatewayGroup'].includes(node.kind)).map(node=>{
 const category={device:'architecture.clients',rule:'architecture.rules',gateway:'architecture.gateways',gatewayGroup:'architecture.connectionGroup'}[node.kind];
 const name=node.nameKey?t(node.nameKey):node.name;
 return {value:node.id,label:[name,node.detail,t(category)].filter(Boolean).join(' · '),searchText:[name,node.detail].filter(Boolean).join(' ')};
}));
function searchText(value){searchQuery.value=value;if(!value.trim())selected.value=null;}
function searchChoose(option){
 const node=props.graph.nodes.find(node=>node.id===option.value);if(!node)return;
 searchQuery.value=option.label;selected.value=node.id;
 scale.value=Math.max(.8,scale.value);
 offset.value={x:viewportSize.value.width/2-(node.x+connectionWidth(node)/2)*scale.value,y:viewportSize.value.height/2-(node.y+nodeHeight/2)*scale.value};
}
const stateKey=state=>({unknown:'architecture.statusUnknown',policy:'architecture.blockAction',healthy:'architecture.online',error:'architecture.unreachable',disabled:'architecture.disabled',offline:'architecture.offline',blocked:'architecture.blocked'}[state]);
function country(code){try{return new Intl.DisplayNames([locale.value],{type:'region'}).of(code);}catch{return code;}}
function flag(code){return [...code].map(letter=>String.fromCodePoint(letter.charCodeAt(0)+127397)).join('');}
function fit(){
 closeMapMenu();
 if(!viewport.value)return;
 const {width,height}=viewport.value.getBoundingClientRect();
 scale.value=Math.min((width-32)/canvasWidth.value,(height-32)/canvasHeight.value,1);
 offset.value={x:(width-canvasWidth.value*scale.value)/2,y:(height-canvasHeight.value*scale.value)/2};
}
function zoom(factor,point){
 closeMapMenu();
 const rect=viewport.value.getBoundingClientRect();
 const anchor=point||{x:rect.width/2,y:rect.height/2};
 const next=Math.max(.25,Math.min(2.4,scale.value*factor)),ratio=next/scale.value;
 offset.value={x:anchor.x-(anchor.x-offset.value.x)*ratio,y:anchor.y-(anchor.y-offset.value.y)*ratio};scale.value=next;
}
function wheel(event){const rect=viewport.value.getBoundingClientRect();zoom(Math.exp(-event.deltaY*.0015),{x:event.clientX-rect.left,y:event.clientY-rect.top});}
function begin(event){
 if(event.button && event.pointerType==='mouse')return;
 closeMapMenu();
 viewport.value.focus({preventScroll:true});viewport.value.setPointerCapture(event.pointerId);
 pointers.set(event.pointerId,{x:event.clientX,y:event.clientY});
 const values=[...pointers.values()];
 const element=event.target.closest('[data-architecture-node],[data-menu-node]');
 gesture={start:{x:event.clientX,y:event.clientY},offset:{...offset.value},scale:scale.value,moved:false,target:element?.dataset.architectureNode || element?.dataset.menuNode,element};
 if(values.length===2){gesture.distance=Math.hypot(values[1].x-values[0].x,values[1].y-values[0].y);const rect=viewport.value.getBoundingClientRect();gesture.center={x:(values[0].x+values[1].x)/2-rect.left,y:(values[0].y+values[1].y)/2-rect.top};}
}
function move(event){
 if(!pointers.has(event.pointerId)||!gesture)return;
 pointers.set(event.pointerId,{x:event.clientX,y:event.clientY});const values=[...pointers.values()];
 if(values.length===2&&gesture.distance){
  const rect=viewport.value.getBoundingClientRect(),center={x:(values[0].x+values[1].x)/2-rect.left,y:(values[0].y+values[1].y)/2-rect.top};
  const next=Math.max(.25,Math.min(2.4,gesture.scale*Math.hypot(values[1].x-values[0].x,values[1].y-values[0].y)/gesture.distance));
  const ratio=next/gesture.scale;offset.value={x:center.x-(gesture.center.x-gesture.offset.x)*ratio,y:center.y-(gesture.center.y-gesture.offset.y)*ratio};scale.value=next;gesture.moved=true;
 }else{const dx=event.clientX-gesture.start.x,dy=event.clientY-gesture.start.y;if(Math.hypot(dx,dy)>4){gesture.moved=true;offset.value={x:gesture.offset.x+dx,y:gesture.offset.y+dy};}}
 dragging.value=gesture.moved;
}
function end(event){
 if(!gesture || !pointers.has(event.pointerId))return;
 const moved=gesture.moved,target=gesture.target,element=gesture.element;
 pointers.delete(event.pointerId);
 if(!moved&&event.type==='pointerup'){selected.value=target?(props.nodeActions?target:(selected.value===target?null:target)):null;
  if(target)openNodeMenu(nodeMap.value.get(target),element,{x:event.clientX,y:event.clientY});
 }
 gesture=null;dragging.value=false;
 if(pointers.size){pointers.clear();}
}
function keyboard(event){
 if(event.target!==viewport.value)return;
 const steps={ArrowLeft:[40,0],ArrowRight:[-40,0],ArrowUp:[0,40],ArrowDown:[0,-40]};
 if(steps[event.key]){event.preventDefault();offset.value={x:offset.value.x+steps[event.key][0],y:offset.value.y+steps[event.key][1]};}
 else if(event.key==='+'||event.key==='='){event.preventDefault();zoom(1.2);}
 else if(event.key==='-'){event.preventDefault();zoom(1/1.2);}
 else if(event.key==='0'){event.preventDefault();fit();}
 else if(event.key==='Escape')selected.value=null;
}
// 1px border + space-3 padding + half of the space-5 header.
const connectionY=node=>node.connectionY ?? node.y+23;
const connectionWidth=node=>node.width ?? nodeWidth;
function path(edge){
 const a=nodeMap.value.get(edge.source),b=nodeMap.value.get(edge.target);
 if(a.x===b.x){const right=edge.side==='right',x=a.x+(right?connectionWidth(a):0),y=connectionY(a),end=connectionY(b),rail=x+(right?40:-40);return `M${x},${y} C${rail},${y} ${rail},${end} ${x},${end}`;}
 const forward=b.x>a.x,start=a.x+(forward?connectionWidth(a):0),end=b.x+(forward?0:connectionWidth(b)),ay=connectionY(a),by=connectionY(b),mid=(start+end)/2;
 return `M${start},${ay} C${mid},${ay} ${mid},${by} ${end},${by}`;
}
function labelPoint(edge){
 const a=nodeMap.value.get(edge.source),b=nodeMap.value.get(edge.target),ay=connectionY(a),by=connectionY(b);
 if(a.x===b.x)return {x:a.x+(edge.side==='right'?connectionWidth(a)+30:-30),y:(ay+by)/2};
 const forward=b.x>a.x;return {x:(a.x+(forward?connectionWidth(a):0)+b.x+(forward?0:connectionWidth(b)))/2,y:(ay+by)/2};
}
const countersAllowed=edge=>[edge.source,edge.target].every(id=>{
 const node=nodeMap.value.get(id);return node?.enabled!==false&&node?.state!=='disabled';
});
const inactiveEdge=edge=>['disabled','offline'].includes(edge.state)||[edge.source,edge.target].some(id=>{
 const node=nodeMap.value.get(id);return node?.enabled===false||['disabled','offline'].includes(node?.state);
});
const trafficLabels=computed(()=>props.graph.edges.filter(edge=>!edge.hidden&&(edge.label||(showTrafficCounters.value&&countersAllowed(edge)&&hasTraffic(edge)))));
const hasTraffic=edge=>Number.isFinite(edge.downloadRate)||Number.isFinite(edge.uploadRate)||edge.download!=null;
const moving=edge=>Number.isFinite(edge.downloadRate)||Number.isFinite(edge.uploadRate)?(edge.downloadRate || 0)+(edge.uploadRate || 0)>0:edge.download!=null&&Number(edge.download)>0;
const rate=(edge,key)=>Number.isFinite(edge[key+'Rate'])?formatNetworkRate(edge[key+'Rate'],t):edge[key]!=null?edge[key]+' MB/s':null;
const edgeActive=edge=>!selected.value||selectedEdges.value.has(edge.id);
function overviewClick(event){
 const box=event.currentTarget.getBoundingClientRect();
 offset.value={x:viewportSize.value.width/2-(event.clientX-box.left)/box.width*canvasWidth.value*scale.value,y:viewportSize.value.height/2-(event.clientY-box.top)/box.height*canvasHeight.value*scale.value};
}
function initialView(){
 const saved=readNetworkMapView();scale.value=saved?.scale ?? 1;offset.value=saved?.offset ?? {x:16,y:16};
}
function persistView(){if(!initial)writeNetworkMapView({scale:scale.value,offset:offset.value});}
watch(()=>[scale.value,offset.value.x,offset.value.y],()=>{
 if(initial)return;clearTimeout(viewSaveTimer);viewSaveTimer=setTimeout(persistView,150);
});
onMounted(()=>{resizeObserver=new ResizeObserver(()=>{
 const box=viewport.value.getBoundingClientRect();viewportSize.value={width:box.width,height:box.height};
 if(initial){initialView();initial=false;}
 });resizeObserver.observe(viewport.value);window.addEventListener('pagehide',persistView);});
watch(()=>props.graph.nodes,nodes=>{if(selected.value&&!nodes.some(node=>node.id===selected.value))selected.value=null;});
onBeforeUnmount(()=>{menuRequest++;resizeObserver?.disconnect();clearTimeout(viewSaveTimer);persistView();window.removeEventListener('pagehide',persistView);});
</script>
<template>
 <AppDataCard class="architecture-card" :title="t('architecture.title')">
  <template #title><AppIcon name="network" class="architecture-title-icon"/><h3>{{t('architecture.title')}}</h3></template>
  <template #actions>
   <div class="architecture-search"><AppSelect data-testid="architecture-search" :model-value="searchQuery" :options="searchOptions" editable :min-search-length="1" :disabled="graph.loading" size="s" :label="t('architecture.search')" :placeholder="t('architecture.search')" @update:model-value="searchText" @select="searchChoose"/></div>
  </template>
  <div ref="viewport" class="architecture-viewport" :class="{'is-dragging':dragging}" tabindex="0" role="group" :aria-busy="!!graph.loading" :aria-label="t('architecture.canvasLabel')" @wheel.prevent="wheel" @pointerdown="begin" @pointermove="move" @pointerup="end" @pointercancel="end" @keydown="keyboard" @dblclick.prevent="fit">
   <div v-if="graph.loading" class="architecture-loading"><AppSpinner :label="t('architecture.loading')"/></div>
   <span v-else-if="!graph.nodes.length" class="architecture-empty" role="status">{{t(graph.loading?'architecture.loading':graph.unavailable?'architecture.dataUnavailable':'architecture.empty')}}</span>
   <div class="architecture-world" :style="{transform:`translate(${offset.x}px,${offset.y}px) scale(${scale})`,width:canvasWidth+'px',height:canvasHeight+'px'}" data-testid="architecture-world">
    <div v-for="[key,x] in graph.columns || []" :key="key" class="architecture-column-title" :data-column-title="key" :style="{left:x+'px'}"><span>{{t(key==='architecture.modules'?'architecture.freedomGate':key)}}</span><AppButton v-for="action in createActions.filter(action=>action.column===key)" :key="action.value" size="s" variant="blanc" icon-only :aria-label="action.label" :title="action.label" :data-testid="'architecture-create-'+action.value" :disabled="actionsBusy" @pointerdown.stop @keydown.stop @dblclick.stop @click.stop="closeMapMenu();emit('create',action.value)"><AppIcon name="plus" /></AppButton></div>
    <div v-for="frame in graph.frames || []" :key="frame.id" class="architecture-frame" :data-architecture-frame="frame.id" :style="{left:frame.x+'px',top:frame.y+'px',width:frame.width+'px',height:frame.height+'px'}" aria-hidden="true"/>
    <svg class="architecture-edges" :width="canvasWidth" :height="canvasHeight" aria-hidden="true">
     <defs><marker v-for="state in ['healthy','error','blocked','disabled','offline','unknown','policy','dns']" :id="marker+'-'+state" :key="state" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M2 2L8 5L2 8" :class="'architecture-arrow '+state"/></marker></defs>
     <g v-for="edge in graph.edges.filter(edge=>!edge.hidden)" :key="edge.id" :class="['architecture-edge',edge.state,{'is-dim':!edgeActive(edge),'is-solid':edge.solid,'is-dns':edge.label==='DNS','is-inactive':inactiveEdge(edge)}]" :data-edge="edge.id">
      <path :d="path(edge)" class="architecture-wire" :marker-end="inactiveEdge(edge)?undefined:`url(#${marker}-${edge.label==='DNS'?'dns':edge.state})`"/>
      <path v-if="edge.state==='healthy'||edge.solid" :d="path(edge)" class="architecture-wire architecture-return" :marker-start="inactiveEdge(edge)?undefined:`url(#${marker}-${edge.label==='DNS'?'dns':edge.state})`" transform="translate(0,6)"/>
      <path v-if="edge.state==='healthy'&&moving(edge)" :d="path(edge)" class="architecture-flow"/>
      <path v-if="edge.state==='healthy'&&moving(edge)" :d="path(edge)" class="architecture-flow architecture-flow-return" transform="translate(0,6)"/>
     </g>
    </svg>
    <TransitionGroup name="architecture-counter">
    <div v-for="edge in trafficLabels" :key="'label-'+edge.id" class="architecture-rate" :data-counter-edge="edge.id" :class="[edge.state,{'is-dim':!edgeActive(edge),'is-solid':edge.solid,'is-dns':edge.label==='DNS','is-inactive':inactiveEdge(edge)}]" :style="{left:labelPoint(edge).x+'px',top:labelPoint(edge).y+'px',scale:1/Math.max(1,scale)}" :title="[t(edge.scope || 'architecture.observedTraffic'),t('architecture.download'),t('architecture.upload')].join(' · ')">
     <span v-if="edge.label" class="architecture-link-label">{{edge.label}}</span><span v-if="(!edge.label||(showTrafficCounters&&countersAllowed(edge)))&&rate(edge,'download')"><AppIcon name="expand"/>{{rate(edge,'download')}}</span><span v-if="(!edge.label||(showTrafficCounters&&countersAllowed(edge)))&&rate(edge,'upload')"><AppIcon name="collapse"/>{{rate(edge,'upload')}}</span>
    </div>
    </TransitionGroup>
    <div v-for="node in graph.nodes.filter(node=>node.wrap)" :key="'wrap-'+node.id" class="architecture-gateway-wrap" :class="[node.wrap.state,{'is-dim':selected&&!connected.has(node.id)}]" :data-wrapped-gateway="node.id" :data-architecture-anchor="node.wrap.anchorId" :data-menu-node="node.wrap.id" role="button" tabindex="0" :aria-haspopup="nodeActions?'menu':undefined" :aria-label="node.wrap.name" @contextmenu.prevent="activateNode(nodeMap.get(node.wrap.id),$event)" @keydown.enter.prevent="activateNode(nodeMap.get(node.wrap.id),$event)" @keydown.space.prevent="activateNode(nodeMap.get(node.wrap.id),$event)" :style="{left:node.wrap.x+'px',top:node.wrap.y+'px',width:node.wrap.width+'px',height:node.wrap.height+'px'}">
     <div class="architecture-node-head">
      <ProtocolIcon :protocol="node.wrap.protocol" :size="20" decorative class="architecture-node-icon"/>
      <span class="architecture-node-name">{{node.wrap.name}}</span>
      <span class="architecture-status"><AppIcon v-if="['error','blocked'].includes(node.wrap.state)" :name="node.wrap.state==='error'?'warning':'shield'"/><span v-else/></span>
     </div>
    </div>
    <div v-for="cluster in nodeClusters" :key="cluster.id || cluster.key" class="architecture-node-cluster" :class="{'architecture-node-group':cluster.id}" :data-architecture-group="cluster.id || undefined" :role="cluster.id?'group':undefined" :aria-label="cluster.id?t(cluster.labelKey):undefined">
    <div v-if="cluster.id" class="architecture-group-surface" :style="cluster.bounds" aria-hidden="true"/>
    <button v-for="node in cluster.nodes" :key="node.id" type="button" class="architecture-node" :class="[node.state,{'is-selected':selected===node.id,'is-dim':selected&&!connected.has(node.id)}]" :style="{left:node.x+'px',top:node.y+'px',width:node.width?node.width+'px':undefined}" :data-architecture-node="node.id" :title="[node.nameKey?t(node.nameKey):node.name,node.detailKey?t(node.detailKey,node.detailParameters):node.detail,t(node.statusKey||stateKey(node.state))].filter(Boolean).join(' · ')" :aria-haspopup="nodeActions?'menu':undefined" :aria-pressed="selected===node.id" :aria-label="[node.nameKey?t(node.nameKey):node.name,t(stateKey(node.state))].join(', ')" @click="event=>{if(event.detail===0)activateNode(node,event)}" @contextmenu.prevent="activateNode(node,$event)" @keydown.enter.prevent="activateNode(node,$event)" @keydown.space.prevent="activateNode(node,$event)">
     <div class="architecture-node-head">
      <template v-if="cluster.id!=='modules'&&!node.hideIcon">
      <ProtocolIcon v-if="node.kind==='gateway'&&node.protocol" :protocol="node.protocol" :size="20" decorative class="architecture-node-icon"/>
      <BrandLogo v-else-if="node.icon==='brand'" class="architecture-node-icon"/>
      <svg v-else-if="icons[node.icon]" class="architecture-node-icon" viewBox="0 0 24 24" aria-hidden="true"><path :d="icons[node.icon]" fill="currentColor"/></svg>
      <AppIcon v-else :name="node.icon" class="architecture-node-icon"/>
      </template>
      <span class="architecture-node-name">{{node.nameKey?t(node.nameKey):node.name}}</span>
      <span class="architecture-status" :title="t(stateKey(node.state))"><AppIcon v-if="['error','blocked'].includes(node.state)" :name="node.state==='error'?'warning':'shield'"/><span v-else/></span>
     </div>
     <span class="architecture-node-detail">{{node.detailKey?t(node.detailKey,node.detailParameters):node.detail}}</span>
     <span v-if="node.country||node.kind==='gateway'" class="architecture-node-country"><span v-if="node.country">{{flag(node.country)}}</span>{{node.country?country(node.country):t('architecture.countryUnknown')}}<span class="architecture-gateway-state">{{t(node.enabled===false||node.state==='disabled'?'architecture.off':'architecture.on')}}</span></span>
     <span v-else-if="showTrafficCounters&&node.traffic&&(Number.isFinite(node.traffic.download)||Number.isFinite(node.traffic.upload))" class="architecture-node-state">{{Number.isFinite(node.traffic.download)?'↓ '+formatNetworkRate(node.traffic.download,t):''}} {{Number.isFinite(node.traffic.upload)?'↑ '+formatNetworkRate(node.traffic.upload,t):''}}</span>
     <span v-else class="architecture-node-state" :class="{problem:['error','blocked'].includes(node.state)}">{{t(node.statusKey||stateKey(node.state))}}</span>
    </button>
    </div>
   </div>
  </div>
  <AppRowMenu v-if="nodeActions" ref="mapMenu" triggerless :actions="menuActions" :disabled="actionsBusy" :label="t('Действия')" @select="value=>menuNode && emit('node-action',{node:menuNode,value})"/>
  <button class="architecture-minimap" type="button" :aria-label="t('architecture.navigate')" @click="overviewClick" @keydown.enter.prevent="fit" @keydown.space.prevent="fit">
   <svg :viewBox="`0 0 ${canvasWidth} ${canvasHeight}`" aria-hidden="true">
    <path v-for="edge in graph.edges.filter(edge=>!edge.hidden)" :key="edge.id" :d="path(edge)" class="architecture-mini-wire" :class="{'is-dns':edge.label==='DNS','is-inactive':inactiveEdge(edge)}"/>
    <rect v-for="node in graph.nodes" :key="node.id" :x="node.x" :y="node.y" :width="connectionWidth(node)" :height="nodeHeight" :class="['architecture-mini-node',node.state]" rx="16"/>
    <rect :x="-offset.x/scale" :y="-offset.y/scale" :width="viewportSize.width/scale" :height="viewportSize.height/scale" class="architecture-mini-view"/>
   </svg>
  </button>
  <div class="architecture-controls" @pointerdown.stop>
   <AppButton variant="secondary" size="s" icon-only :aria-label="t('architecture.zoomOut')" :title="t('architecture.zoomOut')" @click="zoom(1/1.2)"><svg viewBox="0 0 24 24" class="app-icon"><path :d="mdiMinus" fill="currentColor"/></svg></AppButton>
   <output aria-live="polite">{{Math.round(scale*100)}}%</output>
   <AppButton variant="secondary" size="s" icon-only :aria-label="t('architecture.zoomIn')" :title="t('architecture.zoomIn')" @click="zoom(1.2)"><svg viewBox="0 0 24 24" class="app-icon"><path :d="mdiPlus" fill="currentColor"/></svg></AppButton>
   <span class="architecture-control-divider"/>
   <AppButton variant="secondary" size="s" icon-only :aria-label="t('architecture.fit')" :title="t('architecture.fit')" @click="fit"><svg viewBox="0 0 24 24" class="app-icon"><path :d="mdiFitToScreenOutline" fill="currentColor"/></svg></AppButton>
  </div>
 </AppDataCard>
</template>
<style scoped>
.architecture-card{--architecture-neutral-wire:color-mix(in srgb,var(--color-border) 65%,transparent);position:relative;overflow:hidden;min-width:0}
.architecture-card :deep(.data-card-body){padding-bottom:0}
.architecture-search{width:320px;max-width:100%;min-width:0}
.architecture-card :deep(.data-card-actions){max-width:100%;min-width:0}
.architecture-title-icon{width:20px;height:20px;color:var(--color-text-secondary)}


.architecture-viewport{position:relative;height:760px;overflow:hidden;touch-action:none;cursor:grab;background-color:var(--color-page);background-image:radial-gradient(var(--color-border) .8px,transparent .8px);background-size:20px 20px;outline:none}
.architecture-loading{position:absolute;inset:0;z-index:5;display:grid;place-items:center;pointer-events:none}
.architecture-loading :deep(.app-spinner){width:var(--space-8);height:var(--space-8)}
.architecture-empty{position:absolute;inset:0;display:grid;place-content:center;color:var(--color-text-muted);font-size:var(--font-size-body)}
.architecture-viewport.is-dragging,.is-dragging .architecture-node{cursor:grabbing}
.architecture-world{position:absolute;inset:0 auto auto 0;width:1284px;height:810px;transform-origin:0 0;user-select:none}
.architecture-frame{position:absolute;border:1px solid var(--color-border);border-radius:calc(var(--radius-panel) + var(--radius-control));background:var(--color-secondary);box-shadow:var(--shadow-card);pointer-events:none}
.architecture-edges{position:absolute;z-index:2;inset:0;overflow:visible;pointer-events:none}
.architecture-wire{stroke:var(--color-border-accent);stroke-width:1.5;stroke-dasharray:none;fill:none}
.architecture-arrow{stroke:var(--color-border-accent);fill:none;stroke-width:1.5}
.architecture-return{opacity:.5}.architecture-flow-return{animation-direction:reverse!important;opacity:.65}
.architecture-flow{fill:none;stroke:var(--color-accent);stroke-width:2;stroke-dasharray:3 32;stroke-linecap:round;animation:architecture-flow 2s linear infinite}
.architecture-edge.error .architecture-wire,.architecture-edge.blocked .architecture-wire,.architecture-arrow.error,.architecture-arrow.blocked{stroke:var(--color-danger)}
.architecture-edge.disabled .architecture-wire,.architecture-edge.offline .architecture-wire{stroke:var(--architecture-neutral-wire)}
.architecture-edge.unknown .architecture-wire,.architecture-edge.policy .architecture-wire{stroke:var(--architecture-neutral-wire)}
.architecture-edge.is-dns .architecture-wire,.architecture-edge.is-dns .architecture-flow,.architecture-arrow.dns{stroke:var(--color-success)}
.architecture-edge.is-inactive .architecture-wire{stroke:var(--architecture-neutral-wire)}
.architecture-edge.is-inactive .architecture-flow{display:none}
.architecture-arrow.unknown,.architecture-arrow.policy,.architecture-arrow.disabled,.architecture-arrow.offline{stroke:var(--architecture-neutral-wire)}
.architecture-column-title{display:flex;align-items:center;justify-content:space-between;gap:var(--space-2);position:absolute;top:var(--space-12);width:180px;padding-block:var(--space-2);font-size:var(--font-size-body);font-weight:500;color:var(--color-text-muted);pointer-events:none}
.architecture-column-title .app-button{pointer-events:auto;flex:none;transition:background-color .15s,color .15s}
.architecture-column-title .app-button:is(:hover,:focus-visible):not(:disabled){background:var(--color-accent-soft);color:var(--color-accent)}
.architecture-node{position:absolute;z-index:3;width:180px;height:94px;display:flex;flex-direction:column;align-items:stretch;gap:var(--space-1);padding:var(--space-3);border:1px solid var(--color-border);border-radius:var(--radius-panel);background:var(--color-surface);color:var(--color-text-primary);box-shadow:0 2px 5px #00000008;cursor:pointer;text-align:left;transition:border-color .16s,box-shadow .16s,opacity .16s;white-space:normal;font-family:inherit;line-height:1.35;min-height:0}
.architecture-node:hover,.architecture-node.is-selected{border-color:var(--color-accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--color-accent) 12%,transparent)}
.architecture-node.error,.architecture-node.blocked{border-color:color-mix(in srgb,var(--color-danger) 60%,var(--color-border))}
.architecture-node.error{box-shadow:0 0 0 3px color-mix(in srgb,var(--color-danger) 7%,transparent)}
.architecture-node.disabled,.architecture-node.offline{background:var(--color-secondary);border-style:dashed}
.architecture-gateway-wrap{position:absolute;z-index:1;padding:var(--space-2);border:1px solid var(--color-border);border-radius:var(--radius-panel);background:var(--color-secondary);cursor:pointer}
.architecture-node-cluster{display:contents}
.architecture-group-surface{position:absolute;z-index:1;border:1px solid var(--color-border);border-radius:var(--radius-panel);background:var(--color-surface);box-shadow:0 2px 5px #00000008;pointer-events:none}
.architecture-node-group>.architecture-node{border:1px solid transparent;border-radius:0;background:transparent;box-shadow:none}
.architecture-node-group>.architecture-node+.architecture-node{border-top:1px solid var(--color-border-subtle)}
.architecture-node-group>.architecture-node:first-of-type{border-radius:var(--radius-panel) var(--radius-panel) 0 0}
.architecture-node-group>.architecture-node:last-of-type{border-radius:0 0 var(--radius-panel) var(--radius-panel)}
.architecture-node-group>.architecture-node:only-of-type{border-radius:var(--radius-panel)}
.architecture-node-group>.architecture-node:hover{background:var(--color-secondary-hover);box-shadow:none}
.architecture-node-group>.architecture-node.is-selected{background:var(--color-accent-soft);box-shadow:none}
.architecture-node-head{display:flex;height:var(--space-5);flex-shrink:0;align-items:center;gap:var(--space-2);min-width:0}
.architecture-node-icon{width:20px;height:20px;flex:none;color:var(--color-text-secondary)}
.architecture-node-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:var(--font-size-body);font-weight:500;flex:1}
.architecture-status{display:flex;color:var(--color-success);flex:none}.architecture-status>span{width:7px;height:7px;border-radius:var(--radius-pill);background:var(--color-success)}
.error .architecture-status,.blocked .architecture-status{color:var(--color-danger)}.architecture-status .app-icon{width:14px;height:14px}
.architecture-status.unknown>span,.architecture-status.disabled>span,.architecture-status.offline>span,.unknown .architecture-status>span,.policy .architecture-status>span,.disabled .architecture-status>span,.offline .architecture-status>span{background:var(--color-border-subtle)}
.architecture-node-detail,.architecture-node-state,.architecture-node-country{font-size:var(--font-size-11);color:var(--color-text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.architecture-node-detail{margin-top:var(--space-1)}.architecture-node-country{display:flex;align-items:center;gap:var(--space-1);color:var(--color-text-secondary)}
.architecture-node-country>span:first-child{font-size:var(--font-size-body)}
.architecture-gateway-state{margin-left:auto;font-size:var(--font-size-10);color:var(--color-text-muted)}
.architecture-node-state.problem{color:var(--color-danger)}
.architecture-rate{position:absolute;z-index:4;transform-origin:0 0;transform:translate(-50%,-50%);display:flex;flex-direction:column;gap:0;min-width:72px;padding:var(--space-1) var(--space-2);background:color-mix(in srgb,var(--color-surface) 97%,transparent);border:1px solid var(--color-border-subtle);border-radius:var(--radius-control);font-size:var(--font-size-10);font-variant-numeric:tabular-nums;pointer-events:none;color:var(--color-text-secondary);transition:opacity .16s}
.architecture-rate.is-dns{min-width:0}
.architecture-counter-enter-active,.architecture-counter-leave-active{transition:opacity .16s ease,transform .16s ease}
.architecture-counter-enter-from,.architecture-counter-leave-to{opacity:0;transform:translate(-50%,calc(-50% + var(--space-2)))}
.architecture-rate>span{display:flex;align-items:center;gap:var(--space-1)}.architecture-rate .app-icon{width:12px;height:12px;color:var(--color-accent)}.architecture-rate>span+span .app-icon{color:var(--color-text-muted)}.architecture-rate small{font-size:inherit;color:var(--color-text-muted)}
.architecture-rate.error,.architecture-rate.blocked{color:var(--color-danger)}.architecture-rate.error .app-icon,.architecture-rate.blocked .app-icon{color:inherit}
.architecture-minimap{position:absolute;bottom:var(--space-4);left:var(--space-4);width:140px;height:76px;padding:var(--space-1);border:1px solid var(--color-border);border-radius:var(--radius-control);background:var(--color-surface);overflow:hidden;cursor:crosshair}
.architecture-minimap svg{display:block;width:100%;height:100%;overflow:hidden}.architecture-mini-wire{stroke:var(--architecture-neutral-wire);stroke-width:8;fill:none}.architecture-mini-node{fill:var(--color-border-accent)}.architecture-mini-node.error,.architecture-mini-node.blocked{fill:var(--color-danger)}.architecture-mini-node.unknown,.architecture-mini-node.policy,.architecture-mini-node.disabled,.architecture-mini-node.offline{fill:var(--color-border)}.architecture-mini-view{fill:color-mix(in srgb,var(--color-accent) 8%,transparent);stroke:var(--color-accent);stroke-width:12}
.architecture-mini-wire.is-dns{stroke:var(--color-success)}
.architecture-mini-wire.is-inactive{stroke:var(--architecture-neutral-wire)}
.architecture-controls{position:absolute;bottom:var(--space-4);right:var(--space-4);display:flex;align-items:center;gap:var(--space-2);padding:var(--space-2);border:1px solid var(--color-border);border-radius:var(--radius-control);background:var(--color-surface);box-shadow:var(--shadow-card)}
.architecture-controls output{min-width:44px;text-align:center;font-size:var(--font-size-caption);color:var(--color-text-secondary);font-variant-numeric:tabular-nums}.architecture-controls .app-button{border:0;background:transparent}.architecture-control-divider{width:1px;height:16px;background:var(--color-border)}
.is-dim{opacity:.17}.architecture-edge{transition:opacity .16s}
@keyframes architecture-flow{to{stroke-dashoffset:-70}}
@media(prefers-reduced-motion:reduce){.architecture-flow{animation:none}.architecture-node,.architecture-rate,.architecture-edge{transition:none}.architecture-counter-enter-from,.architecture-counter-leave-to{transform:translate(-50%,-50%)}}
@media(max-width:700px){.architecture-card :deep(.data-card-head){flex-direction:column;align-items:stretch}.architecture-card :deep(.data-card-actions){width:100%;justify-content:stretch}.architecture-search{width:100%}.architecture-viewport{height:540px}.architecture-controls{bottom:var(--space-3);right:var(--space-3)}.architecture-minimap{left:var(--space-3);bottom:var(--space-3);width:92px;height:52px}}
</style>
