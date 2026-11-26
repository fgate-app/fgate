<script setup>
import { computed } from 'vue';
import { scaleLinear, line } from 'd3';
const props=defineProps({samples:{type:Array,default:()=>[]},label:String});
const path=computed(()=>{const x=scaleLinear().domain([0,59]).range([0,600]),y=scaleLinear().domain([0,100]).range([100,0]);return line().defined(d=>Number.isFinite(d.value)).x((d,i)=>x(i)).y(d=>y(d.value))(props.samples)||'';});
</script>
<template><svg class="metric-chart" viewBox="0 0 600 110" role="img" :aria-label="label" preserveAspectRatio="none"><path d="M0 0H600M0 50H600M0 100H600" class="chart-grid"/><path :d="path" class="chart-line" /></svg></template>
