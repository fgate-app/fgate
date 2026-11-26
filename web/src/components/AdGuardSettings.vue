<script setup>
import {ref,watch,computed} from 'vue';
import {normalizeAdGuardSettings} from '../../../shared/adguard-policy.js';
import {useFormAction} from '../composables/useFormAction.js';
import {usePreferences} from '../preferences.js';
import AppDialog from './AppDialog.vue';
import ConfirmDialog from './ConfirmDialog.vue';
import AppInput from './AppInput.vue';
import AppSelect from './AppSelect.vue';
import AppSwitch from './AppSwitch.vue';
import AppButton from './AppButton.vue';
const props=defineProps({open:Boolean,api:Function,readonly:Boolean});const emit=defineEmits(['close']);
const {t}=usePreferences(),{pending,run}=useFormAction();
const settings=ref(null),cacheMb=ref(4),removeSource=ref(null);
function addSubscription(){settings.value.subscriptions.push({url:'',name:'',enabled:true});}
function deleteSubscription(){settings.value.subscriptions.splice(settings.value.subscriptions.indexOf(removeSource.value),1);removeSource.value=null;}
watch(()=>props.open,open=>{if(!open){settings.value=null;return;}run(async()=>{settings.value=await props.api('dns/adguard');cacheMb.value=settings.value.cacheSize/1048576;});},{immediate:true});
const intervals=computed(()=>[{value:21600000,label:t('6 часов')},{value:86400000,label:t('1 день')},{value:604800000,label:t('7 дней')},{value:2592000000,label:t('30 дней')},{value:7776000000,label:t('90 дней')}]);
function save(){run(async()=>{const value=normalizeAdGuardSettings({...settings.value,cacheSize:Number(cacheMb.value)*1048576});await props.api('dns/adguard',{method:'PUT',body:JSON.stringify(value)});emit('close');});}
</script>
<template>
 <AppDialog :form-state="settings?[settings,cacheMb]:undefined" :open="open" title="AdGuard Home" @close="!pending && emit('close')">
  <div v-if="settings" class="form-section">
   <div class="form-section">
    <div v-for="(source,index) in settings.subscriptions" :key="index" class="form-section">
     <label>{{t('Название')}}<AppInput v-model="source.name" :disabled="pending || readonly" /></label>
     <label>{{t('Ссылки DNS-подписок')}}<AppInput v-model="source.url" placeholder="https://example.com/filter.txt" :disabled="pending || readonly" /></label>
     <AppSwitch v-model="source.enabled" :label="t('Включено')" :disabled="pending || readonly" />
     <AppButton variant="secondary" :disabled="pending || readonly" @click="removeSource=source">{{t('Удалить')}}</AppButton>
    </div>
    <AppButton variant="secondary" :disabled="pending || readonly || settings.subscriptions.length>=20" @click="addSubscription">{{t('Добавить подписку')}}</AppButton>
   </div>
   <label>{{t('Размер DNS-кэша, МБ')}}<AppInput v-model="cacheMb" type="number" min="0" max="256" :disabled="pending || readonly" /></label>
   <label>{{t('TTL заблокированного ответа, с')}}<AppInput v-model="settings.blockedTtl" type="number" min="0" max="86400" :disabled="pending || readonly" /></label>
   <AppSwitch v-model="settings.logEnabled" :label="t('Журнал DNS-запросов')" :disabled="pending || readonly" />
   <small v-if="!settings.logEnabled" class="muted">{{t('Без журнала DNS новые блокировки AdGuard не появятся в журнале соединений.')}}</small>
   <label>{{t('Срок хранения DNS-журнала')}}<AppSelect v-model="settings.logInterval" :label="t('Срок хранения DNS-журнала')" :options="intervals" :disabled="pending || readonly || !settings.logEnabled" /></label>
  </div>
  <div v-else class="form-section">{{t('Загрузка…')}}</div>
  <template #footer><AppButton variant="secondary" :disabled="pending" @click="emit('close')">{{t('Отмена')}}</AppButton><AppButton data-testid="save-adguard" :disabled="pending || readonly || !settings" @click="save">{{t('Сохранить')}}</AppButton></template>
 </AppDialog>
 <ConfirmDialog :open="!!removeSource" :title="t('Удалить подписку?')" @close="removeSource=null" @confirm="deleteSubscription" />
</template>
