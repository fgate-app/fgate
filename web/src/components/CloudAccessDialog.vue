<script setup>
import {ref,watch} from 'vue';
import AppDialog from './AppDialog.vue';
import AppButton from './AppButton.vue';
import AppInput from './AppInput.vue';
import AppSwitch from './AppSwitch.vue';
import AppAccordion from './AppAccordion.vue';
import {usePreferences} from '../preferences.js';
import {useFormAction} from '../composables/useFormAction.js';
const props=defineProps({open:Boolean,api:Function});const emit=defineEmits(['close','saved','keys']);const {t}=usePreferences();
const {pending:busy,run}=useFormAction();
const point=ref(null),enabled=ref(false),address=ref(''),token=ref(''),serverName=ref(''),advanced=ref(false);let revision=0;
watch(()=>props.open,open=>{
 const current=++revision;point.value=null;advanced.value=false;
 if(open)run(async()=>{
  const row=(await props.api('access-points')).find(row=>row.managed);if(current!==revision)return;
  point.value=row;enabled.value=row.enabled;address.value=row.cloudAddress;token.value='';serverName.value=row.serverName;

 });
});
function save(){run(async()=>{await props.api('access-points/'+point.value.id+'/cloud',{method:'PUT',body:JSON.stringify({enabled:enabled.value,address:address.value,token:token.value,serverName:serverName.value})});emit('saved');emit('close');});}
</script>
<template>
 <AppDialog :form-state="point?[enabled,address,token,serverName]:undefined" :open="open" :title="t('Облачный доступ')" @close="!busy && emit('close')">
  <div v-if="point" class="form-section">
   <AppSwitch v-model="enabled" :label="t('Включено')" :disabled="busy" />
   <label>{{t('Cloud address')}}<AppInput v-model="address" :disabled="busy" placeholder="https://cloud.example:7443" /></label>
   <label>{{t('Cloud access token')}}<AppInput v-model="token" type="password" autocomplete="new-password" :disabled="busy" :placeholder="point.hasCloudToken?t('Leave empty to keep the current token'):''" /></label>
   <label>{{t('Идентификатор экземпляра')}}<AppInput :model-value="point.instanceId" readonly /></label>
   <AppAccordion v-model:open="advanced" :title="t('Дополнительные настройки')"><div class="form-section"><label>{{t('Имя сервера REALITY')}}<AppInput v-model="serverName" :disabled="busy" /></label></div></AppAccordion>
   <AppButton variant="secondary" :disabled="busy" @click="emit('keys',point)">{{t('Управление ключами')}}</AppButton>
  </div>
  <template #footer><AppButton variant="secondary" :disabled="busy" @click="emit('close')">{{t('Отмена')}}</AppButton><AppButton :disabled="busy || !point" @click="save">{{t('Сохранить')}}</AppButton></template>
 </AppDialog>
</template>

