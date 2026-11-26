<script setup>
import {formatBinaryBytes as bytes} from '../lib/traffic-format.js';
import AppTableValue from '../components/AppTableValue.vue';
import AppSwitch from '../components/AppSwitch.vue';
import {routeActions} from '../lib/entity-actions.js';
import AppTable from '../components/AppTable.vue';
import { ZAPRET_PRESETS } from '../../../shared/zapret.js';
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
import {routeUsesConnection} from '../lib/route-usage.js';
import RouteFilters from '../components/RouteFilters.vue';
import AppGridFilterToggle from '../components/AppGridFilterToggle.vue';
import AppTabBar from '../components/AppTabBar.vue';
import AppTab from '../components/AppTab.vue';
import AppDataCard from '../components/AppDataCard.vue';
import AppButton from '../components/AppButton.vue';
import AppIcon from '../components/AppIcon.vue';
import AppRowMenu from '../components/AppRowMenu.vue';
import RouteGroupDialog from '../components/RouteGroupDialog.vue';
import DeviceRouteDialog from '../components/DeviceRouteDialog.vue';
import LocalRouteDialog from '../components/LocalRouteDialog.vue';
import { usePreferences } from '../preferences.js';
import { isInteractive } from '../lib/interactions.js';
const props = defineProps(['api', 'run', 'can', 'askConfirm', 'profiles', 'connectionGroups', 'zapretStrategy', 'busy']);

const {
  api,
  run,
  can,
  askConfirm
} = props;

const emit = defineEmits(['notice','dns-settings']);
const routeSection = defineModel();
const filter=defineModel('filter',{default:()=>({connection:'',query:''})});
const filterOpen=ref(Boolean(filter.value.connection || filter.value.query));
watch(filter,value=>{if(value.connection || value.query)filterOpen.value=true;});
function toggleFilter(){filterOpen.value=!filterOpen.value;}
const filterActive=computed(()=>Boolean(filter.value.connection || filter.value.query));
const matches=route=>routeUsesConnection(route,filter.value.connection,props.connectionGroups || []);
const search=values=>values.join(' ').toLocaleLowerCase().includes((filter.value.query || '').trim().toLocaleLowerCase());

const {
  t
} = usePreferences();

const displayName = profile => profile.builtin ? t(profile.name) : profile.name;
const routeSections = ['Домены и IP', 'Устройства', 'Локальные маршруты'];
const loading=ref(true);
const subscriptions=ref([]);
const routeGroups = ref([]), deviceRoutes = ref([]), localRoutes = ref([]);
const filteredGroups=computed(()=>[...routeGroups.value,...(subscriptions.value.some(source=>source.enabled!==false)?[{id:'adguard-dns-filters',system:true,name:'AdGuard DNS filter',routeId:'block',entries:[],dnsFilters:subscriptions.value.filter(source=>source.enabled!==false)}]:[])].filter(route=>matches(route) && search([route.name,...route.entries,...(route.dnsFilters || []).map(source=>source.url),...(route.dnsRules || [])])));
const filteredDevices=computed(()=>deviceRoutes.value.filter(route=>matches(route) && search([route.name,route.identifier])));
const filteredLocals=computed(()=>localRoutes.value.filter(route=>search([route.alias,route.target])));

const routeDialog = ref({
  open: false,
  type: 'group',
  item: null
});

const routeOptions = computed(() => [...props.profiles.map(profile => ({
  value: profile.id,
  label: displayName(profile),
  engine: profile.engine
})), ...(props.connectionGroups || []).map(group=>({value:group.id,label:group.name+' · '+t('Группа'),engine:'group'}))]);

const traffic=ref(null);
let trafficTimer,trafficController,active=true;
async function pollTraffic(){
 const controller=new AbortController();trafficController=controller;
 try{const data=await api('routes/traffic',{signal:controller.signal});if(!controller.signal.aborted)traffic.value=data;}
 catch(error){if(error.name!=='AbortError')traffic.value=null;}
 finally{if(active)trafficTimer=setTimeout(pollTraffic,2000);}
}
onMounted(pollTraffic);
onUnmounted(()=>{active=false;clearTimeout(trafficTimer);trafficController?.abort();});
function routeLabel(id){return groupRouteOptions.value.find(option=>option.value===id)?.label || '—';}
function usesZapret(id){return props.profiles.some(profile=>profile.id===id && profile.engine==='zapret');}
function routeTraffic(kind,route){if(route.routeId==='block')return '—';const value=traffic.value?.available && traffic.value[kind]?.[route.id];return value?'↓ '+bytes(value.download)+' · ↑ '+bytes(value.upload):'—';}

function groupStrategyLabel(group) {
  if(!props.profiles.some(profile=>profile.id===group.routeId && profile.engine==='zapret'))return '—';
  const strategy=group.zapretStrategy || props.zapretStrategy;
  return t(ZAPRET_PRESETS.find(preset=>preset.id===strategy)?.label || (strategy==='custom'?'Своя стратегия':'Стандартная'));
}

const groupRouteOptions = computed(() => [...routeOptions.value, {
  value: 'block',
  label: t('Блокировать')
}]);

async function loadRoutes() {
  try{
  const data = await api('routes');
  routeGroups.value = data.groups;subscriptions.value=data.subscriptions || [];
  deviceRoutes.value = data.devices;
  localRoutes.value = data.locals || [];
  }finally{loading.value=false;}
}

onMounted(() => run(loadRoutes));

function openRouteGroup(group = null) {
  routeDialog.value = {
    open: true,
    type: 'group',
    item: group
  };
}

function openDeviceRoute(device = null) {
  routeDialog.value = {
    open: true,
    type: 'device',
    item: device
  };
}

function closeRouteDialog() {
  routeDialog.value.open = false;
}

// All route editors share the same save/reload/close sequence.
function saveRoute(collection, payload, message = '') {
  return run(async () => {
    const item = routeDialog.value.item;
    await api(`routes/${collection}${item ? '/' + item.id : ''}`, {
      method: item ? 'PUT' : 'POST',
      body: JSON.stringify(payload),
    });
    await loadRoutes();
    closeRouteDialog();
    if (message) emit('notice', message);
  });
}
const saveRouteGroup = payload => saveRoute('groups', payload, 'Группа сохранена.');
const saveDeviceRoute = payload => saveRoute('devices', payload, 'Устройство сохранено.');
const saveLocalRoute = payload => saveRoute('locals', payload);

function groupActions(group){return routeActions(group,{t,can});}
function deviceActions(){return routeActions(null,{t,can});}

function toggleRoute(kind,route,enabled){const previous=route.enabled;route.enabled=enabled;return run(async()=>{try{await api('routes/'+kind+'/'+route.id+'/enabled',{method:'PUT',body:JSON.stringify({enabled})});await loadRoutes();}catch(error){route.enabled=previous;throw error;}});}

function moveGroup(group,direction){return run(async()=>{await api('routes/groups/'+group.id+'/move',{method:'POST',body:JSON.stringify({direction})});await loadRoutes();});}
function moveDisabled(group,direction){const index=routeGroups.value.findIndex(item=>item.id===group.id);return group.routeId==='block' || props.busy || !can('settings:write') || (direction==='up'?index===0:index===routeGroups.value.length-1) || (index>=0 && routeGroups.value[index+(direction==='up'?-1:1)] && routeGroups.value[index+(direction==='up'?-1:1)].routeId==='block');}
function onGroupAction(group, value) {
  if(group.system){emit('dns-settings');return;}
  if (value === 'edit') {
    openRouteGroup(group);
    return;
  }

  if (value === 'delete') askConfirm(t('Удалить группу?'), group.name, () => run(async () => {
    await api('routes/groups/' + group.id, {
      method: 'DELETE'
    });

    await loadRoutes();
  }));
}

function onDeviceAction(device, value) {
  if (value === 'edit') {
    openDeviceRoute(device);
    return;
  }

  if (value === 'delete') askConfirm(t('Удалить устройство?'), device.name, () => run(async () => {
    await api('routes/devices/' + device.id, {
      method: 'DELETE'
    });

    await loadRoutes();
  }));
}

function onGroupRow(group, event) {
  if (isInteractive(event))
    return;

  if(group.system)emit('dns-settings');else openRouteGroup(group);
}

function onDeviceRow(device, event) {
  if (isInteractive(event))
    return;

  openDeviceRoute(device);
}

function openLocalRoute(route = null) {
  routeDialog.value = {
    open: true,
    type: 'local',
    item: route
  };
}

function localRouteActions() {
  return [{
    value: 'edit',
    label: t('Редактировать')
  }, {
    value: 'delete',
    label: t('Удалить'),
    danger: true
  }];
}

function onLocalRouteAction(route, value) {
  if (value === 'edit') {
    openLocalRoute(route);
    return;
  }

  if (value === 'delete') askConfirm(t('Удалить псевдоним?'), route.alias, () => run(async () => {
    await api('routes/locals/' + route.id, {
      method: 'DELETE'
    });

    await loadRoutes();
  }));
}

function onLocalRouteRow(route, event) {
  if (isInteractive(event))
    return;

  openLocalRoute(route);
}
async function performEntityAction(kind,id,value){
 await loadRoutes();
 const item=(kind==='groups'?routeGroups.value:deviceRoutes.value).find(row=>row.id===id);
 if(!item)throw Error(t('architecture.itemUnavailable'));
 if(!routeActions(item,{t,can}).some(action=>action.value===value&&!action.disabled))return;
 return kind==='groups'?onGroupAction(item,value):onDeviceAction(item,value);
}
defineExpose({performEntityAction,createEntity:()=>{if(can('settings:write'))openRouteGroup();}});
</script>
<template>
  <AppTabBar id="route-tabs" class="settings-tabs" v-model="routeSection" :label="t('Типы маршрутов')">
    <AppTab v-for="section in routeSections" :key="section" :value="section" controls="route-content">{{t(section)}}</AppTab>
  </AppTabBar>
  <div id="route-content" role="tabpanel" :aria-labelledby="'route-tabs-tab-'+encodeURIComponent(routeSection)">
    <div class="card-stack">
      <AppDataCard v-if="routeSection==='Домены и IP'" data-testid="route-groups-card" :title="t('Группы доменов и IP')" :count="filteredGroups.length">
        <template #actions>
          <AppButton v-if="can('settings:write')" variant="secondary" size="m" icon-only data-testid="add-route-group" :aria-label="t('Добавить группу')" :title="t('Добавить группу')" :disabled="busy" @click="openRouteGroup()">
            <AppIcon name="plus" />
          </AppButton>
        </template>
        <template v-if="filterOpen" #filters><RouteFilters v-model="filter" :options="groupRouteOptions" :local="routeSection==='Локальные маршруты'" /></template>
        <div class="table-wrap">
          <AppTable :loading="loading" class="data-table" data-testid="route-group-list">
            <thead>
              <tr>
                <th class="toggle-col" :aria-label="t('Включено')"></th>
                <th>{{t("Группа")}}</th>
                <th>{{t("Маршрут")}}</th>
                <th :title="t('Накопленный трафик')">{{t("Трафик")}}</th>
                <th class="actions-col filter-column-head" :aria-label="t('Действия')"><AppGridFilterToggle :open="filterOpen" :active="filterActive" data-testid="toggle-route-filter" @toggle="toggleFilter" /></th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="!loading && !filteredGroups.length"><td colspan="5" class="table-empty">{{t(filterActive?'Ничего не найдено':'Групп пока нет')}}</td></tr>
              <tr v-for="group in filteredGroups" :key="group.id" data-testid="route-group-row" @click="onGroupRow(group,$event)">
                <td class="toggle-cell" @click.stop><AppSwitch v-if="!group.system" size="s" :model-value="group.enabled!==false" :label="t('Включено')+': '+ group.name" hide-label :disabled="busy || !can('settings:write')" @update:model-value="toggleRoute('groups',group,$event)" /></td>
                <td class="name-cell">
                  <strong>{{group.name}}</strong>
                </td>
                <td>
                  <div class="route-destination" data-testid="route-label"><AppTableValue :value="routeLabel(group.routeId)" /></div>
                  <small v-if="usesZapret(group.routeId)" class="route-strategy" data-testid="group-zapret-strategy"><AppTableValue :value="groupStrategyLabel(group)" /></small>
                </td>
                <td data-testid="route-traffic"><span class="table-traffic-value" :title="routeTraffic('groups',group)"><AppTableValue :value="routeTraffic('groups',group)" /></span></td>
                <td class="actions-cell">
                  <div class="route-row-actions">
                    <AppButton v-if="group.routeId!=='block'" variant="secondary" size="s" icon-only :aria-label="t('Переместить выше')" :title="t('Переместить выше')" :disabled="moveDisabled(group,'up')" @click.stop="moveGroup(group,'up')"><AppIcon name="up" /></AppButton>
                    <AppButton v-if="group.routeId!=='block'" variant="secondary" size="s" icon-only :aria-label="t('Переместить ниже')" :title="t('Переместить ниже')" :disabled="moveDisabled(group,'down')" @click.stop="moveGroup(group,'down')"><AppIcon name="down" /></AppButton>
                  <AppRowMenu :actions="groupActions(group)" :label="t('Действия')" :disabled="busy" @select="onGroupAction(group,$event)" />
                  </div>
                </td>
              </tr>
            </tbody>
          </AppTable>
        </div>
      </AppDataCard>
      <AppDataCard v-else-if="routeSection==='Устройства'" data-testid="route-devices-card" :title="t('Устройства')" :count="filteredDevices.length">
        <template #actions>
          <AppButton v-if="can('settings:write')" variant="secondary" size="m" icon-only data-testid="add-device-route" :aria-label="t('Добавить устройство')" :title="t('Добавить устройство')" :disabled="busy" @click="openDeviceRoute()">
            <AppIcon name="plus" />
          </AppButton>
        </template>
        <template v-if="filterOpen" #filters><RouteFilters v-model="filter" :options="groupRouteOptions" :local="routeSection==='Локальные маршруты'" /></template>
        <div class="table-wrap">
          <AppTable :loading="loading" class="data-table" data-testid="route-device-list">
            <thead>
              <tr>
                <th class="toggle-col" :aria-label="t('Включено')"></th>
                <th>{{t("Устройство")}}</th>
                <th>{{t("Идентификатор")}}</th>
                <th>{{t("Маршрут")}}</th>
                <th :title="t('Накопленный трафик')">{{t("Трафик")}}</th>
                <th class="actions-col filter-column-head" :aria-label="t('Действия')"><AppGridFilterToggle :open="filterOpen" :active="filterActive" data-testid="toggle-route-filter" @toggle="toggleFilter" /></th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="!loading && !filteredDevices.length"><td colspan="6" class="table-empty">{{t(filterActive?'Ничего не найдено':'Устройства не добавлены')}}</td></tr>
              <tr v-for="device in filteredDevices" :key="device.id" data-testid="route-device-row" @click="onDeviceRow(device,$event)">
                <td class="toggle-cell" @click.stop><AppSwitch size="s" :model-value="device.enabled!==false" :label="t('Включено')+': '+ device.name" hide-label :disabled="busy || !can('settings:write')" @update:model-value="toggleRoute('devices',device,$event)" /></td>
                <td class="name-cell">
                  <strong>{{device.name}}</strong>
                </td>
                <td>{{device.identifier}}</td>
                <td>
                  <div class="route-destination" data-testid="route-label"><AppTableValue :value="routeLabel(device.routeId)" /></div>
                  <small v-if="usesZapret(device.routeId)" class="route-strategy"><AppTableValue :value="groupStrategyLabel(device)" /></small>
                </td>
                <td data-testid="route-traffic"><span class="table-traffic-value" :title="routeTraffic('devices',device)"><AppTableValue :value="routeTraffic('devices',device)" /></span></td>
                <td class="actions-cell">
                  <AppRowMenu :actions="deviceActions()" :label="t('Действия')" :disabled="busy" @select="onDeviceAction(device,$event)" />
                </td>
              </tr>
            </tbody>
          </AppTable>
        </div>
      </AppDataCard>
      <AppDataCard v-else data-testid="route-locals-card" :title="t('Локальные маршруты')" :count="filteredLocals.length">
        <template #actions>
          <AppButton v-if="can('settings:write')" variant="secondary" size="m" icon-only data-testid="add-local-route" :aria-label="t('Добавить псевдоним')" :title="t('Добавить псевдоним')" :disabled="busy" @click="openLocalRoute()">
            <AppIcon name="plus" />
          </AppButton>
        </template>
        <template v-if="filterOpen" #filters><RouteFilters v-model="filter" :options="groupRouteOptions" :local="routeSection==='Локальные маршруты'" /></template>
        <div class="table-wrap">
          <AppTable :loading="loading" class="data-table" data-testid="route-local-list">
            <thead>
              <tr>
                <th class="toggle-col" :aria-label="t('Включено')"></th>
                <th>{{t("Псевдоним")}}</th>
                <th>{{t("Адрес")}}</th>
                <th class="actions-col filter-column-head" :aria-label="t('Действия')"><AppGridFilterToggle :open="filterOpen" :active="filterActive" data-testid="toggle-route-filter" @toggle="toggleFilter" /></th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="!loading && !filteredLocals.length"><td colspan="4" class="table-empty">{{t(filterActive?'Ничего не найдено':'Псевдонимов пока нет')}}</td></tr>
              <tr v-for="route in filteredLocals" :key="route.id" data-testid="route-local-row" @click="onLocalRouteRow(route,$event)">
                <td class="toggle-cell" @click.stop><AppSwitch size="s" :model-value="route.enabled!==false" :label="t('Включено')+': '+ route.alias" hide-label :disabled="busy || !can('settings:write')" @update:model-value="toggleRoute('locals',route,$event)" /></td>
                <td class="name-cell">
                  <strong>{{route.alias}}</strong>
                </td>
                <td>{{route.target}}</td>
                <td class="actions-cell">
                  <AppRowMenu :actions="localRouteActions()" :label="t('Действия')" :disabled="busy" @select="onLocalRouteAction(route,$event)" />
                </td>
              </tr>
            </tbody>
          </AppTable>
        </div>
      </AppDataCard>
    </div>
  </div>
  <RouteGroupDialog :api="api" :open="routeDialog.open && routeDialog.type==='group'" :disabled="busy" :group="routeDialog.item" :routes="groupRouteOptions" @close="closeRouteDialog" @save="saveRouteGroup" />
  <DeviceRouteDialog :api="api" :open="routeDialog.open && routeDialog.type==='device'" :disabled="busy" :device="routeDialog.item" :routes="routeOptions" @close="closeRouteDialog" @save="saveDeviceRoute" />
  <LocalRouteDialog :open="routeDialog.open && routeDialog.type==='local'" :disabled="busy" :route="routeDialog.item" @close="closeRouteDialog" @save="saveLocalRoute" />
</template>

<style scoped>
.route-row-actions{display:flex;justify-content:flex-end;align-items:center;gap:var(--space-2)}
.route-destination{color:var(--color-text-primary)}
.route-strategy{display:block;color:var(--color-text-secondary);font-size:var(--font-size-body);font-weight:400}
</style>
