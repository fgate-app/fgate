<script setup>
import {computed,onMounted,onBeforeUnmount,ref,useId} from 'vue';
import {hierarchy,tree,linkVertical} from 'd3';
import {logicalInterface} from '../../../shared/network.js';
import {formatNetworkRate,interfaceRates} from '../lib/network-traffic.js';
import {usePreferences} from '../preferences.js';
import {mdiWifi,mdiCodeTags} from '@mdi/js';
import BrandLogo from './BrandLogo.vue';

const props=defineProps({setup:{type:Object,required:true},traffic:{type:Object,default:()=>({})}});
const {t}=usePreferences();
const container=ref(null),width=ref(300),markerId='network-arrow-'+useId();
let observer;
onMounted(()=>{
  const resize=()=>{
    const style=getComputedStyle(container.value);
    width.value=Math.max(1,container.value.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight));
  };
  resize();observer=new ResizeObserver(resize);observer.observe(container.value);
});
onBeforeUnmount(()=>observer?.disconnect());

function interfaceName(network) {
  try {return logicalInterface(network.interface,network.vlanId) || '';} catch {return '';}
}
const graph=computed(()=>{
  const setup=props.setup;
  const networkNode=(network,id)=>({id,icon:network.type==='ap'?'wifi':'wired',interface:interfaceName(network),lines:network.type==='ap'
    ? [t('Wi-Fi'),network.ssid || '—',network.interface || '—',network.subnet || '—']
    : ['Ethernet',...(network.vlanId?[`VLAN ${network.vlanId}`]:[]),interfaceName(network) || '—',network.subnet || '—'],height:120});
  const networks=[networkNode(setup.client,'primary')];
  if(setup.wired?.enabled) networks.push(networkNode({...setup.wired,type:'ethernet'},'wired'));
  const root=hierarchy({id:'uplink',icon:setup.uplink.interface?.startsWith('wl')?'wifi':'wired',interface:setup.uplink.interface,lines:[t('Вход (uplink)'),setup.uplink.interface || '—'],height:84,children:[
    {id:'gateway',lines:['FreedomGate',t('Шлюз')],height:84,children:networks}
  ]});
  const nodeWidth=Math.min(networks.length>1?(width.value-24)/2:width.value,176);
  tree().nodeSize([nodeWidth+24,184])(root);
  const nodes=root.descendants().map(node=>({...node.data,x:node.x+width.value/2,y:node.y+44,width:node.depth===2?nodeWidth:Math.min(width.value,176)}));
  const byId=new Map(nodes.map(node=>[node.id,node]));
  const connector=linkVertical().x(point=>point.x).y(point=>point.y);
  const links=root.links().map(link=>{
    const parent=byId.get(link.source.data.id),child=byId.get(link.target.data.id);
    const top=parent.y+parent.height/2+3,bottom=child.y-child.height/2-3;
    const paths=[-5,5].map((offset,index)=>{
      const source={x:parent.x+offset,y:top},target={x:child.x+offset,y:bottom};
      return connector(index===0?{source:target,target:source}:{source,target});
    });
    const iface=child.id==='gateway'?setup.uplink.interface:child.interface;
    const rates=interfaceRates(props.traffic,iface,child.id==='gateway');
    const labels=[`↑ ${formatNetworkRate(rates.upload,t)}`,`↓ ${formatNetworkRate(rates.download,t)}`];
    return {id:child.id,interface:iface,hasTraffic:[rates.upload,rates.download].some(value=>Number.isFinite(value) && value>=0),labels,x:child.x,y:(top+bottom)/2,width:Math.min(nodeWidth,144),
      paths};
  });
  return {nodes,links,description:nodes.map(node=>node.lines.join(', ')).join('; ')};
});
function fitted(text,nodeWidth) {
  // Keep text at the design-system size even in the narrow sidebar. The full
  // value stays in the native tooltip and in the parameters below the graph.
  const available=Math.max(0,nodeWidth-24);
  const characters=Array.from(String(text));
  const advance=character=>/[\u3000-\u9fff\uff00-\uffef]|\p{Extended_Pictographic}/u.test(character)?13:7.2;
  if(characters.reduce((sum,character)=>sum+advance(character),0)<=available)return text;
  let result='',used=0;
  for(const character of characters) {
    used+=advance(character);
    if(used>available-8)break;
    result+=character;
  }
  return result+'…';
}
</script>
<template>
  <figure ref="container" class="network-topology" data-testid="network-topology">
    <svg :viewBox="`0 0 ${width} 480`" role="img" :aria-label="t('Схема сети')+': '+graph.description" focusable="false">
      <defs><marker :id="markerId" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M1 1L7 4L1 7" /></marker></defs>
      <g v-for="link in graph.links" :key="link.id" class="network-topology-connection">
        <path v-for="(path,index) in link.paths" :key="index" :d="path" class="network-topology-link" :marker-end="`url(#${markerId})`" />
      </g>
      <g v-for="link in graph.links.filter(link=>link.hasTraffic)" :key="'traffic-'+link.id" :data-traffic-interface="link.interface || ''" :transform="`translate(${link.x},${link.y})`" class="network-link-traffic">
        <title>{{t('Трафик интерфейса')}} {{link.interface || '—'}}: {{t('Отправка')}} {{link.labels[0]}} · {{t('Приём')}} {{link.labels[1]}}</title>
        <rect :x="-link.width/2" y="-21" :width="link.width" height="42" />
        <text x="0" y="-8" text-anchor="middle" dominant-baseline="middle">{{fitted(link.labels[0],link.width)}}</text>
        <text x="0" y="10" text-anchor="middle" dominant-baseline="middle">{{fitted(link.labels[1],link.width)}}</text>
      </g>
      <g v-for="node in graph.nodes" :key="node.id" :data-network-node="node.id" :transform="`translate(${node.x},${node.y})`" :class="{'network-topology-gateway':node.id==='gateway'}">
        <title>{{node.lines.join(' · ')}}</title>
        <rect :x="-node.width/2" :y="-node.height/2" :width="node.width" :height="node.height" />
        <foreignObject v-if="node.id==='gateway'" :x="-12" :y="-node.height/2+8" width="24" height="24" class="network-topology-brand"><BrandLogo /></foreignObject>
        <svg v-else x="-12" :y="-node.height/2+8" width="24" height="24" viewBox="0 0 24 24" preserveAspectRatio="xMidYMid meet" class="network-topology-icon" aria-hidden="true"><path :d="node.icon==='wifi'?mdiWifi:mdiCodeTags" fill="currentColor" /><g v-if="node.icon==='wired'" fill="currentColor"><circle cx="9" cy="12" r=".7"/><circle cx="12" cy="12" r=".7"/><circle cx="15" cy="12" r=".7"/></g></svg>
        <text v-for="(line,index) in node.lines" :key="index" :y="10+(index-(node.lines.length-1)/2)*18" :class="{'network-topology-label':index===0}" text-anchor="middle" dominant-baseline="middle">{{fitted(line,node.width)}}</text>
      </g>
    </svg>
  </figure>
</template>
<style scoped>
.network-topology{display:grid;gap:var(--space-3);padding:0;margin:0;min-width:0}
.network-topology>svg{display:block;width:100%;height:auto;overflow:visible}
.network-topology-icon{color:var(--palette-30)}
.network-topology-brand :deep(.brand-logo){display:block;width:24px;height:24px;color:var(--palette-30)}
.network-topology-brand :deep(svg){display:block;width:100%;height:100%}
.network-topology rect{fill:var(--color-accent-soft);stroke:var(--palette-30);rx:calc(var(--radius-control) * 1.5)}
.network-link-traffic rect{fill:color-mix(in srgb,var(--color-surface) 96%,transparent);stroke:var(--color-border-subtle);rx:calc(var(--radius-control) * 1.5)}
.network-topology text{fill:var(--color-accent);font-size:var(--font-size-body)}
.network-topology .network-link-traffic text{fill:var(--color-text-secondary)}
.network-topology .network-topology-label{fill:var(--palette-30);font-weight:500}
.network-topology-link,.network-topology marker path{fill:none;stroke:var(--color-primary);stroke-width:1.5;vector-effect:non-scaling-stroke}
</style>
