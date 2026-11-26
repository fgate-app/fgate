<script setup>
defineProps({modelValue:String,value:String,disabled:Boolean,label:String,size:{type:String,default:'m',validator:v=>['m','s'].includes(v)}});
const emit=defineEmits(['update:modelValue']);
</script>
<template>
  <label class="app-radio" :class="'control-'+size">
    <input type="radio" :value="value" :checked="modelValue===value" :disabled="disabled" @change="emit('update:modelValue',$event.target.value)" />
    <span class="radio-circle" aria-hidden="true">
      <svg viewBox="0 0 24 24"><circle v-if="modelValue===value" cx="12" cy="12" r="6" /></svg>
    </span>
    <span class="radio-label">{{label}}<slot/></span>
  </label>
</template>