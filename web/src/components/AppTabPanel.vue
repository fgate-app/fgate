<script setup>
import { inject } from 'vue';
import { tabBarKey } from './tabs.js';
defineProps({value:{type:String,required:true}});
const bar=inject(tabBarKey);
if(!bar)throw new Error('AppTabPanel must be inside AppTabBar content slot');
</script>
<template><section v-show="bar.active.value===value" :id="bar.panelId(value)" :aria-labelledby="bar.tabId(value)" role="tabpanel"><slot/></section></template>
