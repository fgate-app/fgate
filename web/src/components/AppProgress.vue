<script setup>
import {computed} from 'vue';
const props=defineProps({value:{type:Number,default:0},max:{type:Number,default:100},label:{type:String,required:true}});
const maximum=computed(()=>Number.isFinite(props.max)&&props.max>0?props.max:1);
const current=computed(()=>Number.isFinite(props.value)?Math.max(0,Math.min(props.value,maximum.value)):0);
</script>
<template><progress class="app-progress" :value="current" :max="maximum" :aria-label="label" /></template>
<style scoped>
.app-progress{appearance:none;-webkit-appearance:none;display:block;width:100%;min-width:0;height:var(--space-2);padding:0;border:0;border-radius:var(--radius-pill);overflow:hidden;background:var(--color-secondary-active);color:var(--color-primary);accent-color:var(--color-primary)}
.app-progress::-webkit-progress-bar{background:var(--color-secondary-active);border-radius:var(--radius-pill)}
.app-progress::-webkit-progress-value{background:var(--color-primary);border-radius:var(--radius-pill);transition:width .2s ease}
.app-progress::-moz-progress-bar{background:var(--color-primary);border-radius:var(--radius-pill);transition:width .2s ease}
@media(prefers-reduced-motion:reduce){.app-progress::-webkit-progress-value{transition:none}.app-progress::-moz-progress-bar{transition:none}}
</style>
