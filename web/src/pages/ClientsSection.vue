<script setup>
import ClientsPage from './ClientsPage.vue';
import {ref} from 'vue';
const clientPage=ref();
defineExpose({performEntityAction:(...args)=>clientPage.value?.performEntityAction(...args)});
defineProps(['api','run','can','busy']);
const filter=defineModel();
const emit=defineEmits(['journal']);
</script>
<template>
 <ClientsPage ref="clientPage" v-model="filter" :api="api" :run="run" :can="can" :busy="busy" @journal="emit('journal',$event)" />
</template>
