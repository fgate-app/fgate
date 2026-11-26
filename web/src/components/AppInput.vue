<script setup>
import {ref} from 'vue';
import AppFieldAction from './AppFieldAction.vue';
defineOptions({inheritAttrs:false});
defineProps({modelValue:{type:[String,Number],default:''},size:{type:String,default:'m',validator:v=>['m','s'].includes(v)},disabled:Boolean,copyable:Boolean,actionIcon:String,actionLabel:String});
const emit=defineEmits(['update:modelValue','action']);
const element=ref();
defineExpose({focus:()=>element.value?.focus()});
</script>
<template>
 <span v-if="copyable || actionIcon" class="field-with-action field-with-action-input" :class="'field-control-'+size">
  <input ref="element" v-bind="$attrs" class="app-input" :class="'control-'+size" :disabled="disabled" :value="modelValue" @input="emit('update:modelValue',$event.target.value)"/>
  <AppFieldAction :copyable="copyable" :value="modelValue" :icon="actionIcon" :label="actionLabel" :disabled="disabled" @action="emit('action',$event)" />
 </span>
 <input v-else ref="element" v-bind="$attrs" class="app-input" :class="'control-'+size" :disabled="disabled" :value="modelValue" @input="emit('update:modelValue',$event.target.value)"/>
</template>
