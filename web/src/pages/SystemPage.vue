<script setup>
import {ref,onMounted,watch} from 'vue';
import {usePreferences} from '../preferences.js';
import AppDataCard from '../components/AppDataCard.vue';
import AppTable from '../components/AppTable.vue';
import AppIcon from '../components/AppIcon.vue';
import AppButton from '../components/AppButton.vue';
import AppDialog from '../components/AppDialog.vue';
import ConfirmDialog from '../components/ConfirmDialog.vue';
import AppInput from '../components/AppInput.vue';
import AppPasswordInput from '../components/AppPasswordInput.vue';
import AppCheckbox from '../components/AppCheckbox.vue';
import AppFileUpload from '../components/AppFileUpload.vue';
import AppInfoBlock from '../components/AppInfoBlock.vue';
import AppRowMenu from '../components/AppRowMenu.vue';
const props=defineProps({api:Function,can:Function});
const {t,locale}=usePreferences();
const rows=ref([]),loading=ref(false),pending=ref(false),error=ref(''),mode=ref(''),secret=ref(''),saved=ref(false),file=ref(null),summary=ref(null),restoreNetwork=ref(true),selected=ref(null),remove=ref(null),resetText=ref(''),restarting=ref(false);
const reload=()=>location.reload();
const date=value=>new Date(value).toLocaleString(locale.value);
async function perform(action){if(pending.value)return;pending.value=true;error.value='';try{await action();}catch(e){if(e.data?.cloudAccess&&summary.value)summary.value={...summary.value,cloudAccess:e.data.cloudAccess};error.value=e.message;}finally{pending.value=false;}}
const post=(path,body={})=>props.api('configuration/'+path,{method:'POST',body:JSON.stringify(body)});
async function load(){loading.value=true;try{rows.value=await props.api('configuration/backups');}finally{loading.value=false;}}
function close(){if(pending.value)return;mode.value='';secret.value='';file.value=null;summary.value=null;selected.value=null;error.value='';}
async function open(next,row=null){secret.value='';saved.value=false;file.value=null;summary.value=null;selected.value=row;resetText.value='';error.value='';mode.value=next;if(next==='export')await perform(async()=>{secret.value=(await post('secret')).secret;});if(next==='restore'&&row)await preview();}
function download(value){const url=URL.createObjectURL(new Blob([JSON.stringify(value)],{type:'application/json'}));const anchor=document.createElement('a');anchor.href=url;anchor.download='freedomgate-'+new Date().toISOString().replace(/[:.]/g,'-')+'.fgconfig';anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
async function exportFile(){await perform(async()=>{const result=await post('backups/'+selected.value.id+'/export',{secret:secret.value});download(result.file);mode.value='';secret.value='';});}
async function create(){await perform(async()=>{await post('backups');await load();});}
async function importBody(){if(selected.value)return {backupId:selected.value.id};if(!file.value)throw Error(t('Choose a configuration file.'));if(file.value.size>90*1024*1024)throw Error(t('Configuration file is too large.'));let parsed;try{parsed=JSON.parse(await file.value.text());}catch{throw Error(t('Invalid configuration file.'));}return {file:parsed,secret:secret.value};}
async function preview(){await perform(async()=>{summary.value=await post('preview',await importBody());restoreNetwork.value=summary.value.missingInterfaces.length===0;});}
async function replace(){await perform(async()=>{const path=mode.value==='reset'?'reset':selected.value?'backups/'+selected.value.id+'/restore':'restore';const body=mode.value==='reset'?{}:await importBody();await post(path,{...body,confirm:true,restoreNetwork:restoreNetwork.value,acknowledgeCloudReset:summary.value?.cloudAccess?.reset===true});mode.value='';secret.value='';file.value=null;restarting.value=true;});}
async function deleteBackup(){await perform(async()=>{await props.api('configuration/backups/'+remove.value.id,{method:'DELETE'});remove.value=null;await load();});}
watch([file,secret],()=>{summary.value=null;});
onMounted(()=>{if(props.can('users:write'))perform(load);});
</script>
<template>
 <div class="card-stack" data-testid="system-settings">
  <AppInfoBlock v-if="restarting">{{t('Configuration saved. The service is restarting. Sign in again after it becomes available. The network address may change.')}} <AppButton variant="secondary" @click="reload()">{{t('Reload')}}</AppButton></AppInfoBlock>
  <p v-if="error&&!mode&&!remove" class="alert" role="alert">{{error}}</p>
  <div v-if="can('users:write')" class="system-maintenance-layout" data-testid="system-maintenance-layout">
   <AppDataCard :title="t('Configuration backups')" :count="rows.length" data-testid="configuration-backups-card">
    <template #actions>
     <AppButton data-testid="configuration-backup" variant="secondary" icon-only :aria-label="t('Create backup')" :title="t('Create backup')" :disabled="pending||restarting" @click="create"><AppIcon name="plus" /></AppButton>
    </template>
    <div class="table-wrap"><AppTable class="data-table" data-testid="configuration-backups" :loading="loading"><thead><tr><th>{{t('Created')}}</th><th>{{t('Size')}}</th><th class="actions-col" :aria-label="t('Действия')"></th></tr></thead><tbody>
     <tr v-for="row in rows" :key="row.id" @click="!pending&&!restarting&&open('restore',row)"><td><strong>{{date(row.createdAt)}}</strong></td><td>{{new Intl.NumberFormat(locale,{style:'unit',unit:'kilobyte',maximumFractionDigits:1}).format(row.size/1024)}}</td><td class="actions-cell"><AppRowMenu :disabled="pending||restarting" :label="t('Действия')" :actions="[{value:'restore',label:t('Restore configuration'),icon:'restart'},{value:'export',label:t('Export configuration'),icon:'install'},{value:'remove',label:t('Delete backup'),icon:'trash'}]" @select="$event==='restore'?open('restore',row):$event==='export'?open('export',row):remove=row" /></td></tr>
     <tr v-if="!rows.length" class="table-empty"><td colspan="3">{{t('No configuration backups yet.')}}</td></tr>
    </tbody></AppTable></div>
   </AppDataCard>
   <AppDataCard :title="t('Maintenance')" data-testid="configuration-maintenance-card">
    <div class="maintenance-actions">
     <div class="maintenance-block"><strong>{{t('Restore from backup')}}</strong><p>{{t('Use a configuration file and its secret to restore on this or another device.')}}</p><AppButton data-testid="configuration-import" variant="secondary" :disabled="pending||restarting" @click="open('restore')">{{t('Restore')}}</AppButton></div>
     <div class="maintenance-block"><strong>{{t('Factory reset')}}</strong><p>{{t('Remove FreedomGate settings, users and keys. Servers deployed on external VPS hosts are not removed.')}}</p><AppButton data-testid="configuration-reset" variant="secondary" :disabled="pending||restarting" @click="open('reset')">{{t('Reset')}}</AppButton></div>
    </div>
   </AppDataCard>
  </div>
  <AppDataCard v-else :title="t('Maintenance')"><p class="maintenance-actions">{{t('Only administrators can manage system configuration.')}}</p></AppDataCard>
  <AppDialog :open="!!mode" :title="t(mode==='export'?'Download configuration file':mode==='reset'?'Factory reset':'Restore configuration')" @close="close">
   <div class="form-section">
    <template v-if="mode==='export'">
     <p v-if="selected">{{date(selected.createdAt)}}</p>
     <AppInfoBlock>{{t('Keep the secret separately from the file. Without it, the configuration cannot be recovered.')}}</AppInfoBlock>
     <label>{{t('Encryption secret')}}<AppInput v-model="secret" data-testid="configuration-secret" copyable autocomplete="off" :disabled="pending" /></label>
     <AppButton variant="secondary" :disabled="pending" @click="perform(async()=>{secret=(await post('secret')).secret;saved=false})">{{t('Generate new secret')}}</AppButton>
     <AppCheckbox v-model="saved" :disabled="pending" :label="t('I have saved the encryption secret.')" />
    </template>
    <template v-else-if="mode==='reset'">
     <AppInfoBlock variant="danger">{{t('All FreedomGate settings, users and access keys will be removed. Connections will stop. A safety backup will be created before resetting. You will need to set up an administrator again.')}}</AppInfoBlock>
     <label>{{t('Type RESET to confirm')}}<AppInput v-model="resetText" data-testid="configuration-reset-confirm" :disabled="pending" autocomplete="off" /></label>
    </template>
    <template v-else>
     <template v-if="!selected">
      <AppFileUpload v-model="file" :label="t('Configuration file')" accept=".fgconfig,.json" :max-size="90*1024*1024" :disabled="pending" />
      <label>{{t('Encryption secret')}}<AppPasswordInput v-model="secret" data-testid="configuration-import-secret" :disabled="pending" autocomplete="off" /></label>
     </template>
     <p v-else>{{date(selected.createdAt)}}</p>
     <template v-if="summary">
      <p>{{t('Gateways: {gateways}; routing groups: {rules}; users: {users}.',summary)}}</p>
      <AppInfoBlock v-if="summary.cloudAccess?.reset" variant="warning">{{t(summary.cloudAccess.state==='occupied'?'This cloud instance is already in use. Cloud access will be disabled and a new Instance ID created. Saved cloud user keys will not be restored. Enter a new cloud access token to connect later.':'Cloud availability could not be confirmed. Cloud access will be disabled and a new Instance ID created. Saved cloud user keys will not be restored. Enter a new cloud access token to connect later.')}}</AppInfoBlock>
      <AppInfoBlock v-if="summary.missingInterfaces.length" variant="warning">{{t('Missing network interfaces: {interfaces}. Restore without network settings and configure them separately.',{interfaces:summary.missingInterfaces.join(', ')})}}</AppInfoBlock>
      <AppCheckbox v-if="summary.network" v-model="restoreNetwork" :disabled="pending||summary.missingInterfaces.length>0" :label="t('Restore network settings')" />
      <AppInfoBlock v-if="summary.network&&!restoreNetwork">{{t('The current device network settings and DHCP reservations will be kept.')}}</AppInfoBlock>
      <AppInfoBlock variant="warning">{{t('This replaces the current configuration and signs out all users. A safety backup will be created first.')}}</AppInfoBlock>
     </template>
    </template>
    <p v-if="error" class="alert" role="alert">{{error}}</p>
   </div>
   <template #footer><AppButton variant="secondary" :disabled="pending" @click="close">{{t('Отмена')}}</AppButton><AppButton v-if="mode==='export'" :disabled="pending||!saved||secret.length<16||secret.length>256" data-testid="configuration-download" @click="exportFile">{{t('Download')}}</AppButton><AppButton v-else-if="mode==='reset'" :disabled="pending||resetText!=='RESET'" data-testid="configuration-replace" @click="replace">{{t('Reset')}}</AppButton><AppButton v-else-if="!summary" :disabled="pending||(!selected&&(!file||secret.length<16))" data-testid="configuration-preview" @click="preview">{{t('Review configuration')}}</AppButton><AppButton v-else :disabled="pending" data-testid="configuration-replace" @click="replace">{{t('Restore')}}</AppButton></template>
  </AppDialog>
  <ConfirmDialog :open="!!remove" :title="t('Delete configuration backup?')" :message="t('This removes the saved backup from this device.')" :disabled="pending" @close="remove=null" @confirm="deleteBackup"><p>{{t('This removes the saved backup from this device.')}}</p><p v-if="error" class="alert" role="alert">{{error}}</p></ConfirmDialog>
 </div>
</template>
<style scoped>
.system-maintenance-layout{display:grid;grid-template-columns:minmax(0,2fr) minmax(0,1fr);align-items:start;gap:var(--card-gap)}
.system-maintenance-layout>:deep(.data-card){min-width:0;margin:0}
.maintenance-actions{padding:var(--space-6);display:grid;gap:var(--space-6);margin:0}
.maintenance-block{display:grid;justify-items:start;gap:var(--space-3);min-width:0;font-size:var(--font-size-body)}
.maintenance-block p{margin:0;color:var(--color-text-secondary)}
@media(max-width:1000px){.system-maintenance-layout{grid-template-columns:minmax(0,1fr)}}
</style>
