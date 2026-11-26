<script setup>
import artwork from '../../public/freedomgate.svg?raw';
defineProps({decorative:{type:Boolean,default:true}});
</script>
<template><span class="brand-logo" :role="decorative?undefined:'img'" :aria-label="decorative?undefined:'FreedomGate'" :aria-hidden="decorative?'true':undefined" v-html="artwork" /></template>
