<script setup>
import AppTableValue from '../components/AppTableValue.vue';
import {ref,computed,onMounted,watch} from 'vue';
import ConnectionDetailsDialog from '../components/ConnectionDetailsDialog.vue';
import {isInteractive} from '../lib/interactions.js';
import AppTabBar from '../components/AppTabBar.vue';
import AppTab from '../components/AppTab.vue';
import AppDataCard from '../components/AppDataCard.vue';
import AppTable from '../components/AppTable.vue';
import AppGridFilters from '../components/AppGridFilters.vue';
import AppGridFilterToggle from '../components/AppGridFilterToggle.vue';
import AppButton from '../components/AppButton.vue';
import AppIcon from '../components/AppIcon.vue';
import {usePolling} from '../composables/usePolling.js';
import {useFormFeedback} from '../composables/useFormFeedback.js';
import {usePreferences} from '../preferences.js';
const props=defineProps({api:Function,can:Function,askConfirm:Function});
const filter=defineModel({required:true});
const {t,locale}=usePreferences(),{reportError}=useFormFeedback();
const rows=ref([]),loaded=ref(false),available=ref(true),clients=ref([]),profiles=ref([]),accessPoints=ref([]),closing=ref(new Set());
const selected=ref(null);
watch(rows,value=>{if(selected.value){const current=value.find(row=>row.id===selected.value.id);if(current)selected.value=current;} });
function showDetails(row,event){if(!isInteractive(event))selected.value=row;}
const tab=computed({get:()=>['closed','blocked'].includes(filter.value.status)?filter.value.status:'active',set:status=>{filter.value={...filter.value,status};}});
const gridFilter=computed({get:()=>Object.fromEntries(Object.entries(filter.value).filter(([key])=>key!=='status')),set:value=>{filter.value={...value,status:filter.value.status};}});
const filterOpen=ref(Object.values(gridFilter.value).some(Boolean));
const filterActive=computed(()=>Object.values(gridFilter.value).some(Boolean));
watch(()=>filter.value.client,value=>{if(value)filterOpen.value=true;});
onMounted(async()=>{try{const [c,p,a]=await Promise.all([props.api('clients'),props.api('profiles'),props.api('access-points').catch(()=>[])]);accessPoints.value=a;clients.value=c.clients || [];profiles.value=p;}catch(error){reportError(error);}});
let failed=false,blockedFailed=false;
usePolling(()=>true,{interval:1000,request:signal=>props.api('connection-journal',{signal}),onData:data=>{rows.value=data.connections || [];available.value=data.available;loaded.value=true;if(tab.value==='blocked'){const missing=Object.values(data.blockedSources || {}).some(value=>value===false);if(missing && !blockedFailed)reportError('Some blocking sources are unavailable. Data may be incomplete.');blockedFailed=missing;}if(!data.available && !failed)reportError('Engine unavailable. The journal will update when connectivity is restored.');failed=!data.available;},onError:error=>{loaded.value=true;if(!failed)reportError(error);failed=true;}});
function sourceName(row){return row.sourceName || clientName(row.sourceIP);}
function stateLabel(row){return row.blocked?'Заблокировано':!row.active?'Закрыто':!available.value?'Статус неизвестен':row.clientOnline===false?'Устройство не в сети':'Открыто';}
const clientName=ip=>clients.value.find(client=>client.ip===ip)?.hostname || ip || '—';
function routeName(value){const p=profiles.value.find(p=>value===`p-${p.id.slice(0,8)}-grp`);return p?p.name:value;}
const route=row=>row.chains.map(routeName).join(' → ') || '—';
const filters=computed(()=>[
 {key:'accessPoint',label:t('Точка доступа'),options:[{value:'',label:t('Все точки доступа')},...accessPoints.value.map(point=>({value:point.id,label:t(point.name)}))]},
 {key:'accessClient',label:t('Ключ'),options:[{value:'',label:t('Все ключи')},...accessPoints.value.filter(p=>!filter.value.accessPoint || p.id===filter.value.accessPoint).flatMap(p=>p.clients.map(c=>({value:c.id,label:c.name})))]},
 ...(tab.value==='blocked'?[{key:'source',label:t('Источник блокировки'),options:[{value:'',label:t('Все источники')},{value:'route',label:t('Маршрут')},{value:'dns',label:t('DNS-фильтр')}]}]:[]),
 {key:'sourceKind',label:t('Источник соединения'),options:[{value:'',label:t('Все источники')},{value:'device',label:t('Устройства')},{value:'service',label:t('Служба')}]},
 {key:'client',label:t('Клиент'),options:[{value:'',label:t('Все клиенты')},...[...new Set([...clients.value.map(c=>c.ip),...rows.value.map(row=>row.sourceIP),filter.value.client].filter(Boolean))].map(ip=>({value:ip,label:clientName(ip)===ip?ip:`${clientName(ip)} · ${ip}`}))]},
 {key:'network',label:t('Протокол'),options:[{value:'',label:t('Все протоколы')},{value:'tcp',label:'TCP'},{value:'udp',label:'UDP'},{value:'dns',label:'DNS'}]},
 {key:'route',label:t('Маршрут'),options:[{value:'',label:t('Все маршруты')},...[...new Set([...rows.value.flatMap(row=>row.chains),filter.value.route].filter(Boolean))].map(value=>({value,label:routeName(value)}))]}
]);
const filtered=computed(()=>rows.value.filter(row=>{
 const f=filter.value,q=f.query.trim().toLocaleLowerCase();
 return (!f.accessPoint || row.accessPointId===f.accessPoint) && (!f.accessClient || row.accessClientId===f.accessClient) && (!f.sourceKind || row.sourceKind===f.sourceKind) && (!f.client || row.sourceIP===f.client) && (tab.value==='blocked'?row.blocked:!row.blocked && row.active===(tab.value==='active')) && (tab.value!=='blocked' || !f.source || row.blockSource===f.source) && (!f.network || row.network.toLowerCase()===f.network) && (!f.route || row.chains.includes(f.route)) && (!q || [row.host,row.destinationIP,row.sourceIP,clientName(row.sourceIP),row.process,row.rule,row.rulePayload,row.ruleName,route(row)].join(' ').toLocaleLowerCase().includes(q));
}));
// Render long live lists in batches to keep updates responsive.
const limit=ref(100);watch(filter,()=>limit.value=100,{deep:true});
const visible=computed(()=>filtered.value.slice(0,limit.value));
function scroll(event){const el=event.target;if(el.scrollTop+el.clientHeight>=el.scrollHeight-100)limit.value+=100;}
function bytes(value){const units=['B','KB','MB','GB'];let i=0;while(value>=1024 && i<3){value/=1024;i++;}return value.toFixed(i?1:0)+' '+units[i];}
function time(value){return value?new Date(value).toLocaleTimeString(locale.value):'—';}
function close(row){props.askConfirm(t('Разорвать соединение'),t('Это соединение будет принудительно закрыто. Приложение может подключиться снова.'),async()=>{
 closing.value=new Set([...closing.value,row.id]);
 try{await props.api('connection-journal/'+encodeURIComponent(row.id),{method:'DELETE'});const data=await props.api('connection-journal');rows.value=data.connections || [];}catch(error){reportError(error);}finally{const next=new Set(closing.value);next.delete(row.id);closing.value=next;}
},'Разорвать соединение');}
</script>
<template>
 <div class="card-stack journal-page">
  <div class="journal-tabs"><AppTabBar id="journal-tabs" v-model="tab" :label="t('Соединения')"><AppTab value="active" controls="journal-content">{{t('Открытые')}}</AppTab><AppTab value="closed" controls="journal-content">{{t('Закрытые')}}</AppTab><AppTab value="blocked" controls="journal-content">{{t('Заблокированные')}}</AppTab></AppTabBar></div>
  <div id="journal-content" role="tabpanel" :aria-labelledby="'journal-tabs-tab-'+tab">
  <AppDataCard :title="t('Соединения')" :count="filtered.length">
   <template v-if="filterOpen" #filters><AppGridFilters v-model="gridFilter" :search-label="t('Поиск соединений')" :filters="filters" /></template>
   <div class="table-wrap journal-scroll" @scroll="scroll">
    <AppTable :loading="!loaded" class="data-table journal-table" data-testid="connection-journal">
     <thead><tr><th>{{t('Назначение / приложение')}}</th><th>{{t('Клиент')}}</th><th>{{t('Протокол')}}</th><th>{{t('Правило')}}</th><th>{{t('Маршрут')}}</th><th :title="t('Накопленный трафик соединения')">{{t('Трафик, всего')}}</th><th>{{t('Состояние / время')}}</th><th class="actions-col filter-column-head"><AppGridFilterToggle :open="filterOpen" :active="filterActive" @toggle="filterOpen=!filterOpen" /></th></tr></thead>
     <tbody>
      <tr v-for="row in visible" :key="row.id" data-testid="journal-row" @click="showDetails(row,$event)">
       <td><strong class="journal-text" :title="(row.host || '—')+(row.destinationPort?':'+row.destinationPort:'')"><AppTableValue :value="row.host || '—'" /><template v-if="row.destinationPort">:{{row.destinationPort}}</template></strong><span v-if="row.process" class="journal-detail" :title="row.process">{{row.process}}</span><span v-if="row.destinationIP && row.host!==row.destinationIP" class="journal-detail" :title="row.destinationIP">{{row.destinationIP}}</span></td>
       <td><span class="journal-text" :title="sourceName(row)"><AppTableValue :value="sourceName(row)" /></span><span v-if="!row.accessPointId && sourceName(row)!==row.sourceIP && row.sourceIP" class="journal-detail">{{row.sourceIP}}</span><span v-if="row.sourceKind==='service'" class="journal-detail" data-testid="connection-service">{{t('Служебное соединение')}}</span></td>
       <td><span class="journal-text">{{row.network.toUpperCase()}}</span><span class="journal-detail">{{row.type}}</span></td>
       <td><span v-if="row.blocked" class="journal-detail" :title="t(row.ruleName)">{{t(row.blockSource==='dns'?'DNS-фильтр':'Маршрут')}} · {{t(row.ruleName)}}</span><span class="journal-text" :title="row.rule?t(row.rule):''"><AppTableValue :value="row.rule?t(row.rule):'—'" /></span><span v-if="row.rulePayload" class="journal-detail" :title="row.rulePayload">{{row.rulePayload}}</span></td>
       <td><span class="journal-text" :title="route(row)"><AppTableValue :value="route(row)" /></span></td><td class="journal-bytes">↓ {{bytes(row.download)}}<br>↑ {{bytes(row.upload)}}</td>
       <td><span class="journal-text">{{t(stateLabel(row))}}</span><span v-if="row.blocked" class="journal-detail">{{t('Попытки')}}: {{row.attempts}}</span><span class="journal-detail"><AppTableValue :value="time(row.active?row.startedAt:row.closedAt)" /></span></td>
       <td class="actions-cell"><AppButton v-if="row.active && can('profiles:write')" size="s" variant="blanc" icon-only :aria-label="t('Разорвать соединение')" :disabled="closing.has(row.id)" @click="close(row)"><AppIcon name="close" /></AppButton></td>
      </tr>
      <tr v-if="loaded && !filtered.length" class="table-empty"><td colspan="8">{{t(!available?'Движок недоступен':filterActive?'Ничего не найдено':'Соединений пока нет')}}</td></tr>
     </tbody>
    </AppTable>
   </div>
  </AppDataCard>
  </div>
 </div>
 <ConnectionDetailsDialog :open="!!selected" :connection="selected" @close="selected=null" />
</template>
<style scoped>
.journal-page,#journal-content{min-width:0}
.journal-tabs{justify-self:start;width:fit-content;max-width:100%;min-width:0}
.journal-scroll{max-height:70vh;overflow:auto}
.journal-table{width:100%;table-layout:fixed}
.journal-table th:nth-child(1){width:20%}
.journal-table th:nth-child(2){width:13%}
.journal-table th:nth-child(3){width:8%}
.journal-table th:nth-child(4){width:20%}
.journal-table th:nth-child(5){width:12%}
.journal-table th:nth-child(6){width:10%}
.journal-table th:nth-child(7){width:12%}
.journal-table th.actions-col{width:var(--space-11)}
.journal-table td{max-width:calc(var(--space-12)*6)}
.journal-text,.journal-detail{display:block;min-width:0;max-width:100%;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.journal-detail{display:block;color:var(--color-text-secondary);font-weight:400}
.journal-bytes{white-space:nowrap;font-variant-numeric:tabular-nums}
</style>
