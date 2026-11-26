<script setup>
import {connectionGroupActions} from '../lib/entity-actions.js';
import AppTableValue from '../components/AppTableValue.vue';
import AppGridFilters from '../components/AppGridFilters.vue';
import AppGridFilterToggle from '../components/AppGridFilterToggle.vue';
import AppTable from '../components/AppTable.vue';
import ProxyLatency from '../components/ProxyLatency.vue';
import {ref,computed} from 'vue';
import AppDataCard from '../components/AppDataCard.vue';
import AppButton from '../components/AppButton.vue';
import AppIcon from '../components/AppIcon.vue';
import AppRowMenu from '../components/AppRowMenu.vue';
import ConnectionGroupDialog from '../components/ConnectionGroupDialog.vue';
import {isInteractive} from '../lib/interactions.js';
import {usePreferences} from '../preferences.js';
const props=defineProps(['groups','profiles','telemetry','api','run','can','askConfirm','busy','routeCount','loading']);
const emit=defineEmits(['changed','routes']);
const {t}=usePreferences();
const editor=ref({open:false,group:null});
const open=group=>{editor.value={open:true,group};};
const name=id=>{const profile=props.profiles.find(profile=>profile.id===id);return profile?.builtin?t(profile.name):profile?.name || (props.groups.find(group=>group.id===id)?t('gatewayGroups.option',{name:props.groups.find(group=>group.id===id).name}):'—');};
const actions=()=>connectionGroupActions({t,can:props.can});
function select(group,action){
 if(action==='routes')emit('routes',group.id);
 if(action==='edit')open(group);
 if(action==='delete')props.askConfirm(t('Удалить группу?'),group.name,()=>props.run(async()=>{await props.api('connection-groups/'+group.id,{method:'DELETE'});emit('changed');}));
}
function save(payload){props.run(async()=>{
 await props.api('connection-groups'+(editor.value.group?'/'+editor.value.group.id:''),{method:editor.value.group?'PUT':'POST',body:JSON.stringify(payload)});
 emit('changed');editor.value.open=false;
});}
const filterOpen=ref(false),filter=ref({query:''});
const filteredGroups=computed(()=>props.groups.filter(group=>[group.name,...group.members.map(name)].join(' ').toLocaleLowerCase().includes(filter.value.query.trim().toLocaleLowerCase())));
defineExpose({createEntity:()=>{if(props.can('profiles:write'))open(null);},performEntityAction:(id,value)=>{const group=props.groups.find(row=>row.id===id);if(group&&actions().some(action=>action.value===value&&!action.disabled))return select(group,value);}});
</script>
<template>
  <AppDataCard :title="t('Группы подключений')" :count="filteredGroups.length">
    <template #actions><AppButton v-if="can('profiles:write')" variant="secondary" icon-only :aria-label="t('Добавить группу')" data-testid="add-connection-group" :disabled="busy" @click="open(null)"><AppIcon name="plus" /></AppButton></template>
    <template v-if="filterOpen" #filters><AppGridFilters v-model="filter" :search-label="t('Поиск групп')" /></template>
    <div class="table-wrap"><AppTable :loading="loading" class="data-table" data-testid="connection-groups-list">
      <thead><tr><th>{{t('Название')}}</th><th>{{t('Подключения')}}</th><th>{{t('Активное подключение')}}</th><th>{{t('Пинг')}}</th><th>{{t('Маршруты')}}</th><th class="actions-col filter-column-head"><AppGridFilterToggle :open="filterOpen" :active="!!filter.query" data-testid="toggle-gateway-group-filter" @toggle="filterOpen=!filterOpen" /></th></tr></thead>
      <tbody>
        <tr v-for="group in filteredGroups" :key="group.id" data-testid="connection-group-row" @click="!isInteractive($event) && can('profiles:write') && open(group)">
          <td>{{group.name}}</td><td><AppTableValue :value="group.members.map(name).join(', ')" /></td><td><AppTableValue :value="name(telemetry?.groups?.[group.id]?.selectedId)" /></td><td><ProxyLatency :history-key="'group:'+group.id" :metric="telemetry?.groups?.[group.id]" /></td>
          <td data-testid="connection-group-route-count">{{routeCount?.(group.id) ?? 0}}</td><td class="actions-cell"><AppRowMenu v-if="actions().length" :actions="actions()" :label="t('Действия')" :disabled="busy" @select="select(group,$event)" /></td>
        </tr>
        <tr v-if="!filteredGroups.length"><td colspan="6" class="table-empty">{{t(filter.query?'Ничего не найдено':'Групп пока нет')}}</td></tr>
      </tbody>
    </AppTable></div>
  </AppDataCard>
  <ConnectionGroupDialog :open="editor.open" :group="editor.group" :profiles="profiles" :groups="groups" :disabled="busy" @close="editor.open=false" @save="save" />
</template>
