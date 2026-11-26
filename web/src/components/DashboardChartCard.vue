<script setup>
import AppDataCard from './AppDataCard.vue';
import AppIcon from './AppIcon.vue';

defineProps({title:{type:String,required:true},icon:{type:String,required:true}});
</script>

<template>
 <AppDataCard :title="title">
  <template #title>
   <AppIcon :name="icon" class="overview-chart-icon"/>
   <h3>{{title}}</h3>
  </template>
  <div class="overview-chart-body"><slot/></div>
 </AppDataCard>
</template>

<style scoped>
:deep(.data-card-title){align-items:center;flex-wrap:nowrap}
:deep(.data-card-title h3){line-height:1.25}
.overview-chart-icon{width:var(--space-5);height:var(--space-5);flex-shrink:0;color:var(--color-text-secondary)}
.overview-chart-body{padding:var(--space-6)}
@media(max-width:700px){.overview-chart-body{padding:var(--space-4)}}
</style>
