<script setup>
import {computed} from 'vue';
import AppDialog from './AppDialog.vue';import AppButton from './AppButton.vue';import AppCheckbox from './AppCheckbox.vue';
import {useProgressiveList} from '../lib/progressive.js';import {usePreferences} from '../preferences.js';
const props=defineProps({open:Boolean,records:{type:Array,default:()=>[]},modelValue:{type:Array,default:()=>[]},disabled:Boolean,single:Boolean});
const emit=defineEmits(['close','update:modelValue','confirm']);const {t}=usePreferences();
const rows=computed(()=>props.records),{visible,onScroll}=useProgressiveList(rows);
</script>
<template>
 <AppDialog :form-state="modelValue" :open="open" :title="t('Выберите подключения')" @close="emit('close')">
  <div class="form-section"><AppCheckbox v-if="!single" :model-value="modelValue.length===records.length" :label="t('Выбрать все')" :disabled="disabled" @update:model-value="emit('update:modelValue',$event?records.map(r=>r.key):[])" /><p class="muted" role="status">{{t('Выбрано')}}: {{modelValue.length}} / {{records.length}}</p><div class="gateway-pick-list" @scroll="onScroll"><AppCheckbox v-for="row in visible" :key="row.key" :model-value="modelValue.includes(row.key)" :label="row.label" :disabled="disabled" @update:model-value="emit('update:modelValue',$event?(single?[row.key]:[...modelValue,row.key]):modelValue.filter(key=>key!==row.key))" /></div></div>
  <template #footer><AppButton variant="secondary" :disabled="disabled" @click="emit('close')">{{t('Отмена')}}</AppButton><AppButton :disabled="disabled || !modelValue.length" data-testid="gateway-add-selected" @click="emit('confirm')">{{t(single?'Сохранить':'Добавить выбранные')}}</AppButton></template>
 </AppDialog>
</template>
<style scoped>
.gateway-pick-list{display:grid;gap:var(--space-2);max-height:50dvh;overflow:auto}
.gateway-pick-list :deep(.check-label){overflow-wrap:anywhere}
p{margin:0}
</style>
