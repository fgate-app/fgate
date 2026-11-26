<script setup>
import {ref,watch,onUnmounted} from 'vue';import AppButton from './AppButton.vue';import AppIcon from './AppIcon.vue';import AppDataCard from './AppDataCard.vue';import AppTable from './AppTable.vue';import AppRowMenu from './AppRowMenu.vue';import ConfirmDialog from './ConfirmDialog.vue';import GatewaySubscriptionDialog from './GatewaySubscriptionDialog.vue';import {usePreferences} from '../preferences.js';import {notify} from '../lib/toasts.js';
const props=defineProps({api:Function,revision:Array,active:Boolean});const emit=defineEmits(['changed','count','created']);const {t}=usePreferences();const rows=ref([]),open=ref(false),source=ref(null),remove=ref(null),busy=ref(false);let generation=0;
async function load(){const cycle=++generation;try{const value=await props.api('gateway-subscriptions');if(cycle===generation){rows.value=value;emit('count',value.length);}}catch(error){if(cycle===generation)notify(t(error.message),'error');}}
watch(()=>props.revision,load,{immediate:true});onUnmounted(()=>generation++);
function edit(row=null){source.value=row;open.value=true;}
async function changed(){const created=!source.value;open.value=false;await load();emit('changed');if(created)emit('created');}
async function action(row,value){if(busy.value)return;if(value==='edit'){edit(row);return;}if(value==='delete'){remove.value=row;return;}busy.value=true;try{await props.api('gateway-subscriptions/'+row.id+'/refresh',{method:'POST',body:'{}'});await load();emit('changed');}catch(error){await load();notify(t(error.message),'error');}finally{busy.value=false;}}
async function confirm(){busy.value=true;try{await props.api('gateway-subscriptions/'+remove.value.id,{method:'DELETE'});remove.value=null;await load();emit('changed');}catch(error){notify(t(error.message),'error');}finally{busy.value=false;}}
defineExpose({add:()=>edit()});
</script>
<template>
 <AppDataCard v-if="active" :title="t('Gateway subscriptions')" :count="rows.length">
  <template #actions><AppButton variant="secondary" icon-only :aria-label="t('Добавить подписку')" data-testid="add-gateway-subscription" @click="edit()"><AppIcon name="plus" /></AppButton></template>
  <div class="table-wrap"><AppTable class="data-table" data-testid="gateway-subscription-list"><thead><tr><th>{{t('Название')}}</th><th>{{t('Configurations')}}</th><th>{{t('Last update')}}</th><th>{{t('Статус')}}</th><th class="actions-col"></th></tr></thead><tbody><tr v-if="!rows.length" class="table-empty"><td colspan="5">{{t('Нет данных')}}</td></tr><tr v-for="row in rows" :key="row.id" @click="edit(row)"><td><strong>{{row.name}}</strong></td><td>{{row.configCount ?? row.count}}</td><td>{{row.updatedAt?new Date(row.updatedAt).toLocaleString():'—'}}</td><td>{{t(row.error || (row.missing?'Some subscribed gateways are missing.':row.enabled?'Automatic updates':'Automatic updates paused'))}}</td><td class="actions-cell" @click.stop><AppRowMenu :disabled="busy" :label="t('Действия')" :actions="[{value:'edit',label:t('Изменить')},{value:'refresh',label:t('Обновить')},{value:'delete',label:t('Удалить'),danger:true}]" @select="action(row,$event)" /></td></tr></tbody></AppTable></div>
 </AppDataCard>
 <GatewaySubscriptionDialog :open="open" :source="source" :api="api" @close="open=false" @saved="changed" />
 <ConfirmDialog :open="!!remove" :disabled="busy" :title="t('Удалить подписку?')" :message="t('The subscription will be removed. Its gateways and routing rules will be kept.')" @close="remove=null" @confirm="confirm" />
</template>
