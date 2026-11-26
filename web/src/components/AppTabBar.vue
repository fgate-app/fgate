<script setup>
import { ref, computed, provide, useId } from 'vue';
import { tabBarKey } from './tabs.js';
defineOptions({inheritAttrs:false});
const props=defineProps({modelValue:{type:String,required:true},label:{type:String,required:true},size:{type:String,default:'m',validator:v=>['m','s'].includes(v)},id:String});
const emit=defineEmits(['update:modelValue']);
const generatedId=useId(),root=ref(),entries=ref([]);
const prefix=computed(()=>props.id || generatedId);
const active=computed(()=>props.modelValue);
const tabbable=computed(()=>entries.value.find(e=>e.value===active.value && !e.disabled)?.value ?? entries.value.find(e=>!e.disabled)?.value);
function register(entry){const index=entries.value.findIndex(e=>e.key===entry.key);if(index<0)entries.value.push(entry);else entries.value[index]=entry;}
function unregister(key){entries.value=entries.value.filter(e=>e.key!==key);}
function keydown(event){if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;const tabs=Array.from(root.value.querySelectorAll('[role="tab"]:not(:disabled)'));const index=tabs.indexOf(event.target);if(index<0 || !tabs.length)return;event.preventDefault();let next;if(event.key==='Home')next=0;else if(event.key==='End')next=tabs.length-1;else{const rtl=getComputedStyle(root.value).direction==='rtl';const step=(event.key==='ArrowRight'?1:-1)*(rtl?-1:1);next=(index+step+tabs.length)%tabs.length;}tabs[next].focus();tabs[next].click();tabs[next].scrollIntoView({block:'nearest',inline:'nearest'});}
provide(tabBarKey,{active,tabbable,size:computed(()=>props.size),register,unregister,select:value=>emit('update:modelValue',value),tabId:value=>prefix.value+'-tab-'+encodeURIComponent(value),panelId:value=>prefix.value+'-panel-'+encodeURIComponent(value)});
</script>
<template><div ref="root" v-bind="$attrs" :id="prefix" class="app-tabbar" :class="'control-'+size" role="tablist" :aria-label="label" aria-orientation="horizontal" @keydown="keydown"><slot/></div><slot name="panels"/></template>
