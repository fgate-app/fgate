<script setup>
import AppInfoBlock from './AppInfoBlock.vue';
import {ipVersion,validPort} from '../lib/form-validation.js';
import VpsSshFields from './VpsSshFields.vue';
import {useFormFeedback} from '../composables/useFormFeedback.js';
import {ref,watch} from 'vue';
import AppDialog from './AppDialog.vue';
import AppInput from './AppInput.vue';
import AppButton from './AppButton.vue';
import {usePreferences} from '../preferences.js';
const {reportError,validate}=useFormFeedback();
const props=defineProps({open:Boolean,api:Function,disabled:Boolean,point:Object});
const emit=defineEmits(['close','created']);const {t}=usePreferences();
const form=ref({}),host=ref(null),checking=ref(false);
watch(()=>props.open,open=>{if(!open){form.value.sshKey='';form.value.sshPassphrase='';return;}if(open){form.value={name:'',host:'',sshPort:22,username:'root',sshKey:'',sshPassphrase:'',transportPort:7443,publicPort:443,serverName:'www.microsoft.com',...(props.point || {})};host.value=null;}});
watch(()=>[form.value.host,form.value.sshPort],()=>{host.value=null;});
async function submit(){
 if(checking.value || props.disabled)return;
 const ports=[form.value.sshPort,form.value.transportPort,form.value.publicPort];
 if(!validate([
  [!!form.value.name?.trim(),"Specify a name of up to 100 characters."],
  [!!ipVersion(form.value.host),"Enter the VPS IP address."],
  [/^[a-z_][a-z0-9_-]{0,31}$/i.test(form.value.username),"Enter a valid SSH username."],
  [ports.every(validPort) && new Set(ports.map(Number)).size===3,"SSH, tunnel and VPN ports must differ."],
  [!!props.point || !!form.value.sshKey?.includes('PRIVATE KEY-----'),"Enter the SSH private key."]
 ]))return;
 checking.value=true;try{
  if(!host.value){host.value=await props.api('access-points/inspect',{method:'POST',body:JSON.stringify({host:form.value.host,sshPort:Number(form.value.sshPort)})});return;}
  if(props.point){await props.api('access-points/'+props.point.id+'/credentials',{method:'PUT',body:JSON.stringify({...form.value,sshPort:Number(form.value.sshPort),transportPort:Number(form.value.transportPort),publicPort:Number(form.value.publicPort),...host.value})});emit('created');emit('close');return;}
  const point=await props.api('access-points',{method:'POST',body:JSON.stringify({...form.value,sshPort:Number(form.value.sshPort),transportPort:Number(form.value.transportPort),publicPort:Number(form.value.publicPort),...host.value})});
  await props.api('access-points/'+point.id+'/install',{method:'POST',body:'{}'});emit('created');emit('close');
 }catch(e){reportError(e);}finally{checking.value=false;}
}
</script>
<template>
 <AppDialog :form-state="form" :open="open" :title="t(point?'Настройки SSH':'Новая точка доступа')" @close="!checking && emit('close')">
  <div class="form-section">
   <template v-if="!host">
    <VpsSshFields v-model="form" :disabled="checking" :locked-endpoint="!!point">
     <label>{{t('Порт туннеля')}}<AppInput v-model="form.transportPort" type="number" min="1" max="65535" :disabled="checking || !!point" /></label>
     <label>{{t('Порт VPN')}}<AppInput v-model="form.publicPort" type="number" min="1" max="65535" :disabled="checking || !!point" /></label>
     <label>{{t('Имя сервера REALITY')}}<AppInput v-model="form.serverName" :disabled="checking || !!point" /></label>
    </VpsSshFields>
   </template>
   <template v-else>
    <label>{{t('Адрес VPS')}}<AppInput :model-value="form.host+':'+form.sshPort" readonly /></label>
    <label>{{t('Отпечаток SSH-сервера')}}<AppInput :model-value="host.fingerprint" readonly /></label>
    <AppInfoBlock variant="warning">{{t('Сверьте отпечаток с панелью хостинга перед установкой.')}}</AppInfoBlock>
   </template>
  </div>
  <template #footer><AppButton variant="secondary" :disabled="checking" @click="emit('close')">{{t('Отмена')}}</AppButton><AppButton :disabled="checking || disabled || !form.name || !form.host || (!point && !form.sshKey)" @click="submit">{{t(host?(point?'Доверять и сохранить':'Доверять и установить'):'Проверить SSH')}}</AppButton></template>
 </AppDialog>
</template>


