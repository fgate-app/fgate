<script setup>
import {ref,watch,computed} from 'vue';
import QRCode from 'qrcode';
import {useFormAction} from '../composables/useFormAction.js';
import AppTable from './AppTable.vue';
import AppCount from './AppCount.vue';
import AppDialog from './AppDialog.vue';
import AppInput from './AppInput.vue';
import AppTextarea from './AppTextarea.vue';
import AppButton from './AppButton.vue';
import AppIcon from './AppIcon.vue';
import AppSwitch from './AppSwitch.vue';
import AppSelect from './AppSelect.vue';
import {usePreferences} from '../preferences.js';
const {pending:busy,run}=useFormAction();
const props=defineProps({open:Boolean,point:Object,api:Function,askConfirm:Function});
const emit=defineEmits(['close','changed']),{t}=usePreferences();
const point=ref(null),selectedId=ref(null),creating=ref(false),config=ref(null),qr=ref(''),loading=ref(true),connectionProtocol=ref('shadowsocks');
const connectionConfig=computed(()=>config.value?.alternatives?.find(item=>item.protocol===connectionProtocol.value) || config.value);
const selected=computed(()=>point.value?.clients.find(client=>client.id===selectedId.value));
const name=computed({get:()=>selected.value?.name || '',set:value=>{if(selected.value)selected.value.name=value;}});
const enabled=computed({get:()=>selected.value?.enabled!==false,set:value=>{if(selected.value)selected.value.enabled=value;}});
const valid=computed(()=>point.value && point.value.clients.every(client=>client.name.trim() && client.name.trim().length<=100));
let revision=0;const persisted=new Map();
async function choose(client){
 const current=++revision;creating.value=!!client.draft;selectedId.value=client.id;config.value=null;qr.value='';
 if(client.draft || !persisted.get(client.id)?.enabled || !client.enabled || (point.value.managed && !point.value.configured))return;
 const value=await props.api('access-points/'+point.value.id+'/clients/'+client.id+'/config');
 if(current!==revision || !props.open)return;config.value=value;
 const image=await QRCode.toDataURL((value.alternatives?.find(item=>item.protocol===connectionProtocol.value) || value).link,{width:240,margin:2});if(current===revision && props.open)qr.value=image;
}
async function load(preferred=selectedId.value){
 const rows=await props.api('access-points');if(!props.open)return;
 point.value=rows.find(row=>row.id===props.point.id);persisted.clear();for(const client of point.value?.clients || [])persisted.set(client.id,{...client});loading.value=false;
 const client=point.value?.clients.find(client=>client.id===preferred) || point.value?.clients[0];
 if(client)await choose(client);else create();
}
function create(){if(!point.value)return;const blank=point.value.clients.find(client=>client.draft && !client.name.trim());if(blank){choose(blank);return;}++revision;const client={id:'draft-'+revision,name:'',enabled:true,draft:true};point.value.clients.push(client);creating.value=true;selectedId.value=client.id;config.value=null;qr.value='';}
watch(connectionProtocol,()=>{if(props.open && selected.value)run(()=>choose(selected.value));});
watch(()=>props.open,open=>{connectionProtocol.value='shadowsocks';++revision;config.value=null;qr.value='';selectedId.value=null;point.value=null;creating.value=false;if(open){loading.value=true;run(()=>load());}});
function save(){return run(async()=>{
 if(!valid.value)return;
 await props.api('access-points/'+point.value.id+'/clients',{method:'PUT',body:JSON.stringify({clients:point.value.clients.map(client=>({...(client.draft?{}:{id:client.id}),name:client.name.trim(),enabled:client.enabled}))})});
 emit('changed');emit('close');
});}
function remove(client=selected.value){if(!client)return;props.askConfirm(t('Удалить ключ?'),client.name,()=>run(async()=>{point.value.clients=point.value.clients.filter(item=>item.id!==client.id);if(selectedId.value===client.id){const next=point.value.clients[0];if(next)await choose(next);else{++revision;selectedId.value=null;config.value=null;qr.value='';creating.value=false;}}}));}
function download(){const url=URL.createObjectURL(new Blob([JSON.stringify(connectionConfig.value.mihomo,null,2)],{type:'application/json'}));const link=document.createElement('a');link.href=url;link.download='freedomgate-client.json';link.click();URL.revokeObjectURL(url);}
</script>
<template>
 <AppDialog :form-state="point?.clients.map(client=>({id:client.id,name:client.name,enabled:client.enabled}))" :open="open" wide :title="t('Ключи')+' — '+(point?.managed?t(point.name):point?.name || '')" :label="t('Ключи')" @close="!busy && emit('close')">
  <div class="access-keys-layout">
   <section class="access-keys-list" :aria-label="t('Ключи')">
    <header class="data-card-head"><div class="data-card-title"><h3>{{t('Ключи')}}</h3><AppCount :value="point?.clients.length || 0" /></div><div class="data-card-actions"><AppButton variant="secondary" size="m" icon-only :aria-label="t('Добавить ключ')" :title="t('Добавить ключ')" :disabled="busy || loading" @click="create"><AppIcon name="plus" /></AppButton></div></header>
    <div class="table-wrap"><AppTable :loading="loading" class="data-table" :aria-label="t('Ключи')"><thead><tr><th class="key-toggle-col"></th><th>{{t('Название')}}</th><th class="actions-col"></th></tr></thead><tbody>
     <tr v-for="client in point?.clients || []" :key="client.id" :class="{'key-selected':selectedId===client.id}" :aria-selected="selectedId===client.id" @click="!busy && run(()=>choose(client))"><td class="key-toggle-col" @click.stop><AppSwitch size="s" v-model="client.enabled" hide-label :label="t('Включено')+': '+(client.name || t('Новый ключ'))" :disabled="busy" /></td><td class="key-name-cell"><strong>{{client.name || t('Новый ключ')}}</strong></td><td @click.stop><AppButton size="s" variant="blanc" icon-only :aria-label="t('Удалить')" :title="t('Удалить')" :disabled="busy" @click="remove(client)"><AppIcon name="trash" /></AppButton></td></tr>
     <tr v-if="!loading && !point?.clients.length"><td colspan="3" class="table-empty">{{t('Ключей пока нет')}}</td></tr>
    </tbody></AppTable></div>
   </section>
   <section v-if="!loading && point" class="access-key-panel" :aria-label="t('Управление ключом')">
    <h3>{{t(creating?'Новый ключ':'Настройки ключа')}}</h3>
    <form v-if="selected" class="form-section" @submit.prevent>
     <label>{{t('Название ключа')}}<AppInput size="s" v-model="name" maxlength="100" :disabled="busy" /></label>

    </form>
    <div v-if="config && enabled" class="form-section">
     <AppSelect v-if="config.alternatives?.length" v-model="connectionProtocol" :label="t('Connection protocol')" :disabled="busy" :options="[{value:'shadowsocks',label:'Outline / Shadowsocks'},{value:'vless-reality',label:'VLESS / REALITY'}]" />
     <img v-if="qr" :src="qr" :alt="t('QR-код подключения')" class="access-client-qr" />
     <p v-if="qr && point.managed && connectionProtocol==='shadowsocks'" class="access-key-note">{{t('Подключитесь через Outline. Действуют общие правила доменов и IP FreedomGate.')}}</p>
     <label>{{t('Конфигурация')}}<AppTextarea size="s" :model-value="connectionConfig.link" copyable :disabled="busy" readonly :rows="4" /></label>
     <AppButton size="s" v-if="connectionConfig.mihomo" variant="secondary" @click="download">{{t('Скачать конфигурацию mihomo')}}</AppButton>
    </div>
    <p v-else-if="creating" class="access-key-note">{{t('Сохраните изменения, чтобы получить ссылку.')}}</p>
    <p v-else-if="selected" class="access-key-note">{{t(selected?.enabled?'Ссылка появится после первого включения облачного доступа.':'Ключ отключён. Включите его и сохраните изменения, чтобы получить ссылку.')}}</p>
   </section>
  </div>
  <template #footer><AppButton variant="secondary" :disabled="busy" @click="emit('close')">{{t('Отмена')}}</AppButton><AppButton :disabled="busy || loading || !valid" @click="save">{{t('Сохранить')}}</AppButton></template>
 </AppDialog>
</template>
<style scoped>
.access-keys-layout{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(0,1fr);gap:0;align-items:stretch}
:global(.app-dialog-body:has(>.access-keys-layout)){padding:0}
.access-keys-list{margin:0;min-width:0}
.access-keys-list>.data-card-head{margin:0}
.access-keys-list :deep(.data-table){min-width:0}
.access-keys-list :deep(tr>:first-child){padding-inline-start:var(--space-6)}
.access-keys-list :deep(tr>:last-child){padding-inline-end:var(--space-6)}
.access-key-panel{display:grid;align-content:start;gap:var(--space-6);min-width:0;padding:var(--space-6);border-inline-start:1px solid var(--color-divider)}
.access-key-panel h3,.access-key-panel form,.access-key-note{margin:0}
.access-key-note{color:var(--text-secondary);font-size:var(--font-size-body)}
.key-toggle-col{width:var(--space-12)}
.access-keys-list :deep(.button-icon .app-icon){color:var(--color-text-secondary)}
.key-name-cell{font-weight:500;color:var(--color-text-primary)}
.access-keys-list .data-table tbody tr.key-selected,.access-keys-list .data-table tbody tr.key-selected:hover{background:var(--color-secondary-active)}
.access-client-qr{display:block;width:calc(var(--space-12) * 5);max-width:100%;height:auto;justify-self:center;border-radius:var(--radius-md)}
@media(max-width:760px){.access-keys-layout{grid-template-columns:minmax(0,1fr)}.access-key-panel{border-inline-start:0;border-top:1px solid var(--color-divider);padding:var(--space-4)}}
@media(max-width:700px){
 .access-keys-list :deep(.responsive-table.data-table){display:table;width:100%;border-collapse:collapse}
 .access-keys-list :deep(thead){display:table-header-group;position:static;width:auto;height:auto;overflow:visible;clip-path:none;white-space:normal}
 .access-keys-list :deep(tbody){display:table-row-group;padding:0}
 .access-keys-list :deep(tbody>tr){display:table-row;border:0;border-radius:0;box-shadow:none}
 .access-keys-list :deep(.responsive-table.data-table>tbody>tr>td){display:table-cell;padding:var(--space-3) var(--space-4);border-bottom:1px solid var(--color-divider)}
 .access-keys-list :deep(tbody>tr>td::before){display:none}
 .access-keys-list :deep(tr>:first-child){padding-inline-start:var(--space-4)}
 .access-keys-list :deep(tr>:last-child){padding-inline-end:var(--space-4)}
}
</style>
