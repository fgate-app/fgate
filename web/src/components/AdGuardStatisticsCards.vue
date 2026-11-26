<script setup>
import {computed} from 'vue';
import {usePreferences} from '../preferences.js';
import DashboardChartCard from './DashboardChartCard.vue';
import DashboardChart from './DashboardChart.vue';

const props=defineProps({statistics:Object});
const {t,locale}=usePreferences();
const samples=computed(()=>props.statistics?.samples || []);
const available=computed(()=>props.statistics?.available && samples.value.length>0);
const windowMs=computed(()=>{
 const interval=props.statistics?.interval || 3600000;
 return Math.max(interval,(samples.value.length-1)*interval);
});
function count(value){
 return Number.isFinite(value)?new Intl.NumberFormat(locale.value).format(value):'—';
}
</script>

<template>
 <DashboardChartCard :title="t('DNS-запросы')" icon="dns" data-testid="adguard-queries">
  <p class="adguard-summary">AdGuard Home · {{t('За период статистики')}}: {{count(statistics?.queries)}} · {{t('Заблокировано фильтрами')}}: {{count(statistics?.blocked)}}</p>
  <DashboardChart v-if="available" :samples="samples" :label="t('DNS-запросы')" :series="[{key:'queries',label:t('DNS-запросы'),color:'primary'},{key:'blocked',label:t('Заблокировано фильтрами'),color:'secondary'}]" count :window-ms="windowMs"/>
  <p v-else class="muted" role="status">{{t('Статистика AdGuard Home недоступна')}}</p>
 </DashboardChartCard>
</template>

<style scoped>
.adguard-summary{margin:0 0 var(--space-4);color:var(--color-text-secondary);font-size:var(--font-size-body)}
</style>
