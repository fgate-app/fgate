<script setup>
import AppInput from './AppInput.vue';
import AppSelect from './AppSelect.vue';
import AppButton from './AppButton.vue';
import {usePreferences} from '../preferences.js';
defineProps({searchLabel:String,filters:{type:Array,default:()=>[]}});
const model=defineModel({required:true});const {t}=usePreferences();
const update=(key,value)=>{model.value={...model.value,[key]:value};};
const reset=()=>{model.value=Object.fromEntries(Object.keys(model.value).map(key=>[key,'']));};
</script>
<template>
 <div class="grid-filter-controls" data-testid="grid-filters">
  <AppInput size="s" :model-value="model.query" :placeholder="searchLabel" :aria-label="searchLabel" type="search" @update:model-value="update('query',$event)" />
  <AppSelect v-for="filter in filters" :key="filter.key" size="s" :model-value="model[filter.key]" :label="filter.label" :options="filter.options" @update:model-value="update(filter.key,$event)" />
  <AppButton size="s" variant="secondary" @click="reset">{{t('Сбросить')}}</AppButton>
 </div>
</template>
<style scoped>
.grid-filter-controls{display:flex;flex-wrap:wrap;gap:var(--space-3);align-items:center;padding:var(--space-4);border:1px solid var(--color-divider);border-radius:var(--radius-control);background:var(--color-surface)}
.grid-filter-controls :deep(.app-input),.grid-filter-controls :deep(.custom-select){flex:1 1 calc(var(--space-12)*4);min-width:0}
.grid-filter-controls :deep(.app-button){flex:0 0 auto;width:auto;white-space:nowrap}
</style>
