<script setup>
import {clientActions as sharedClientActions} from '../lib/entity-actions.js';
import {architectureClientId} from '../lib/network-architecture.js';
import {formatBinaryBytes as bytes} from '../lib/traffic-format.js';
import AppTableValue from '../components/AppTableValue.vue';
import AppGridFilters from '../components/AppGridFilters.vue';
import AppGridFilterToggle from '../components/AppGridFilterToggle.vue';
import AppTable from '../components/AppTable.vue';
import {ref,computed} from 'vue';
import {usePolling} from '../composables/usePolling.js';
import {useFormFeedback} from '../composables/useFormFeedback.js';
import AppDataCard from '../components/AppDataCard.vue';
import AppRowMenu from '../components/AppRowMenu.vue';
import PinDialog from '../components/PinDialog.vue';
import { usePreferences } from '../preferences.js';
import { isInteractive } from '../lib/interactions.js';
const {reportError}=useFormFeedback();
const emit=defineEmits(['journal']);
const props = defineProps(['api', 'run', 'can', 'busy']);

const {
  api,
  run,
  can
} = props;


const {
  t,
  locale
} = usePreferences();

const clients = ref([]),loading=ref(true);
const filter=defineModel({default:()=>({query:'',status:'',address:'',accessPoint:''})});
const filterOpen=ref(Object.values(filter.value).some(Boolean));
const filterActive=computed(()=>Object.values(filter.value).some(Boolean));
const filterOptions=computed(()=>[
 {key:'accessPoint',label:t('Точка доступа'),options:[{value:'',label:t('Все точки доступа')},{value:'local',label:t('Локальная сеть')},...Array.from(new Map(clients.value.filter(c=>c.remote).map(c=>[c.accessPointId,{value:c.accessPointId,label:t(c.accessPointName)}])).values())]},
 {key:'status',label:t('Статус'),options:[{value:'',label:t('Все статусы')},{value:'online',label:t('В сети')},{value:'offline',label:t('Не в сети')},{value:'unknown',label:t('Статус неизвестен')}]},
 {key:'address',label:t('Тип адреса'),options:[{value:'',label:t('Все адреса')},{value:'static',label:t('Статический адрес')},{value:'dynamic',label:t('Динамический адрес')}]}
]);
const filteredClients=computed(()=>clients.value.filter(client=>{
 const {query,status,address,accessPoint}=filter.value;
 return (!accessPoint || (accessPoint==='local'?!client.remote:client.accessPointId===accessPoint)) && (!query.trim() || [client.hostname,client.ip,client.mac,client.staticIp].join(' ').toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) && (!status || (client.online===true?'online':client.online===false?'offline':'unknown')===status) && (!address || (!client.remote && (client.staticIp?'static':'dynamic')===address));
}));

function clientTraffic(client){return client.traffic?'↓ '+bytes(client.traffic.download)+' · ↑ '+bytes(client.traffic.upload):'—';}
let failed=false;
usePolling(()=>true,{
 interval:5000,
 request:signal=>api('clients',{signal}),
 onData:data=>{clients.value=data.clients || [];loading.value=false;failed=false;},
 onError:error=>{loading.value=false;if(!failed)reportError(error);failed=true;}
});

const pinDialog = ref({
  open: false,
  client: null,
  ip: '',
  hostname: ''
});

function clientActions(client){return sharedClientActions(client,{t,can});}

function openPinDialog(client) {
  pinDialog.value = {
    open: true,
    client,
    ip: client.staticIp || client.ip,
    hostname: client.hostname || ''
  };
}

function savePin(payload) {
  run(async () => {
    try {
      await api('clients/static', {
        method: 'POST',

        body: JSON.stringify({
          mac: pinDialog.value.client.mac,
          ip: payload.ip,
          hostname: payload.hostname
        })
      });

      pinDialog.value.open = false;
      clients.value = (await api('clients')).clients;
    } catch (e) {
      reportError(e);
    }
  });
}

function unpinClient(client) {
  return run(async () => {
    try {
      await api('clients/static/' + encodeURIComponent(client.mac), {
        method: 'DELETE'
      });

      clients.value = (await api('clients')).clients;
    } catch (e) {
      reportError(e);
    }
  });
}

function onClientAction(client, value) {
  if(value==='journal'){emit('journal',client);return;}
  if (value === 'unpin') {
    return unpinClient(client);
  }

  openPinDialog(client);
}

function onClientRow(client, event) {
  if (isInteractive(event))
    return;

  emit('journal',client);
}
async function performEntityAction(id,value){
 clients.value=(await api('clients')).clients || [];
 const item=clients.value.find(client=>architectureClientId(client)===id);
 if(!item)throw Error(t('architecture.itemUnavailable'));
 if(!clientActions(item).some(action=>action.value===value&&!action.disabled))return;
 return onClientAction(item,value);
}
defineExpose({performEntityAction});
</script>
<template>
  <div class="card-stack">
    <AppDataCard :title="t('Устройства')" :count="filteredClients.length">
      <template v-if="filterOpen" #filters><AppGridFilters v-model="filter" :search-label="t('Поиск клиентов')" :filters="filterOptions" /></template>
      <div class="table-wrap">
        <AppTable :loading="loading" class="data-table" data-testid="client-list">
          <thead>
            <tr>
              <th>{{t("Клиент")}}</th>
              <th>{{t("IP")}}</th>
              <th>{{t("MAC")}}</th><th>{{t("Источник клиента")}}</th>
              <th :title="t('Накопленный трафик')">{{t('Трафик, всего')}}</th>
              <th>{{t("Статический адрес")}}</th>
              <th>{{t("Аренда до")}}</th>
              <th class="actions-col filter-column-head" :aria-label="t('Действия')"><AppGridFilterToggle :open="filterOpen" :active="filterActive" data-testid="toggle-client-filter" @toggle="filterOpen=!filterOpen" /></th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="!loading && !filteredClients.length"><td colspan="8" class="table-empty">{{t(filterActive?'Ничего не найдено':'Клиентов пока нет')}}</td></tr>
            <tr v-for="client in filteredClients" :key="client.remote?client.accessPointId+client.id:client.mac+client.ip" data-testid="client-row" @click="onClientRow(client,$event)">
              <td>
                <span class="client-name"><span class="client-presence"><span class="client-status" :class="{'is-online':client.online===true}" role="img" :aria-label="t(client.online===true?'В сети':client.online===false?'Не в сети':'Статус неизвестен')" :title="t(client.online===true?'В сети':client.online===false?'Не в сети':'Статус неизвестен')" :data-testid="client.online===true?'client-online':'client-offline'"></span></span><strong>{{client.hostname || t('Без имени')}}</strong></span>
              </td>
              <td><AppTableValue :value="client.ip || '—'" /></td>
              <td><AppTableValue :value="client.mac || '—'" /></td><td>{{t(client.remote?client.accessPointName:'Локальная сеть')}}</td>
              <td data-testid="client-traffic"><span class="table-traffic-value" :title="clientTraffic(client)"><AppTableValue :value="clientTraffic(client)" /></span></td>
              <td><AppTableValue :value="client.staticIp || '—'" /></td>
              <td><AppTableValue :value="client.remote ? '—' : client.staticIp ? t('Постоянно') : new Date(client.expiresAt).toLocaleString(locale)" /></td>
              <td class="actions-cell">
                <AppRowMenu :actions="clientActions(client)" :label="t('Действия')" :disabled="busy" @select="onClientAction(client,$event)" />
              </td>
            </tr>
          </tbody>
        </AppTable>
      </div>
    </AppDataCard>
  </div>
  <PinDialog :open="pinDialog.open" :disabled="busy" :client="pinDialog.client" @close="pinDialog.open=false" @save="savePin" />
</template>

<style scoped>
.client-name{display:inline-flex;align-items:center;gap:var(--space-2)}
.client-presence{display:inline-flex;inline-size:var(--space-2);flex-shrink:0}
.client-status{display:inline-block;flex-shrink:0;width:var(--space-2);height:var(--space-2);border-radius:var(--radius-pill);background:var(--color-border-subtle)}
.client-status.is-online{background:var(--color-success)}
</style>
