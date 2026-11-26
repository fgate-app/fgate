<script setup>
import {computed} from 'vue';
import AppDialog from './AppDialog.vue';
import {usePreferences} from '../preferences.js';
const props=defineProps({open:Boolean,connection:Object});const emit=defineEmits(['close']);
const {t,locale}=usePreferences();
function bytes(value){value=Number(value)||0;const units=['B','kB','MB','GB'];let i=0;while(value>=1000 && i<3){value/=1000;i++;}return new Intl.NumberFormat(locale.value,{maximumFractionDigits:1}).format(value)+' '+units[i];}
function endpoint(host,port){if(!host)return '';return (host.includes(':')?'['+host+']':host)+(port?':'+port:'');}
const sections=computed(()=>{
 const c=props.connection || {};
 return [
  ...(c.blocked?[{title:'Блокировка',rows:[['Источник блокировки',t(c.blockSource==='dns'?'DNS-фильтр':'Маршрут')],['Правило блокировки',c.ruleName?t(c.ruleName):''],['Попытки',c.attempts],['Тип DNS-запроса',c.dnsType]]}]:[]),
  {title:'Основные',rows:[['ID',c.id],['Начало',c.startedAt?new Date(c.startedAt).toLocaleTimeString(locale.value):''],['Правило',c.rule?t(c.rule):''],['Правило Payload',c.rulePayload]]},
  {title:'Трафик',rows:[['Входящий',bytes(c.download)],['Исходящий',bytes(c.upload)],['Скорость входящего',bytes(c.downloadSpeed)+'/s'],['Скорость исходящего',bytes(c.uploadSpeed)+'/s']]},
  {title:'Метаданные',rows:[['Сеть',c.network],['Тип',c.type],['Хост',c.host],['Sniff Host',c.sniffHost],['Режим DNS',c.dnsMode]]},
  {title:'Источник и назначение',rows:[['Источник',endpoint(c.sourceIP,c.sourcePort)],['Назначение',endpoint(c.host || c.destinationIP,c.destinationPort)],['Удалённое назначение',c.remoteDestination || c.destinationIP]]},
  {title:'Входящее подключение',rows:[['Имя входящего',c.inboundName],['IP входящего',endpoint(c.inboundIP,c.inboundPort)],['Входящий пользователь',c.inboundUser]]},
  {title:'Процесс',rows:[['Имя процесса',c.processName],['Путь процесса',c.processPath],['UID',c.uid]]}
 ];
});
</script>
<template>
 <AppDialog :open="open" :title="t('Информация о соединении')" @close="emit('close')">
  <div class="form-section" data-testid="connection-details">
   <section v-for="section in sections" :key="section.title" class="connection-details-section">
    <h4>{{t(section.title)}}</h4>
    <dl class="connection-details-list"><div v-for="[label,value] in section.rows" :key="label" class="connection-details-row"><dt>{{t(label)}}</dt><dd>{{value===0?0:value || '—'}}</dd></div></dl>
   </section>
  </div>
 </AppDialog>
</template>
<style scoped>
.connection-details-section{display:grid;gap:var(--space-4);margin:0}
.connection-details-section h4,.connection-details-list,.connection-details-list dd{margin:0}
.connection-details-list{display:grid;gap:var(--space-3);font-size:var(--font-size-body)}
.connection-details-row{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.6fr);gap:var(--space-4);align-items:baseline}
.connection-details-list dt{color:var(--color-text-secondary)}
.connection-details-list dd{overflow-wrap:anywhere;font-variant-numeric:tabular-nums}
@media(max-width:420px){.connection-details-row{grid-template-columns:minmax(0,1fr);gap:var(--space-1)}}
</style>
