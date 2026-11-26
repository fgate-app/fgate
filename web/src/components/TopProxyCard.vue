<script setup>
import {computed} from 'vue';
import DashboardChartCard from './DashboardChartCard.vue';
import {usePreferences} from '../preferences.js';
const props=defineProps({traffic:Object});
const {t,locale}=usePreferences();
const gateways=computed(()=>props.traffic?.topProxies || []);
const maximum=computed(()=>Math.max(1,...gateways.value.map(item=>item.upload+item.download)));
function bytes(value){let i=0;const units=['B','KB','MB','GB','TB'];while(value>=1024 && i<4){value/=1024;i++;}return new Intl.NumberFormat(locale.value,{maximumFractionDigits:i?1:0}).format(value)+' '+units[i];}
</script>
<template>
 <DashboardChartCard :title="t('Топ шлюзов')" icon="public" data-testid="top-proxy">
  <div v-if="traffic?.available && gateways.length" class="proxy-bars">
   <div v-for="item in gateways" :key="item.id" class="proxy-row">
    <div class="proxy-label"><span>{{item.name}}</span><b>{{bytes(item.upload+item.download)}}</b></div>
    <div class="proxy-track" role="meter" :aria-label="item.name" :aria-valuenow="item.upload+item.download" :aria-valuemax="maximum" aria-valuemin="0"><i :style="{width:100*(item.upload+item.download)/maximum+'%'}"/></div>
   </div>
  </div>
  <p v-else class="muted" role="status">{{t(traffic?.available?'Нет активных шлюзов':'Данные о трафике недоступны')}}</p>
 </DashboardChartCard>
</template>
<style scoped>
.proxy-bars{display:grid;gap:var(--space-3)}
.proxy-label{display:flex;justify-content:space-between;gap:var(--space-3);font-size:var(--font-size-body);margin-bottom:var(--space-1)}
.proxy-label span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.proxy-label b{font-weight:400;color:var(--color-text-secondary);white-space:nowrap}
.proxy-track{height:var(--space-2);background:var(--color-accent-soft);border-radius:var(--radius-pill);overflow:hidden}.proxy-track i{display:block;height:100%;background:var(--color-primary);border-radius:inherit}
</style>
