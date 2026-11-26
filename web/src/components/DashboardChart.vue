<script setup>
import {computed,ref,onMounted,onUnmounted,watch,nextTick,useId} from 'vue';
import {scaleLinear,line,curveMonotoneX,max,bisector} from 'd3';
import {usePreferences} from '../preferences.js';
const props=defineProps({samples:{type:Array,default:()=>[]},series:{type:Array,required:true},label:String,percent:Boolean,dynamic:Boolean,count:Boolean,windowMs:{type:Number,default:300000}});
const {locale}=usePreferences();
const tooltipId=useId(),tooltip=ref(),tooltipWidth=ref(180),actualWidth=ref(600),activeTime=ref(null);const element=ref(),width=ref(600);const height=180,left=60,right=12,top=12,bottom=28;
function outside(event){if(!element.value?.contains(event.target))activeTime.value=null;}
function leave(event){if(event.pointerType!=='touch')activeTime.value=null;}
let observer;onMounted(()=>{window.addEventListener('pointerdown',outside);observer=new ResizeObserver(([entry])=>{actualWidth.value=entry.contentRect.width;width.value=Math.max(240,Math.floor(entry.contentRect.width));});observer.observe(element.value);});onUnmounted(()=>{observer?.disconnect();window.removeEventListener('pointerdown',outside);});
const y=computed(()=>scaleLinear().domain([0,props.percent && !props.dynamic?100:Math.max(props.percent || props.count?1:1024,max(props.samples,sample=>max(props.series,series=>sample[series.key])) || 0)]).nice().range([height-bottom,top]));
const x=computed(()=>{const end=props.samples.at(-1)?.time || Date.now();return scaleLinear().domain([end-props.windowMs,end]).range([left,width.value-right]);});
const paths=computed(()=>props.series.map(series=>({...series,path:line().curve(curveMonotoneX).defined(sample=>Number.isFinite(sample[series.key])).x(sample=>x.value(sample.time)).y(sample=>y.value(sample[series.key]))(props.samples) || ''})));
const amount=value=>{if(!Number.isFinite(value))return '—';if(props.percent)return Math.round(value)+'%';if(props.count)return new Intl.NumberFormat(locale.value,{maximumFractionDigits:0}).format(value);const units=['B/s','KB/s','MB/s','GB/s'];let index=0;while(value>=1024 && index<3){value/=1024;index++;}return Number(value.toFixed(index?1:0))+' '+units[index];};
const ticks=computed(()=>x.value.ticks(3));
const selected=computed(()=>props.samples.find(sample=>sample.time===activeTime.value));
const tooltipLeft=computed(()=>Math.max(8,Math.min(actualWidth.value-tooltipWidth.value-8,x.value(selected.value?.time || 0)/width.value*actualWidth.value+12)));
watch([selected,locale],async()=>{await nextTick();if(tooltip.value)tooltipWidth.value=tooltip.value.offsetWidth;});
function point(event){
 const rect=event.currentTarget.getBoundingClientRect();
 const px=(event.clientX-rect.left)/rect.width*width.value,py=(event.clientY-rect.top)/rect.height*height;
 if(!props.samples.length || px<left || px>width.value-right || py<top || py>height-bottom){activeTime.value=null;return;}
 const index=bisector(sample=>sample.time).center(props.samples,x.value.invert(px));
 activeTime.value=props.samples[index]?.time ?? null;
}
function key(event){
 if(event.key==='Escape'){activeTime.value=null;return;}
 if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key) || !props.samples.length)return;
 event.preventDefault();
 const current=props.samples.findIndex(sample=>sample.time===activeTime.value);
 const index=event.key==='Home'?0:event.key==='End'?props.samples.length-1:current<0?props.samples.length-1:Math.max(0,Math.min(props.samples.length-1,current+(event.key==='ArrowLeft'?-1:1)));
 activeTime.value=props.samples[index].time;
}

</script>
<template>
 <div ref="element" class="dashboard-chart">
  <svg :viewBox="`0 0 ${width} 180`" role="img" :aria-label="label" :aria-describedby="selected?tooltipId:undefined" tabindex="0" preserveAspectRatio="none" @pointermove="point" @pointerdown="point" @pointerleave="leave" @pointercancel="activeTime=null" @blur="activeTime=null" @keydown="key">
   <g v-for="tick in y.ticks(3).filter(tick=>!count || Number.isInteger(tick))" :key="tick"><line :x1="left" :x2="width-right" :y1="y(tick)" :y2="y(tick)" class="dashboard-grid"/><text :x="left-8" :y="y(tick)+4" text-anchor="end">{{amount(tick)}}</text></g>
   <text v-for="tick in ticks" :key="tick" :x="x(tick)" :y="height-5" text-anchor="middle">{{new Date(tick).toLocaleTimeString(locale,{...(windowMs>=86400000?{month:'short',day:'numeric'}:{}),hour:'2-digit',minute:'2-digit'})}}</text>
   <path v-for="series in paths" :key="series.key" :d="series.path" :class="'dashboard-line series-'+series.color"/>
   <g v-if="selected" class="dashboard-selection" pointer-events="none">
    <line :x1="x(selected.time)" :x2="x(selected.time)" :y1="top" :y2="height-bottom" class="dashboard-cursor" />
    <template v-for="item in series" :key="item.key"><circle v-if="Number.isFinite(selected[item.key])" :cx="x(selected.time)" :cy="y(selected[item.key])" r="3" :class="'dashboard-point series-'+item.color" /></template>
   </g>
  </svg>
  <div v-if="selected" :id="tooltipId" ref="tooltip" role="tooltip" class="dashboard-tooltip" :style="{left:tooltipLeft+'px'}">
   <time>{{new Date(selected.time).toLocaleTimeString(locale,{hour:'2-digit',minute:'2-digit',second:'2-digit'})}}</time>
   <div v-for="item in series" :key="item.key"><span>{{item.label || label}}</span><b>{{amount(selected[item.key])}}</b></div>
  </div>
  <div v-if="series.length>1" class="dashboard-legend"><span v-for="item in series" :key="item.key"><i :class="'series-'+item.color"/>{{item.label}}</span></div>
 </div>
</template>
<style scoped>
.dashboard-chart{min-width:0;position:relative}.dashboard-chart svg{display:block;width:100%;height:180px;overflow:visible}.dashboard-chart text{fill:var(--color-text-secondary);font-size:var(--font-size-chart-label)}.dashboard-grid{stroke:var(--color-divider);stroke-width:1}.dashboard-line{fill:none;stroke-width:2;vector-effect:non-scaling-stroke}.series-primary{stroke:var(--color-primary);background:var(--color-primary)}.series-secondary{stroke:var(--color-text-secondary);background:var(--color-text-secondary)}.dashboard-legend{display:flex;gap:var(--space-4);justify-content:center;color:var(--color-text-secondary);font-size:var(--font-size-body)}.dashboard-legend span{display:flex;align-items:center;gap:var(--space-2)}.dashboard-legend i{width:var(--space-3);height:var(--space-1);border-radius:var(--radius-pill)}
.dashboard-cursor{stroke:var(--color-text-secondary);stroke-width:1;stroke-dasharray:3 3}
.dashboard-point{fill:var(--color-page);stroke-width:2}
.dashboard-tooltip{position:absolute;top:var(--space-2);z-index:1;pointer-events:none;max-width:calc(100% - var(--space-4));padding:var(--space-3);border:1px solid var(--color-divider);border-radius:var(--radius-control);background:var(--color-surface);color:var(--color-text-primary);box-shadow:var(--shadow-card);font-size:var(--font-size-body)}
.dashboard-tooltip time{display:block;color:var(--color-text-secondary);margin-bottom:var(--space-2);font-variant-numeric:tabular-nums}
.dashboard-tooltip>div{display:flex;justify-content:space-between;gap:var(--space-4)}
.dashboard-tooltip b{font-weight:500;white-space:nowrap;font-variant-numeric:tabular-nums}
</style>
