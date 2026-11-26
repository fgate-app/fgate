<script setup>
import {computed} from 'vue';
import AppSwitch from './AppSwitch.vue';
import AppSelect from './AppSelect.vue';
import AppInput from './AppInput.vue';
import AppPasswordInput from './AppPasswordInput.vue';
import {usePreferences} from '../preferences.js';

const props = defineProps({modelValue: {type: Object, required: true}, interfaces: {type: Array, default: () => []}, disabled: Boolean});
const emit = defineEmits(['update:modelValue']);
const {t} = usePreferences();
const interfaceOptions = computed(() => props.interfaces.filter(item=>item.type!=='other').map(item => ({
  value: item.name,
  label: `${item.name} · ${item.type === 'wifi' ? t('Wi-Fi') : t('Ethernet')} · ${item.state}${item.carrier ? '' : ' · ' + t('без линка')}`
})));
const wiredOptions = computed(()=>interfaceOptions.value.filter(option=>props.interfaces.find(item=>item.name===option.value)?.type!=='wifi'));
const clientTypes = computed(() => [{value: 'ap', label: t('Точка доступа')}, {value: 'ethernet', label: 'Ethernet'}]);

function updateWiredDhcp(field,value) { update('wired','dhcp',{...props.modelValue.wired.dhcp,[field]:value}); }
function update(section, field, value) {
  if (props.disabled) return;
  const next={...props.modelValue, [section]: {...props.modelValue[section], [field]: value}};
  if(section==='client' && field==='type') {
    if(value==='ethernet') next.wired={...next.wired,enabled:false};
    else next.client.vlanId='';
  }
  emit('update:modelValue', next);
}
</script>
<template>
  <div class="network-fields">
    <h4>{{t('Вход (uplink)')}}</h4>
    <div class="form-section network-field-row">
      <label>{{t('Вход (uplink)')}}<AppSelect :model-value="modelValue.uplink.interface" :label="t('Вход (uplink)')" :options="interfaceOptions" :disabled="disabled" @update:model-value="update('uplink','interface',$event)" /></label>
    </div>
    <p class="network-hint">{{t('Для uplink можно выбрать готовый VLAN-интерфейс. Его адрес и маршрут сохраняются.')}}</p>
    <h4>{{t('Клиентская сеть')}}</h4>
    <div class="form-section network-field-row">
      <label>{{t('Выход (клиенты)')}}<AppSelect :model-value="modelValue.client.interface" :label="t('Выход (клиенты)')" :options="interfaceOptions" :disabled="disabled" @update:model-value="update('client','interface',$event)" /></label>
      <label>{{t('Тип выхода')}}<AppSelect :model-value="modelValue.client.type" :label="t('Тип выхода')" :options="clientTypes" :disabled="disabled" @update:model-value="update('client','type',$event)" /></label>
    </div>
    <h4 v-if="modelValue.client.type==='ap'">{{t('Точка доступа Wi-Fi')}}</h4>
    <div v-if="modelValue.client.type==='ap'" class="form-section network-field-row">
      <label>SSID<AppInput :model-value="modelValue.client.ssid" maxlength="32" :disabled="disabled" @update:model-value="update('client','ssid',$event)" /></label>
      <label>{{t('Пароль Wi-Fi')}}<AppPasswordInput :model-value="modelValue.client.password" autocomplete="new-password" minlength="8" maxlength="63" :disabled="disabled" @update:model-value="update('client','password',$event)" /></label>
    </div>
    <div v-if="modelValue.client.type==='ethernet'" class="form-section network-field-row">
      <label>{{t('VLAN ID (необязательно)')}}<AppInput :model-value="modelValue.client.vlanId" type="number" min="1" max="4094" :disabled="disabled" @update:model-value="update('client','vlanId',$event)" /></label>
    </div>
    <div class="form-section network-field-row">
      <label>{{t('Подсеть клиентов')}}<AppInput :model-value="modelValue.client.subnet" placeholder="10.10.0.1/24" :disabled="disabled" @update:model-value="update('client','subnet',$event)" /></label>
      <label>{{t('DHCP от')}}<AppInput :model-value="modelValue.dhcp.start" :disabled="disabled" @update:model-value="update('dhcp','start',$event)" /></label>
      <label>{{t('DHCP до')}}<AppInput :model-value="modelValue.dhcp.end" :disabled="disabled" @update:model-value="update('dhcp','end',$event)" /></label>
    </div>
    <template v-if="modelValue.client.type==='ap'">
      <h4>{{t('Проводная клиентская сеть')}}</h4>
      <div class="form-section">
        <AppSwitch :label="t('Включить проводную сеть')" :model-value="modelValue.wired.enabled" :disabled="disabled" @update:model-value="update('wired','enabled',$event)" />
        <template v-if="modelValue.wired.enabled">
          <div class="network-field-row">
            <label>{{t('Проводной порт')}}<AppSelect :label="t('Проводной порт')" :model-value="modelValue.wired.interface" :options="wiredOptions" :disabled="disabled" @update:model-value="update('wired','interface',$event)" /></label>
            <label>{{t('VLAN ID (необязательно)')}}<AppInput :model-value="modelValue.wired.vlanId" type="number" min="1" max="4094" :disabled="disabled" @update:model-value="update('wired','vlanId',$event)" /></label>
          </div>
          <div class="network-field-row">
            <label>{{t('Подсеть проводных клиентов')}}<AppInput :model-value="modelValue.wired.subnet" :disabled="disabled" @update:model-value="update('wired','subnet',$event)" /></label>
            <label>{{t('Проводной DHCP от')}}<AppInput :model-value="modelValue.wired.dhcp.start" :disabled="disabled" @update:model-value="updateWiredDhcp('start',$event)" /></label>
            <label>{{t('Проводной DHCP до')}}<AppInput :model-value="modelValue.wired.dhcp.end" :disabled="disabled" @update:model-value="updateWiredDhcp('end',$event)" /></label>
          </div>
          <p class="network-hint">{{t('На общем порту с uplink укажите VLAN. Подсети Wi-Fi, проводной сети и uplink не должны пересекаться.')}}</p>
        </template>
      </div>
    </template>
  </div>
</template>
<style scoped>
.network-fields h4,.network-hint{margin:0}
.network-hint{font-size:var(--font-size-body);color:var(--color-text-secondary)}
.network-fields{display:grid;gap:var(--space-6);min-width:0}
.network-field-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,240px),1fr));gap:var(--space-6);margin:0}
.network-field-row label{min-width:0}
</style>
