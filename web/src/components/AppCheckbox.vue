<script setup>
defineProps({modelValue:Boolean,disabled:Boolean,label:String,size:{type:String,default:'m',validator:v=>['m','s'].includes(v)}});
const emit=defineEmits(['update:modelValue']);
</script>
<template>
  <label class="app-check" :class="'control-'+size">
    <input type="checkbox" :checked="modelValue" :disabled="disabled" @change="emit('update:modelValue',$event.target.checked)" />
    <span class="check-box" aria-hidden="true">
      <svg viewBox="0 0 24 24"><path d="M21,7L9,19L3.5,13.5L4.91,12.09L9,16.17L19.59,5.59L21,7Z" /></svg>
    </span>
    <span class="check-label">{{label}}<slot/></span>
  </label>
</template>
