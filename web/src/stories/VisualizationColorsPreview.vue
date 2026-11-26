<script setup>
import {computed,nextTick,onMounted,ref,watch} from 'vue';
import {area,curveMonotoneX,line,scaleLinear} from 'd3';
import ProxyLatency from '../components/ProxyLatency.vue';
import {usePreferences} from '../preferences.js';

const props=defineProps({compare:Boolean,mode:{type:String,default:'all'}});
const {t,theme}=usePreferences();
const root=ref(),values=ref({});
const themes=computed(()=>props.compare?['light','dark']:[theme.value]);
const colors=[{key:'blue',name:'Синий'},{key:'teal',name:'Бирюзовый'},{key:'violet',name:'Фиолетовый'},{key:'amber',name:'Янтарный'},{key:'rose',name:'Розовый'},{key:'lime',name:'Лаймовый'}];
const shades=[{key:'',name:'chart.shade.base'},{key:'-strong',name:'chart.shade.strong'},{key:'-soft',name:'chart.shade.soft'},{key:'-subtle',name:'chart.shade.subtle'}];
const token=(color,shade='')=>'--chart-'+color+shade;
async function readValues(){
 await nextTick();if(!root.value)return;
 const next={};
 for(const element of root.value.querySelectorAll('[data-chart-theme]')) {
  const style=getComputedStyle(element),mode=element.dataset.chartTheme;
  next[mode]={surface:style.getPropertyValue('--color-surface').trim()};for(const color of colors)for(const shade of shades)next[mode][token(color.key,shade.key)]=style.getPropertyValue(token(color.key,shade.key)).trim();
 }
 values.value=next;
}
onMounted(readValues);watch(themes,readValues);
function contrast(color,mode) {
 const hex=values.value[mode]?.[token(color)];if(!hex)return '—';
 const luminance=hex=>{const rgb=hex.match(/[\da-f]{2}/gi).map(value=>parseInt(value,16)/255).map(value=>value<=.04045?value/12.92:((value+.055)/1.055)**2.4);return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722;};
 const first=luminance(hex),second=luminance(values.value[mode].surface);
 return ((Math.max(first,second)+.05)/(Math.min(first,second)+.05)).toFixed(1)+':1';
}
const x=scaleLinear().domain([0,23]).range([12,548]),y=scaleLinear().domain([0,100]).range([168,12]);
const series=colors.slice(0,3).map((color,index)=>{
 const samples=Array.from({length:24},(_,i)=>({x:i,y:23+index*24+Math.sin(i/2.8+index)*9+Math.cos(i/1.5)*3}));
 return {...color,dash:['','8 4','2 4'][index],path:line().x(d=>x(d.x)).y(d=>y(d.y)).curve(curveMonotoneX)(samples),end:samples.at(-1)};
});
const areaPath=area().x(d=>x(d.x)).y0(168).y1(d=>y(d.y)).curve(curveMonotoneX)(Array.from({length:24},(_,i)=>({x:i,y:38+Math.sin(i/3)*18+i*.8})));
const areaLine=line().x(d=>x(d.x)).y(d=>y(d.y)).curve(curveMonotoneX)(Array.from({length:24},(_,i)=>({x:i,y:38+Math.sin(i/3)*18+i*.8})));
const timestamp=Date.UTC(2026,0,1,12);
const metric={httpStatus:'ok',ping:42,measuredAt:new Date(timestamp+23000).toISOString(),httpHistory:Array.from({length:24},(_,i)=>({time:new Date(timestamp+i*1000).toISOString(),delay:30+(i*13)%41})),udp:{status:'ok',delay:29,measuredAt:new Date(timestamp+23000).toISOString()}};
const bars=colors.map((color,index)=>({...color,value:[74,58,86,46,65,92][index]}));
</script>
<template>
 <div ref="root" class="viz-preview" :class="{'viz-compare':compare}">
  <section v-for="mode in themes" :key="mode" :data-chart-theme="mode" :data-ui-theme="mode" class="viz-surface">
   <header class="viz-header"><h2>{{t(mode==='light'?'Светлая тема':'Тёмная тема')}}</h2><p>{{t('Палитра визуализаций')}} · {{t('Непрозрачность 100%')}}</p></header>
   <template v-if="['all','palette'].includes(props.mode)">
    <div class="viz-palette">
     <article v-for="color in colors" :key="color.key" class="viz-color-card" :data-color-family="color.key">
      <h3>{{t(color.name)}}</h3><code class="viz-token">{{token(color.key)}}</code>
      <div class="viz-shades">
       <div v-for="shade in shades" :key="shade.key" class="viz-shade">
        <div class="viz-swatch" :style="{background:`var(${token(color.key,shade.key)})`}" :data-color-token="token(color.key,shade.key)" :aria-label="t(color.name)+' · '+t(shade.name)" role="img" />
        <span>{{t(shade.name)}}</span><code>{{values[mode]?.[token(color.key,shade.key)] || '—'}}</code>
       </div>
      </div>
      <p class="viz-contrast">{{t('Контраст основного цвета на карточке')}}: {{contrast(color.key,mode)}}</p>
     </article>
    </div>
    <p class="viz-note">{{t('Основной цвет и акцент — для линий и маркеров. Заливка и фон — для областей и подложек. Все оттенки заданы сплошным HEX, без прозрачности.')}}</p>
   </template>
   <div v-if="['all','examples'].includes(props.mode)" class="viz-examples">
    <section class="viz-example">
     <h3>{{t('Несколько рядов')}}</h3>
     <svg viewBox="0 0 560 180" role="img" :aria-label="t('Пример линейного графика')">
      <path d="M12 12H548M12 64H548M12 116H548M12 168H548" class="viz-grid" />
      <g v-for="item in series" :key="item.key" :style="{color:`var(${token(item.key)})`}">
       <path :d="item.path" class="viz-line" :stroke-dasharray="item.dash" />
       <circle v-if="item.key==='blue'" :cx="x(item.end.x)" :cy="y(item.end.y)" r="4" fill="currentColor" />
       <rect v-else-if="item.key==='teal'" :x="x(item.end.x)-4" :y="y(item.end.y)-4" width="8" height="8" fill="currentColor" />
       <path v-else :d="`M${x(item.end.x)},${y(item.end.y)-5}l5 5-5 5-5-5Z`" fill="currentColor" />
      </g>
     </svg>
     <div class="viz-legend"><span v-for="item in series" :key="item.key"><i :style="{background:`var(${token(item.key)})`}" />{{t(item.name)}}</span></div>
    </section>
    <section class="viz-example">
     <h3>{{t('Область и линия')}}</h3>
     <svg viewBox="0 0 560 180" role="img" :aria-label="t('Пример графика с заливкой')">
      <path d="M12 12H548M12 64H548M12 116H548M12 168H548" class="viz-grid" />
      <path :d="areaPath" fill="var(--chart-teal-soft)" /><path :d="areaLine" class="viz-line" stroke="var(--chart-teal)" />
     </svg>
     <code class="viz-token">--chart-teal + --chart-teal-soft</code>
    </section>
    <section class="viz-example viz-categories">
     <h3>{{t('Категории')}}</h3>
     <div v-for="item in bars" :key="item.key" class="viz-bar-row"><span>{{t(item.name)}}</span><div :style="{background:`var(${token(item.key,'-subtle')})`}"><i :style="{width:item.value+'%',background:`var(${token(item.key)})`}" /></div><span>{{item.value}}</span></div>
    </section>
   </div>
   <section v-if="['all','ping'].includes(props.mode)" class="viz-example">
    <h3>{{t('Цвета графиков пинга')}}</h3>
    <ProxyLatency :metric="metric" />
    <div class="viz-ping-samples"><div><span>HTTP · --chart-teal</span><div class="viz-spark" aria-hidden="true"><i v-for="index in 24" :key="index" :style="{height:(25+(index*19)%75)+'%',background:'var(--chart-teal)'}" /></div></div><div><span>UDP · --chart-violet</span><div class="viz-spark" aria-hidden="true"><i v-for="index in 24" :key="index" :style="{height:(25+(index*11)%75)+'%',background:'var(--chart-violet)'}" /></div></div></div>
   </section>
   <p v-if="props.mode!=='palette'" class="viz-note">{{t('Примеры используют демонстрационные данные. Ряды различаются также подписями, маркерами и типом линии.')}}</p>
  </section>
 </div>
</template>
<style scoped>
.viz-preview{display:grid;gap:var(--space-6);min-width:0;max-width:1400px}
.viz-compare{grid-template-columns:repeat(2,minmax(0,1fr))}
.viz-surface{--viz-surface:var(--color-surface);--viz-text:var(--color-text-primary);--viz-muted:var(--color-text-secondary);--viz-border:var(--color-border);display:grid;align-content:start;gap:var(--space-6);background:var(--viz-surface);color:var(--viz-text);border:1px solid var(--viz-border);border-radius:var(--radius-panel);padding:var(--space-6);min-width:0}
.viz-header{margin:0;display:grid;gap:var(--space-2)}
.viz-header h2{font-size:var(--font-size-20);margin:0}.viz-header p,.viz-note,.viz-contrast{margin:0;color:var(--viz-muted);font-size:var(--font-size-body);line-height:1.6}
.viz-palette{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,280px),1fr));gap:var(--space-4)}
.viz-color-card{border:1px solid var(--viz-border);border-radius:var(--radius-control);padding:var(--space-4);display:grid;gap:var(--space-3);min-width:0}
.viz-color-card h3,.viz-example h3{font-size:var(--font-size-16);margin:0;color:var(--viz-text)}
.viz-token{font-size:var(--font-size-body);color:var(--viz-muted);overflow-wrap:anywhere}
.viz-shades{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:var(--space-2)}
.viz-shade{display:grid;gap:var(--space-2);min-width:0}.viz-shade span,.viz-shade code{font-size:var(--font-size-body);overflow-wrap:anywhere}.viz-shade code{color:var(--viz-muted);user-select:all}
.viz-swatch{height:var(--space-12);border-radius:var(--radius-control);border:1px solid var(--viz-border)}
.viz-examples{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,280px),1fr));gap:var(--space-4)}
.viz-example{display:grid;align-content:start;gap:var(--space-4);min-width:0;border:1px solid var(--viz-border);border-radius:var(--radius-control);padding:var(--space-4)}
.viz-example svg{display:block;width:100%;height:auto}.viz-grid{fill:none;stroke:var(--viz-border);stroke-width:1;vector-effect:non-scaling-stroke}.viz-line{fill:none;stroke:currentColor;stroke-width:2;vector-effect:non-scaling-stroke}.viz-line[stroke]{stroke:var(--chart-teal)}
.viz-legend{display:flex;gap:var(--space-3);flex-wrap:wrap;font-size:var(--font-size-body)}.viz-legend span{display:flex;align-items:center;gap:var(--space-2)}.viz-legend i{width:var(--space-3);height:var(--space-3);border-radius:var(--radius-control)}
.viz-bar-row{display:grid;grid-template-columns:calc(var(--space-12)*2) minmax(0,1fr) var(--space-8);align-items:center;gap:var(--space-2);font-size:var(--font-size-body)}.viz-bar-row>div{height:var(--space-4);border-radius:var(--radius-control);overflow:hidden}.viz-bar-row i{display:block;height:100%;border-radius:var(--radius-control)}
.viz-example :deep(.proxy-latency){max-inline-size:100%}
.viz-ping-samples{display:grid;gap:var(--space-4)}.viz-ping-samples>div{display:grid;gap:var(--space-2);font-size:var(--font-size-body)}.viz-spark{display:flex;align-items:end;gap:var(--space-1);height:var(--space-8)}.viz-spark i{display:block;flex:1;min-width:0;border-radius:var(--radius-control)}
@media(max-width:900px){.viz-compare{grid-template-columns:minmax(0,1fr)}}
</style>
