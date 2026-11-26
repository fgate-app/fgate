<script setup>
import {usePreferences} from '../preferences.js';
import StatCard from './StatCard.vue';
import DashboardChartCard from './DashboardChartCard.vue';
import AdGuardStatisticsCards from './AdGuardStatisticsCards.vue';
import DashboardChart from './DashboardChart.vue';
import TopProxyCard from './TopProxyCard.vue';
import NetworkArchitectureCard from './NetworkArchitectureCard.vue';
const emit=defineEmits(['node-action','create']);
defineProps({nodeActions:Function,actionsBusy:Boolean,createActions:Array,metrics:Object,samples:{type:Array,default:()=>[]},architectureGraph:{type:Object,default:()=>({nodes:[],edges:[],loading:true})}});const {t,locale}=usePreferences();
const count=value=>Number.isFinite(value)?new Intl.NumberFormat(locale.value).format(value):'—';
</script>
<template>
 <div class="overview-dashboard" data-testid="overview-dashboard">
  <NetworkArchitectureCard :graph="architectureGraph" :create-actions="createActions" @create="emit('create',$event)" :node-actions="nodeActions" :actions-busy="actionsBusy" @node-action="emit('node-action',$event)"/>
  <div class="overview-charts">
   <DashboardChartCard :title="t('Трафик')" icon="traffic" class="overview-traffic">
    <DashboardChart :samples="samples" :label="t('Трафик')" :series="[{key:'download',label:t('Входящий'),color:'primary'},{key:'upload',label:t('Исходящий'),color:'secondary'}]"/>
   </DashboardChartCard>
   <TopProxyCard :traffic="metrics?.traffic"/>
   <DashboardChartCard :title="t('Загрузка CPU')" icon="cpu">
    <DashboardChart :samples="samples" :label="t('Загрузка CPU')" :series="[{key:'cpu',color:'primary'}]" percent dynamic/>
   </DashboardChartCard>
   <DashboardChartCard :title="t('Использование памяти')" icon="memory">
    <DashboardChart :samples="samples" :label="t('Использование памяти')" :series="[{key:'memory',color:'primary'}]" percent dynamic/>
   </DashboardChartCard>
   <AdGuardStatisticsCards class="overview-dns" :statistics="metrics?.adguard"/>
  </div>
  <div class="stats overview-counts">
   <StatCard :label="t('Подключения')" :value="count(metrics?.counts?.gateways)"/>
   <StatCard :label="t('Подключённые устройства')" :value="count(metrics?.counts?.devices)"/>
   <StatCard :label="t('Точки доступа')" :value="count(metrics?.counts?.accessPoints)"/>
  </div>
 </div>
</template>
<style scoped>
.overview-dashboard,.overview-charts{display:grid;gap:var(--card-gap);min-width:0}
.overview-counts{margin:0;display:grid;gap:var(--card-gap);min-width:0}
.overview-counts{grid-template-columns:repeat(3,minmax(0,1fr))}
.overview-charts{grid-template-columns:repeat(2,minmax(0,1fr))}
.overview-dns{grid-column:1/-1}

.overview-dashboard :deep(.stat-card b){font-variant-numeric:tabular-nums;overflow-wrap:anywhere;font-weight:500;font-size:var(--font-size-metric)}
.overview-dashboard :deep(.stat-card small:empty){display:none}
@media(max-width:700px){.overview-counts{grid-template-columns:repeat(2,minmax(0,1fr))}
.overview-charts{grid-template-columns:minmax(0,1fr)}}
@media(max-width:420px){.overview-counts{grid-template-columns:minmax(0,1fr)}}
</style>
