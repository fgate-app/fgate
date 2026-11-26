<script setup>
import {resolveCountryCode} from '../lib/countries.js';
import AppTableValue from './AppTableValue.vue';
import {computed} from 'vue';
import AppSpinner from './AppSpinner.vue';
import {usePreferences} from '../preferences.js';
const props=defineProps({location:Object});
const {t,locale}=usePreferences();
const countryCode=computed(()=>resolveCountryCode(props.location));
const country=computed(()=>countryCode.value?new Intl.DisplayNames([locale.value],{type:'region'}).of(countryCode.value):props.location?.country?t('location.countryUnknown'):'');
const flag=computed(()=>{
 const code=countryCode.value;
 if(!/^[A-Z]{2}$/.test(code))return '';
 try{if(!new Intl.DisplayNames(['en'],{type:'region',fallback:'none'}).of(code))return '';}catch{return '';}
 return String.fromCodePoint(...[...code].map(letter=>0x1f1e6+letter.charCodeAt(0)-65));
});
const place=computed(()=>{
 const value=props.location;if(!value)return '';
 return [...new Set([country.value,value.city || value.region].filter(Boolean))].join(' · ');
});
const details=computed(()=>{
 const value=props.location;if(!value?.ip)return '';
 const checked=value.checkedAt?new Date(value.checkedAt):null;
 return [...new Set([country.value,value.region,value.city,value.asn].filter(Boolean)),
  value.source?t('Источник')+': '+value.source:null,
  checked && Number.isFinite(checked.getTime())?t('Проверено')+': '+checked.toLocaleString(locale.value):null].filter(Boolean).join(' · ');
});
</script>
<template>
 <div class="gateway-location" :title="details" data-testid="gateway-location">
  <template v-if="location?.ip"><span v-if="place"><span v-if="flag" class="gateway-country-flag" aria-hidden="true">{{flag}}</span>{{place}}</span><span v-if="location.provider">{{location.provider}}</span><span class="gateway-location-ip">{{location.ip}}</span></template>
  <AppSpinner v-else-if="location?.status==='checking'" :label="t('Определение…')" />
  <AppTableValue v-else />
 </div>
</template>
<style scoped>
.gateway-location{display:grid;gap:var(--space-1);min-width:calc(var(--space-8)*5);max-width:calc(var(--space-10)*7);font-size:var(--font-size-body);font-weight:400;color:var(--color-text-secondary);overflow-wrap:anywhere}
.gateway-country-flag{margin-inline-end:var(--space-1)}
.gateway-location-ip{font-variant-numeric:tabular-nums}
</style>
