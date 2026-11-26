<script setup>
import AppInfoBlock from './AppInfoBlock.vue';
import {ref,watch,computed} from 'vue';
import AppDialog from './AppDialog.vue';
import AppButton from './AppButton.vue';
import AppProgress from './AppProgress.vue';
import AppInput from './AppInput.vue';
import AppTextarea from './AppTextarea.vue';
import AppSelect from './AppSelect.vue';
import VpsSshFields from './VpsSshFields.vue';
import {ipVersion,validPort} from '../lib/form-validation.js';
import {useFormFeedback} from '../composables/useFormFeedback.js';
import {usePolling} from '../composables/usePolling.js';
import {usePreferences} from '../preferences.js';
const props=defineProps({open:Boolean,api:Function});const emit=defineEmits(['close','created']);
const {t}=usePreferences(),{validate,reportError}=useFormFeedback();
const form=ref({}),host=ref(null),job=ref(null),recent=ref([]),selected=ref(''),retryId=ref(null),checking=ref(false),loading=ref(false),key=ref('');let revision=0,pollFailed=false;
const stages={checking:'Checking SSH access',installing:'Installing the VPN server',verifying:'Checking the VPN service',adding:'Adding the gateway'};
const states={pending:'Pending',installing:'Installing the VPN server',completed:'VPN deployed',error:'Failed'};
const running=computed(()=>job.value?.state==='installing');
const recentOptions=computed(()=>[{value:'',label:t('New deployment')},...recent.value.map(row=>({value:row.id,label:row.name+' · '+t(states[row.state])}))]);
function reset(){form.value={name:'',host:'',username:'root',sshPort:22,publicPort:443,protocol:'vless',serverName:'www.microsoft.com',sshKey:'',sshPassphrase:''};host.value=null;job.value=null;retryId.value=null;key.value='';selected.value='';}
watch(()=>props.open,async open=>{const current=++revision;if(!open){loading.value=false;form.value.sshKey='';form.value.sshPassphrase='';key.value='';return;}loading.value=true;reset();recent.value=[];try{const rows=await props.api('gateway-deployments');if(current!==revision)return;recent.value=rows;const active=rows.find(row=>row.state!=='completed');if(active){selected.value=active.id;job.value=active;}}catch(error){if(current===revision)reportError(error);}finally{if(current===revision)loading.value=false;}},{immediate:true});
watch(()=>[form.value.host,form.value.sshPort],()=>{host.value=null;});
function select(value){if(!value){reset();return;}selected.value=value;key.value='';host.value=null;retryId.value=null;job.value=recent.value.find(row=>row.id===value) || null;}
function receive(value){job.value=value;recent.value=[value,...recent.value.filter(row=>row.id!==value.id)];if(value.state==='completed')emit('created');}
usePolling(()=>props.open && running.value?job.value.id:false,{interval:1000,request:signal=>props.api('gateway-deployments/'+job.value.id,{signal}),onData:value=>{pollFailed=false;receive(value);},onError:error=>{if(!pollFailed)reportError(error);pollFailed=true;}});
async function submit(){
 if(checking.value)return;
 if(!validate([[!!form.value.name?.trim(),'Specify a name of up to 100 characters.'],[!!ipVersion(form.value.host),'Enter the VPS IP address.'],[/^[a-z_][a-z0-9_-]{0,31}$/i.test(form.value.username),'Enter a valid SSH username.'],[[form.value.sshPort,form.value.publicPort].every(validPort) && Number(form.value.sshPort)!==Number(form.value.publicPort),'SSH and VPN ports must differ.'],[!!form.value.sshKey?.includes('PRIVATE KEY-----'),'Enter the SSH private key.']]))return;
 checking.value=true;const current=revision;
 try{
  if(!host.value){const result=await props.api('gateway-deployments/inspect',{method:'POST',body:JSON.stringify({host:form.value.host,sshPort:Number(form.value.sshPort)})});if(current===revision)host.value=result;return;}
  const result=await props.api('gateway-deployments'+(retryId.value?'/'+retryId.value+'/retry':''),{method:'POST',body:JSON.stringify({...form.value,sshPort:Number(form.value.sshPort),publicPort:Number(form.value.publicPort),...host.value})});
  if(current===revision){receive(result);selected.value=result.id;form.value.sshKey='';form.value.sshPassphrase='';host.value=null;}
 }catch(error){if(current===revision)reportError(error);}finally{checking.value=false;}
}
function retry(){const value=job.value;form.value={...value,sshKey:'',sshPassphrase:''};retryId.value=value.id;host.value=null;job.value=null;key.value='';}
async function showKey(){checking.value=true;const current=revision;try{const result=await props.api('gateway-deployments/'+job.value.id+'/key');if(current===revision)key.value=result.link;}catch(error){reportError(error);}finally{checking.value=false;}}
</script>
<template>
 <AppDialog :open="open" :form-state="job?undefined:form" :title="t('Deploy VPN')" @close="!checking && emit('close')">
  <div class="form-section" data-testid="gateway-deploy-dialog">
   <label v-if="recent.length">{{t('Deployment')}}<AppSelect :model-value="selected" :options="recentOptions" :disabled="checking" @update:model-value="select" /></label>
   <p v-if="loading" role="status">{{t('Загрузка…')}}</p>
   <template v-else-if="job">
    <p role="status">{{t(running?(stages[job.stage] || 'Installing the VPN server'):states[job.state])}}</p>
    <AppProgress v-if="running" :value="Object.keys(stages).indexOf(job.stage)+1" :max="5" :label="t('VPN deployment progress')" />
    <label>{{t('Название')}}<AppInput :model-value="job.name" readonly /></label>
    <label>{{t('Адрес VPS')}}<AppInput :model-value="job.host" readonly /></label>
    <AppInfoBlock v-if="job.error" variant="danger" role="alert">{{t(job.error)}}</AppInfoBlock>
    <AppInfoBlock v-if="job.state==='completed'">{{t('The server is installed and its key was added to Gateways. Run diagnostics to verify access through the VPS firewall.')}}</AppInfoBlock>
    <label v-if="key">{{t('Personal VPN key')}}<AppTextarea :model-value="key" readonly copyable :rows="4" /></label>
   </template>
   <template v-else-if="!host">
    <label>{{t('Протокол')}}<AppSelect v-model="form.protocol" :disabled="checking || !!retryId" :options="[{value:'vless',label:'VLESS / REALITY'},{value:'shadowsocks',label:'Shadowsocks'}]" /></label>
    <VpsSshFields v-model="form" :disabled="checking" :locked-endpoint="!!retryId" :locked-connection="!!retryId">
     <template #host-info><AppInfoBlock variant="info">{{t('Use an existing Debian or Ubuntu VPS with root SSH access or passwordless sudo.')}}</AppInfoBlock></template>
     <label>{{t('Порт VPN')}}<AppInput v-model="form.publicPort" type="number" min="1" max="65535" :disabled="checking || !!retryId" /></label>
     <label v-if="form.protocol==='vless'">{{t('Имя сервера REALITY')}}<AppInput v-model="form.serverName" :disabled="checking || !!retryId" /></label>
    </VpsSshFields>
   </template>
   <template v-else>
    <label>{{t('Адрес VPS')}}<AppInput :model-value="form.host+':'+form.sshPort" readonly /></label>
    <label>{{t('Отпечаток SSH-сервера')}}<AppInput :model-value="host.fingerprint" readonly /></label>
    <AppInfoBlock variant="warning">{{t('Сверьте отпечаток с панелью хостинга перед установкой.')}}</AppInfoBlock>
   </template>
  </div>
  <template #footer>
   <AppButton variant="secondary" :disabled="checking" @click="emit('close')">{{t(job?'Закрыть':'Отмена')}}</AppButton>
   <AppButton v-if="job?.state==='completed'" :disabled="checking" @click="showKey">{{t('Show personal key')}}</AppButton>
   <AppButton v-else-if="job?.state==='error'" :disabled="checking" @click="retry">{{t('Retry deployment')}}</AppButton>
   <AppButton v-else-if="!job && !loading" :disabled="checking || !form.name || !form.host || !form.sshKey" @click="submit">{{t(host?'Доверять и установить':'Проверить SSH')}}</AppButton>
  </template>
 </AppDialog>
</template>

