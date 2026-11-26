<script setup>
import { computed, useId } from 'vue';
import { getProtocol } from '../lib/protocols.js';
const props=defineProps({protocol:{type:String,default:'other'},size:{type:Number,default:24},monochrome:Boolean,decorative:Boolean});
const item=computed(()=>getProtocol(props.protocol));
const titleId=useId();
</script>
<template><span class="protocol-icon" :data-protocol="item.id" :class="{monochrome}" :style="{width:size+'px',height:size+'px'}"><svg :viewBox="item.viewBox" :role="decorative?undefined:'img'" :aria-hidden="decorative?'true':undefined" :aria-labelledby="decorative?undefined:titleId" focusable="false"><title v-if="!decorative" :id="titleId">{{item.label}}</title><path v-for="(shape,index) in item.shapes || [{path:item.path}]" :key="index" :d="shape.path" :fill-rule="shape.fillRule" fill="currentColor" /></svg></span></template>
