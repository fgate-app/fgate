<script setup>
import {ref} from 'vue';
import AppFieldAction from './AppFieldAction.vue';
defineOptions({inheritAttrs:false});
defineProps({modelValue:{type:String,default:''},size:{type:String,default:'m',validator:v=>['m','s'].includes(v)},rows:{type:Number,default:6},placeholder:String,disabled:Boolean,copyable:Boolean,actionIcon:String,actionLabel:String});
const emit=defineEmits(['update:modelValue','action']);
const element=ref();
defineExpose({focus:()=>element.value?.focus()});
</script>
<template>
 <span v-if="copyable || actionIcon" class="field-with-action field-with-action-textarea" :class="'field-control-'+size">
  <textarea ref="element" v-bind="$attrs" class="app-textarea" :class="'control-'+size" :value="modelValue" :rows="rows" :placeholder="placeholder" :disabled="disabled" spellcheck="false" @input="emit('update:modelValue',$event.target.value)" />
  <AppFieldAction :copyable="copyable" :value="modelValue" :icon="actionIcon" :label="actionLabel" :disabled="disabled" @action="emit('action',$event)" />
 </span>
 <textarea v-else ref="element" v-bind="$attrs" class="app-textarea" :class="'control-'+size" :value="modelValue" :rows="rows" :placeholder="placeholder" :disabled="disabled" spellcheck="false" @input="emit('update:modelValue',$event.target.value)" />
</template>
