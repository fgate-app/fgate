<script setup>
import AppTag from '../components/AppTag.vue';
import AppTableValue from '../components/AppTableValue.vue';
import {computed} from 'vue';
import AppDataCard from '../components/AppDataCard.vue';
import AppTable from '../components/AppTable.vue';
import AppGridFilters from '../components/AppGridFilters.vue';
import AppGridFilterToggle from '../components/AppGridFilterToggle.vue';
import AppSwitch from '../components/AppSwitch.vue';
import AppRowMenu from '../components/AppRowMenu.vue';
import GatewayLocation from '../components/GatewayLocation.vue';
import ProxyLatency from '../components/ProxyLatency.vue';
import {usePreferences} from '../preferences.js';
import {formatTrafficRate as traffic} from '../lib/formatters.js';
const props=defineProps({profiles:Array,loading:Boolean,busy:Boolean,can:Function,telemetry:Object,routeCount:Function,actions:Function,displayName:Function,exitType:Function,api:Function});
const emit=defineEmits(['add','deploy','row','toggle','action','changed','subscription']);
function addAction(value){if(value==='subscription')emit('subscription');else emit(value==='deploy'?'deploy':'add');}
const gatewayFilter=defineModel('filter',{required:true});
const gatewayFilterOpen=defineModel('filterOpen',{required:true});
const {t}=usePreferences();
const gatewayFilterActive=computed(()=>Object.values(gatewayFilter.value).some(Boolean));
const wrappingLabel=p=>props.profiles.find(row=>row.id===p.gatewayId)?.name || t('Шлюз недоступен');
const torType=p=>{const state=props.telemetry?.profiles?.[p.id]?.tor || p.tor;if(p.enabled===false)return 'Tor · '+t('Остановлен');if(state?.state==='ready')return 'Tor · '+t(state.mode==='snowflake'?'Through Snowflake':'Direct Tor connection');return 'Tor · '+t(state?.message || 'Tor is stopped.')+(state?.state==='connecting'?' '+(state.progress || 0)+'%':'');};
const gatewayType=profile=>['direct','zapret'].includes(profile.engine)?profile.engine:profile.protocol;
const gatewayFilterOptions=computed(()=>[
 {key:'status',label:t('Статус'),options:[{value:'',label:t('Все статусы')},{value:'enabled',label:t('Включено')},{value:'disabled',label:t('Отключено')}]},
 {key:'type',label:t('Тип прокси'),options:[{value:'',label:t('Все типы')},...Array.from(new Set(props.profiles.map(gatewayType))).map(type=>({value:type,label:type==='direct'?t('Direct'):type==='zapret'?t('Обход DPI'):type==='ss'?'Outline/Shadowsocks':String(type).toUpperCase()}))]}
]);
const filteredGateways=computed(()=>props.profiles.filter(profile=>{
 const {query,status,type}=gatewayFilter.value;
 return (!query.trim() || [props.displayName(profile),profile.protocol,profile.engine,props.exitType(profile)].join(' ').toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) && (!status || (profile.enabled===false?'disabled':'enabled')===status) && (!type || gatewayType(profile)===type);
}));

</script>
<template>
        <div class="card-stack">
          <AppDataCard :title="t('Способы выхода в интернет')" :count="filteredGateways.length">
            <template #actions>
              <AppRowMenu v-if="can('profiles:write')" icon="plus" test-id="add-exit" :label="t('Добавить способ выхода')" :disabled="busy" :actions="[{value:'import',label:t('Add config')},{value:'subscription',label:t('Добавить подписку')},...(can('settings:write')?[{value:'deploy',label:t('Deploy VPN')}]:[])]" @select="addAction" />
            </template>
            <template v-if="gatewayFilterOpen" #filters><AppGridFilters v-model="gatewayFilter" :search-label="t('Поиск шлюзов')" :filters="gatewayFilterOptions" /></template>
            <div class="table-wrap">
              <AppTable class="data-table" data-testid="exit-list" :loading="loading">
                <thead>
                  <tr>
                    <th class="toggle-col" :aria-label="t('Включено')"></th>
                    <th>{{t("Название")}}</th>
                    <th>{{t("Маршруты")}}</th>
                    <th>{{t("Трафик")}}</th><th>{{t("Регион / провайдер / IP")}}</th><th>{{t("Пинг")}}</th>
                    <th class="actions-col filter-column-head" :aria-label="t('Действия')"><AppGridFilterToggle :open="gatewayFilterOpen" :active="gatewayFilterActive" data-testid="toggle-gateway-filter" @toggle="gatewayFilterOpen=!gatewayFilterOpen" /></th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-if="!loading && !filteredGateways.length"><td colspan="7" class="table-empty">{{t(gatewayFilterActive?'Ничего не найдено':'Здесь появятся ваши способы выхода')}}</td></tr>
                  <tr v-for="p in filteredGateways" :key="p.id" data-testid="exit-row" :data-engine="p.engine" @click="$emit('row',p,$event)">
                    <td class="toggle-cell" @click.stop><AppSwitch v-if="p.engine!=='direct'" size="s" :model-value="p.enabled!==false" :label="t('Включено')+': '+displayName(p)" hide-label :disabled="busy || !can('profiles:write')" @update:model-value="$emit('toggle',p,$event)" /></td>
                    <td class="name-cell">
                      <div class="protocol-label">
                        <div class="gateway-name"><div class="gateway-title"><strong>{{displayName(p)}}</strong><AppTag v-if="p.managed" :label="t('Управляемый')" size="s" data-testid="gateway-managed" /></div><span class="gateway-type" data-testid="connection-type">{{p.engine==='tor'?torType(p):exitType(p)}}</span><span v-if="p.subscriptionId" class="gateway-type" data-testid="gateway-subscription">{{p.subscriptionName}}{{p.subscriptionMissing?' · '+t('Not in current subscription'):''}}</span><span v-if="p.gatewayId" class="gateway-type" data-testid="gateway-wrapped">{{t('Через')}} {{wrappingLabel(p)}}</span></div>
                      </div>
                    </td>
                    <td data-testid="connection-route-count">{{routeCount(p.id)}}</td>
                    <td data-testid="connection-traffic"><span class="table-traffic-value"><AppTableValue :value="telemetry?.profiles?.[p.id]?.available ? '↓ '+traffic(telemetry.profiles[p.id].download)+' · ↑ '+traffic(telemetry.profiles[p.id].upload):'—'" /></span></td>
                    <td data-testid="connection-location"><GatewayLocation :location="telemetry?.profiles?.[p.id]?.location" /></td>
                    <td data-testid="connection-ping"><ProxyLatency :history-key="'profile:'+p.id" :metric="telemetry?.profiles?.[p.id]" /></td>
                    <td class="actions-cell">
                      <AppRowMenu v-if="actions(p).length" :actions="actions(p)" :label="t('Действия')" :disabled="busy" @select="$emit('action',p,$event)" />
                    </td>
                  </tr>
                </tbody>
              </AppTable>
            </div>
          </AppDataCard>

        </div>
</template>
<style scoped>
.gateway-name{display:grid;gap:var(--space-1);min-width:0}
.gateway-type{font-size:var(--font-size-body);font-weight:400;color:var(--color-text-secondary);overflow-wrap:anywhere}
 .gateway-title{display:flex;align-items:center;gap:var(--space-2);width:max-content}
</style>
