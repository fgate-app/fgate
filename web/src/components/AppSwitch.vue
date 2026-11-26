<script setup>
import {nextTick} from 'vue';
const props=defineProps({modelValue:Boolean,disabled:Boolean,label:String,hideLabel:Boolean,size:{type:String,default:'m',validator:v=>['m','s'].includes(v)}});
const emit=defineEmits(['update:modelValue']);
function change(event){const input=event.target;emit('update:modelValue',input.checked);nextTick(()=>{input.checked=props.modelValue;});}
</script>
<template><label class="app-switch" :class="'control-'+size"><input type="checkbox" role="switch" :aria-label="hideLabel?label:undefined" :checked="modelValue" :disabled="disabled" @change="change"/><span class="switch-track" aria-hidden="true"><span/></span><span v-if="!hideLabel && (label || $slots.default)">{{label}}<slot/></span></label></template>

<style scoped>
.app-switch input:not(:checked)+.switch-track>span{background:var(--color-surface)}
</style>
