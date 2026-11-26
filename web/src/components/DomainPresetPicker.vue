<script setup>
import {computed,ref,watch} from 'vue';
import AppSelect from './AppSelect.vue';
import AppButton from './AppButton.vue';
import {usePreferences} from '../preferences.js';
const props=defineProps({catalog:Object,disabled:Boolean});
const emit=defineEmits(['add']);
const {t}=usePreferences();
const selected=ref(''),kind=ref('all');
watch(kind,()=>selected.value='');
const kindOptions=computed(()=>[{value:'all',label:t('Все пресеты')},{value:'service',label:t('Сервисы')},{value:'tracking',label:t('Реклама и трекеры')}]);
const options=computed(()=>(props.catalog?.presets || []).filter(preset=>!preset.hidden && (kind.value==='all' || (preset.kind || 'service')===kind.value)).map(preset=>({value:preset.id,label:(preset.combined?t('{name} (trackers and ads)',{name:t(preset.label)}):t(preset.label))+(preset.available?' · '+preset.count:''),disabled:!preset.available})));
</script>
<template>
 <div class="form-section" data-testid="domain-preset-picker">
  <label>{{t('Тип пресета')}}<AppSelect v-model="kind" :label="t('Тип пресета')" :options="kindOptions" :disabled="disabled" /></label>
  <label>{{t('Пресет доменов')}}<AppSelect v-model="selected" :label="t('Пресет доменов')" :options="options" :placeholder="t('Выберите пресет')" :disabled="disabled || !catalog" /></label>
  <AppButton :disabled="disabled || !selected" data-testid="add-selected-preset" @click="emit('add',selected)">{{t('Add to list')}}</AppButton>
 </div>
</template>
