<script setup>
import {ref,watch} from 'vue';
import AppDialog from './AppDialog.vue';
import AppInput from './AppInput.vue';
import AppButton from './AppButton.vue';
import AppSwitch from './AppSwitch.vue';
import AppAccordion from './AppAccordion.vue';
import AppInfoBlock from './AppInfoBlock.vue';
import {torDefaults,normalizeTorSettings} from '../../../shared/tor.js';
import {usePreferences} from '../preferences.js';
import {useFormFeedback} from '../composables/useFormFeedback.js';
const props=defineProps({open:Boolean,profile:Object,api:Function});
const emit=defineEmits(['close','saved']);
const {t}=usePreferences(),{reportError}=useFormFeedback();
const form=ref({}),advanced=ref(false),loading=ref(false),loadFailed=ref(false),saving=ref(false);let revision=0;
watch(()=>props.open,async open=>{
 const current=++revision;if(!open)return;
 form.value={name:props.profile?.name || 'Tor',...torDefaults};advanced.value=false;loading.value=true;loadFailed.value=false;
 try{if(props.profile){const value=await props.api('profiles/'+props.profile.id+'/config');if(current===revision)form.value={name:props.profile.name,...normalizeTorSettings(value.settings)};}}
 catch(error){if(current===revision){loadFailed.value=true;reportError(error);}}finally{if(current===revision)loading.value=false;}
});
async function save(){
 if(saving.value || loading.value || loadFailed.value)return;saving.value=true;
 try{const {name,...value}=form.value,settings=normalizeTorSettings({...value,connectTimeout:Number(value.connectTimeout),retries:Number(value.retries),retryDelay:Number(value.retryDelay)});
  if(!props.profile)throw Error('Gateway not found.');
  await props.api('profiles/'+props.profile.id,{method:'PUT',body:JSON.stringify({name,settings})});emit('saved');emit('close');
 }catch(error){reportError(error);}finally{saving.value=false;}
}
</script>
<template>
 <AppDialog :open="open" :title="t('Tor gateway settings')" :form-state="form" @close="!saving && emit('close')">
  <div class="form-section" data-testid="tor-gateway-dialog">
   <p v-if="loading" role="status">{{t('Загрузка…')}}</p>
   <template v-else>
    <label>{{t('Название')}}<AppInput v-model="form.name" maxlength="100" :disabled="saving || !!profile?.builtin" /></label>
    <AppSwitch :model-value="form.mode==='snowflake'" :label="t('Only connect through Snowflake')" :disabled="saving" @update:model-value="form.mode=$event?'snowflake':'auto'" />
    <AppInfoBlock variant="warning">{{t('Automatic mode makes a direct attempt to reach Tor that your provider can observe. Enable Snowflake only to skip that attempt.')}}</AppInfoBlock>
    <AppAccordion v-model:open="advanced" :title="t('Дополнительные настройки')">
     <div class="form-section">
      <label>{{t('Connection timeout per attempt (seconds)')}}<AppInput v-model="form.connectTimeout" type="number" min="30" max="300" :disabled="saving" /></label>
      <label>{{t('Additional connection cycles')}}<AppInput v-model="form.retries" type="number" min="0" max="5" :disabled="saving" /></label>
      <label>{{t('Delay between cycles (seconds)')}}<AppInput v-model="form.retryDelay" type="number" min="10" max="300" :disabled="saving" /></label>
     </div>
    </AppAccordion>
   </template>
  </div>
  <template #footer><AppButton variant="secondary" :disabled="saving" @click="emit('close')">{{t('Отмена')}}</AppButton><AppButton :disabled="loading || loadFailed || saving || !form.name?.trim()" @click="save">{{t('Сохранить')}}</AppButton></template>
 </AppDialog>
</template>
