<script setup>
import AppTableValue from '../components/AppTableValue.vue';
import AppGridFilters from '../components/AppGridFilters.vue';
import AppGridFilterToggle from '../components/AppGridFilterToggle.vue';
import AppTable from '../components/AppTable.vue';
import {ref,computed} from 'vue';
import {usePolling} from '../composables/usePolling.js';
import {useFormAction} from '../composables/useFormAction.js';
import {useFormFeedback} from '../composables/useFormFeedback.js';
import AppDataCard from '../components/AppDataCard.vue';
import AppButton from '../components/AppButton.vue';
import AppIcon from '../components/AppIcon.vue';
import AppSwitch from '../components/AppSwitch.vue';
import AppRowMenu from '../components/AppRowMenu.vue';
import CloudAccessDialog from '../components/CloudAccessDialog.vue';
import AccessPointDialog from '../components/AccessPointDialog.vue';
import AccessPointClientsDialog from '../components/AccessPointClientsDialog.vue';
import {isInteractive} from '../lib/interactions.js';
import {usePreferences} from '../preferences.js';
const {reportError}=useFormFeedback();
const {pending:busy,run}=useFormAction();
const emit=defineEmits(['journal','clients']);
const props=defineProps(['api','can','askConfirm']);const {t}=usePreferences();
const loading=ref(true),cloudEditor=ref(false);
const points=ref([]),editor=ref(false),editing=ref(null),selected=ref(null);
const labels={draft:'Не установлено',installing:'Установка',checking:'Проверка SSH',connecting:'Подключение',active:'Работает',stopped:'Отключено',error:"Failed"};
function receive(rows){points.value=rows;loading.value=false;}
async function load(){try{receive(await props.api('access-points'));}catch(error){reportError(error);}}
let failed=false;
usePolling(()=>props.can('settings:write'),{
 interval:5000,
 request:signal=>props.api('access-points',{signal}),
 onData:rows=>{failed=false;receive(rows);},
 onError:error=>{loading.value=false;if(!failed)reportError(error);failed=true;},
 onReset:allowed=>{loading.value=!!allowed;}
});
const trafficText=value=>{const bytes=n=>{const units=['B','KB','MB','GB','TB'];let i=0;n=Number(n)||0;while(n>=1024 && i<4){n/=1024;i++;}return n.toFixed(i?1:0)+' '+units[i];};return '↓ '+bytes(value?.download)+' · ↑ '+bytes(value?.upload);};
function actions(point){if(point.managed)return [{value:'settings',label:t('Настройки')},{value:'keys',label:t('Ключи')},{value:'journal',label:t('Соединения')},{value:'clients',label:t('Клиенты')},{value:point.enabled?'disable':'enable',label:t(point.enabled?'Отключить':'Включить')}];return [{value:'keys',label:t('Ключи')},{value:'journal',label:t('Соединения')},{value:'clients',label:t('Клиенты')},{value:'credentials',label:t('Настройки SSH'),disabled:point.state==='installing'},{value:point.enabled?'disable':'install',label:t(point.enabled?'Отключить':point.platform?'Включить':'Установить'),disabled:point.state==='installing'},{value:'retry',label:t('Повторить установку'),disabled:point.state==='installing'},{value:'delete',label:t('Удалить'),danger:true,disabled:point.state==='installing'}];}
function act(fn){return run(async()=>{await fn();await load();});}
function toggle(point,enabled){
 if(busy.value)return;
 if(enabled && point.managed && (!point.cloudAddress || !point.hasCloudToken)){cloudEditor.value=true;return;}
 const previous=point.enabled;point.enabled=enabled;
 return run(async()=>{
  try{
   const install=enabled && !point.managed && !point.platform;
   await props.api('access-points/'+point.id+(install?'/install':''),{method:install?'POST':'PUT',body:JSON.stringify({enabled})});
   await load();
  }catch(error){point.enabled=previous;throw error;}
 });
}
function select(point,action){
 if(action==='journal' || action==='clients'){emit(action,point);return;}
 if(action==='keys'){selected.value=point;return;}
 if(point.managed){if(action==='settings'){cloudEditor.value=true;return;}toggle(point,action==='enable');return;}
 if(action==='credentials'){editing.value=point;editor.value=true;return;}
 if(action==='clients'){selected.value=point;return;}
 if(action==='delete'){props.askConfirm(t('Удалить точку доступа?'),point.name,()=>act(()=>props.api('access-points/'+point.id,{method:'DELETE'})));return;}
 act(()=>props.api('access-points/'+point.id+((action==='retry'||(action==='install'&&!point.platform))?'/install':''),{method:(action==='retry'||(action==='install'&&!point.platform))?'POST':'PUT',body:JSON.stringify({enabled:action!=='disable'})}));
}
const filterOpen=ref(false),filter=ref({query:''});
const filteredPoints=computed(()=>points.value.filter(point=>[point.name,point.host,point.publicPort,t(labels[point.stage || point.state] || point.state)].join(' ').toLocaleLowerCase().includes(filter.value.query.trim().toLocaleLowerCase())));
</script>
<template>
 <AppDataCard data-testid="inbound-card" :title="t('Точки доступа')" :count="filteredPoints.length">
  <template #actions><AppButton v-if="can('settings:write')" variant="secondary" icon-only :aria-label="t('Добавить точку доступа')" :disabled="busy" @click="editing=null;editor=true"><AppIcon name="plus" /></AppButton></template>
  <template v-if="filterOpen" #filters><AppGridFilters v-model="filter" :search-label="t('Поиск точек доступа')" /></template>
    <div class="table-wrap"><AppTable :loading="loading" class="data-table" data-testid="inbound-list" :aria-label="t('Точки доступа')"><thead><tr><th>{{t('Название')}}</th><th>{{t('Адрес VPS')}}</th><th>{{t('Протокол')}}</th><th>{{t('Клиенты')}}</th><th>{{t('Трафик, всего')}}</th><th>{{t('Статус')}}</th><th class="actions-col filter-column-head"><AppGridFilterToggle :open="filterOpen" :active="!!filter.query" data-testid="toggle-access-point-filter" @toggle="filterOpen=!filterOpen" /></th></tr></thead><tbody>
   <tr v-for="point in filteredPoints" :key="point.id" @click="!isInteractive($event) && (point.managed?cloudEditor=true:selected=point)"><td><span class="access-point-name"><span @click.stop><AppSwitch size="s" :model-value="point.enabled" :label="t('Включено')+': '+(point.managed?t(point.name):point.name)" hide-label :disabled="busy || !can('settings:write') || (!point.managed && (!!point.stage || point.state==='installing'))" @update:model-value="toggle(point,$event)" /></span><strong>{{point.managed?t(point.name):point.name}}</strong></span></td><td>{{point.managed?t('Управляется автоматически'):point.host+':'+point.publicPort}}</td><td>{{point.managed?(point.protocols?.includes('vless-reality')?'Outline / VLESS · REALITY':'Outline / Shadowsocks'):'VLESS / REALITY'}}</td><td :title="t('Всего ключей / активно сейчас')"><span class="access-point-clients"><span>{{point.clients.length}} / <AppTableValue :value="point.activeClients ?? '—'" /></span><AppButton size="s" variant="blanc" icon-only :aria-label="t('Редактировать ключи')" :title="t('Редактировать ключи')" :disabled="busy || !can('settings:write')" @click.stop="selected=point"><AppIcon name="edit" /></AppButton></span></td><td>{{trafficText(point.traffic)}}</td><td :title="point.error || ''">{{t(labels[point.stage || point.state] || point.state)}}<span v-if="point.managed && point.state==='active' && point.connectionTransport" class="access-point-mode">{{t(({direct:'Direct connection',ssh:'SSH tunnel',gateway:'Through a gateway'})[point.connectionTransport] || point.connectionTransport)}}</span><span v-if="point.error" class="access-point-error">{{t(point.error)}}</span></td><td class="actions-cell"><AppRowMenu :actions="actions(point)" :label="t('Действия')" :disabled="busy" @select="select(point,$event)" /></td></tr>
   <tr v-if="!filteredPoints.length"><td colspan="7" class="table-empty">{{t(filter.query?'Ничего не найдено':can('settings:write')?'Точек доступа пока нет':'Недостаточно прав.')}}</td></tr>
  </tbody></AppTable></div>
 </AppDataCard>
 <CloudAccessDialog :open="cloudEditor" :api="api" @close="cloudEditor=false" @saved="load" @keys="cloudEditor=false;selected=$event" />
 <AccessPointDialog :open="editor" :point="editing" :api="api" :disabled="busy" @close="editor=false" @created="load" />
 <AccessPointClientsDialog :open="!!selected" :point="selected" :api="api" :ask-confirm="askConfirm" @close="selected=null" @changed="load" />
</template>
<style scoped>.access-point-clients{display:inline-flex;align-items:center;gap:var(--space-2)}.access-point-clients :deep(.app-icon){color:var(--color-text-secondary)}.access-point-name{display:inline-flex;align-items:center;gap:var(--space-3)}.access-point-error{display:block;max-width:24rem;white-space:normal;font-size:var(--font-size-body)}</style>

<style scoped>
.access-point-mode{display:block;font-size:var(--font-size-body);color:var(--color-text-secondary)}
</style>
