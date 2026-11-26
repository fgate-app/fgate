<script setup>
import { ref } from 'vue';
defineProps({disabled:Boolean,type:{type:String,default:'button'},variant:{type:String,default:'primary',validator:v=>['primary','secondary','outline','blanc'].includes(v)},size:{type:String,default:'m',validator:v=>['m','s'].includes(v)},iconOnly:Boolean});
const element=ref();
defineExpose({focus:()=>element.value?.focus()});
</script>
<template><button ref="element" :type="type" :disabled="disabled" class="app-button" :class="['button-'+variant,'control-'+size,{'button-icon':iconOnly}]"><slot/></button></template>

<style scoped>
.app-button.button-blanc{background:transparent;border-color:transparent;color:var(--color-text-primary);box-shadow:none}
.app-button.button-blanc:hover:not(:disabled){background:transparent;color:var(--color-text-strong);filter:none}
.app-button.button-blanc:active:not(:disabled){background:transparent;opacity:.75}
</style>
