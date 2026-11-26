<script setup>
import { inject, watch, onUnmounted, useId } from 'vue';
import AppButton from './AppButton.vue';
import { tabBarKey } from './tabs.js';
const props=defineProps({value:{type:String,required:true},disabled:Boolean,controls:String});
const bar=inject(tabBarKey);
if(!bar)throw new Error('AppTab must be inside AppTabBar');
const key=useId();
watch(()=>[props.value,props.disabled],()=>bar.register({key,value:props.value,disabled:props.disabled}),{immediate:true});
onUnmounted(()=>bar.unregister(key));
</script>
<template><AppButton variant="secondary" class="app-tab" :class="{active:bar.active.value===value}" :size="bar.size.value" :id="bar.tabId(value)" role="tab" :aria-selected="bar.active.value===value" :aria-controls="controls || bar.panelId(value)" :tabindex="bar.tabbable.value===value?0:-1" :disabled="disabled" @click="bar.select(value)"><slot/></AppButton></template>
