<script setup>
import AppButton from '../components/AppButton.vue';
import AppIcon from '../components/AppIcon.vue';
import AppTableValue from '../components/AppTableValue.vue';
import {useFormFeedback} from '../composables/useFormFeedback.js';
import {computed,ref} from 'vue';
import AppGridFilters from '../components/AppGridFilters.vue';
import AppGridFilterToggle from '../components/AppGridFilterToggle.vue';
import AppDataCard from '../components/AppDataCard.vue';
import AppTable from '../components/AppTable.vue';
import {usePolling} from '../composables/usePolling.js';
import {usePreferences} from '../preferences.js';
import {eventResult,presentEvent} from '../../../shared/event-log.js';
const {reportError}=useFormFeedback();

const props=defineProps({api:{type:Function,required:true}});
const {t,locale}=usePreferences();
const events=ref([]),loaded=ref(false),error=ref('');
usePolling(()=>true,{
  interval:3000,
  request:signal=>props.api('logs',{signal}),
  onData:data=>{events.value=Array.isArray(data)?data:[];loaded.value=true;error.value='';},
  onError:()=>{loaded.value=true;if(!error.value)reportError('Could not refresh the log. Retrying automatically.');error.value='Could not refresh the log. Retrying automatically.';}
});
const filter=ref({query:'',type:'',result:''}),filterOpen=ref(false);
const filterActive=computed(()=>Boolean(filter.value.query || filter.value.type || filter.value.result));
const filters=computed(()=>[{key:'type',label:t('Тип события'),options:[{value:'',label:t('Все типы')},{value:'system',label:t('Системные')},{value:'user',label:t('Действия пользователей')}]},{key:'result',label:t('Результат'),options:[{value:'',label:t('All results')},...[299,202,200,401,403,404,409,429,500,400,0].map(status=>({value:eventResult(status),label:t(eventResult(status))}))]}]);
const eventType=event=>String(event.action).startsWith('SYSTEM ')?'system':'user';
const filtered=computed(()=>events.value.filter(event=>(!filter.value.type || eventType(event)===filter.value.type) && (!filter.value.result || eventResult(event.status)===filter.value.result) && [presentEvent(event).key,eventTitle(event),actor(event),event.detail].join(' ').toLocaleLowerCase().includes(filter.value.query.trim().toLocaleLowerCase())));
function eventTitle(event){const value=presentEvent(event),parameters={...value.parameters};for(const key of ['module','component'])if(parameters[key])parameters[key]=t(parameters[key]);return t(value.key,parameters);}
function exportLog(){
 const data={exportedAt:new Date().toISOString(),locale:locale.value,filters:{...filter.value},events:filtered.value.map(event=>({...event,title:eventTitle(event),type:eventType(event),initiator:actor(event),result:t(eventResult(event.status))}))};
 const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));
 const link=document.createElement('a');link.href=url;link.download='freedomgate-events-'+data.exportedAt.replace(/[:.]/g,'-')+'.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function timestamp(value){const date=new Date(value);return Number.isFinite(date.getTime())?date.toLocaleString(locale.value):'—';}
function actor(event){return eventType(event)==='system'?t('Система'):!event.actor?t('Без сессии'):event.actorDeleted?t('Удалённый пользователь'):event.actor;}
</script>
<template>
  <div class="card-stack" id="settings-content" role="tabpanel" :aria-labelledby="'settings-tabs-tab-'+encodeURIComponent('Логи')">
    <AppDataCard :title="t('Журнал событий')" :count="filtered.length">
      <template #actions><AppButton variant="secondary" icon-only :disabled="!loaded || !filtered.length" :aria-label="t('Export log')" :title="t('Export log')" data-testid="export-log" @click="exportLog"><AppIcon name="upload" /></AppButton></template>
      <template v-if="filterOpen" #filters><AppGridFilters v-model="filter" :search-label="t('Поиск событий')" :filters="filters" /></template>
      <div class="table-wrap">
        <AppTable :loading="!loaded" class="data-table log-table" data-testid="log-list">
          <thead><tr><th>{{t('Событие')}}</th><th>{{t('Время')}}</th><th>{{t('Инициатор')}}</th><th>{{t('Результат')}}</th><th class="actions-col filter-column-head"><AppGridFilterToggle :open="filterOpen" :active="filterActive" data-testid="toggle-log-filter" @toggle="filterOpen=!filterOpen" /></th></tr></thead>
          <tbody>
            <tr v-for="event in filtered" :key="event.id" data-testid="log-row">
              <td><strong>{{eventTitle(event)}}</strong><small v-if="presentEvent(event).detail" class="log-detail">{{presentEvent(event).detail}}</small></td>
              <td><time :datetime="event.timestamp"><AppTableValue :value="timestamp(event.timestamp)" /></time></td>
              <td>{{actor(event)}}</td>
              <td :class="event.status>=400?'log-failure':''">{{t(eventResult(event.status))}}</td><td class="actions-cell" aria-hidden="true"></td>
            </tr>
            <tr v-if="!filtered.length" class="table-empty"><td colspan="5">{{t(!loaded?'Загрузка…':filterActive?'Ничего не найдено':'Событий пока нет')}}</td></tr>
          </tbody>
        </AppTable>
      </div>
    </AppDataCard>
  </div>
</template>
<style scoped>
.log-table{width:100%}
.log-table th:first-child{width:42%}
.log-detail{display:block;font-weight:400;color:var(--color-text-secondary)}
.log-table td{overflow-wrap:anywhere}
.log-table td:nth-child(4){overflow-wrap:normal}
.log-table td.log-failure{color:var(--color-danger)}
</style>
