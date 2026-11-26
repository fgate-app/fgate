<script setup>
import AppTableValue from './AppTableValue.vue';
import {computed,ref,watch} from 'vue';
import {max,scaleBand,scaleLinear} from 'd3';
import {latencyHistoryLimit,loadLatencyHistory,mergeLatencySamples,saveLatencyHistory} from '../lib/latency-history.js';
import {usePreferences} from '../preferences.js';
const props=defineProps({metric:Object,historyKey:String});
const {t,locale}=usePreferences();
const history=ref({http:[],udp:[]});
const limit=latencyHistoryLimit,width=96,height=12;
function sample(status,delay,time){
 return time && ['ok','error','timeout'].includes(status)?[{time,delay:status==='ok' && delay>0?delay:null}]:[];
}
watch(()=>props.historyKey,id=>{history.value=loadLatencyHistory(id);},{immediate:true});
watch([()=>props.metric,()=>props.historyKey],([metric])=>{
 const next={
  http:mergeLatencySamples(history.value.http,metric?.httpHistory,sample(metric?.httpStatus || (metric?.ping?'ok':'unmeasured'),metric?.ping,metric?.measuredAt)),
  udp:mergeLatencySamples(history.value.udp,sample(metric?.udp?.status,metric?.udp?.delay,metric?.udp?.measuredAt))
 };
 if(JSON.stringify(next)===JSON.stringify(history.value))return;
 history.value=next;
 saveLatencyHistory(props.historyKey,next);
},{immediate:true,deep:true});
const charts=computed(()=>['http','udp'].map(protocol=>{
 const samples=protocol==='udp' && props.metric?.udp?.status==='unsupported'?[]:history.value[protocol];
 const x=scaleBand().domain(Array.from({length:limit},(_,i)=>i)).range([0,width]).paddingInner(.25);
 const y=scaleLinear().domain([0,Math.max(1,max(samples,sample=>sample.delay) || 1)]).range([0,height]);
 return {protocol,bars:Array.from({length:limit},(_,index)=>{const sample=samples[index-(limit-samples.length)];return {time:sample?.time,delay:sample?.delay ?? null,x:x(index),width:x.bandwidth(),height:sample?.delay>0?Math.max(2,y(sample.delay)):1};})};
}));
function value(status,delay){return status==='ok' && delay>0?delay+' '+t('мс'):status==='unsupported'?'—':status==='checking'?t('Проверка'):status==='timeout'?t('Таймаут'):status==='error'?t("Failed"):'—';}
function title(sample){if(!sample.time)return '—';return new Date(sample.time).toLocaleTimeString(locale.value)+' · '+(sample.delay===null?t("Failed"):sample.delay+' '+t('мс'));}
</script>
<template>
 <span class="proxy-latency">
  <span v-for="chart in charts" :key="chart.protocol" class="latency-series">
   <svg :viewBox="`0 0 ${width} ${height}`" role="img" :aria-label="chart.protocol.toUpperCase()" :data-latency-chart="chart.protocol">
    <rect v-for="(bar,index) in chart.bars" :key="index" :x="bar.x" :y="height-bar.height" :width="bar.width" :height="bar.height" :data-sample="!!bar.time" :class="{'latency-failed':bar.delay===null}"><title>{{title(bar)}}</title></rect>
   </svg>
   <span :title="chart.protocol==='http'?[t('HTTP-проверка через прокси'),metric?.httpEndpoint].filter(Boolean).join(' · '):t(metric?.udp?.protocol==='stun'?'STUN-запрос по UDP через выбранный шлюз':'DNS-запрос по UDP через выбранный шлюз')">{{chart.protocol.toUpperCase()}}: <AppTableValue :value="chart.protocol==='http'?value(metric?.httpStatus || (metric?.ping?'ok':'unmeasured'),metric?.ping):value(metric?.udp?.status,metric?.udp?.delay)" /></span>
  </span>
 </span>
</template>
<style scoped>
.proxy-latency{display:inline-flex;flex-direction:column;inline-size:14rem;white-space:nowrap;font-variant-numeric:tabular-nums;gap:var(--space-1)}
.latency-series{display:grid;grid-template-columns:calc(var(--space-12) * 2) minmax(0,1fr);align-items:center;gap:var(--space-2)}
.latency-series svg{display:block;width:100%;height:var(--space-3)}
.latency-series [data-latency-chart="http"]{fill:var(--chart-teal)}
.latency-series [data-latency-chart="udp"]{fill:var(--chart-violet)}
.latency-series .latency-failed{fill:var(--color-text-secondary);fill-opacity:.3}
</style>
