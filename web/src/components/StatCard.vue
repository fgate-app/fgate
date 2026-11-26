<script setup>
defineProps({label:String,value:[String,Number],description:String});
</script>
<template><article class="stat-card"><span>{{label}}</span><b :class="{subtle:typeof value==='string'}">{{value}}</b><small>{{description}}</small></article></template>
