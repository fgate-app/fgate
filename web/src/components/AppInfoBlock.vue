<script setup>
import AppIcon from './AppIcon.vue';
defineProps({variant:{type:String,default:'info',validator:value=>['info','warning','danger'].includes(value)}});
</script>
<template>
 <div class="app-info-block" :class="'app-info-block--'+variant">
  <AppIcon :name="variant==='info'?'info':'warning'" />
  <div class="info-block-content"><slot /></div>
 </div>
</template>
<style scoped>
.app-info-block{display:flex;align-items:flex-start;gap:var(--space-3);padding:var(--space-4);border-radius:var(--radius-control);margin:0;font-size:var(--font-size-body);font-weight:400;line-height:1.5;background:var(--info-block-background);color:var(--info-block-foreground)}
.app-info-block--info{--info-block-background:var(--color-info-surface);--info-block-foreground:var(--color-info-text)}
.app-info-block--warning{--info-block-background:var(--color-warning-surface);--info-block-foreground:var(--color-warning-text)}
.app-info-block--danger{--info-block-background:var(--color-critical-surface);--info-block-foreground:var(--color-critical-text)}
.app-info-block>.app-icon{flex:none;width:var(--space-5);height:var(--space-5)}
.info-block-content{min-width:0;overflow-wrap:anywhere}
.info-block-content :deep(p){margin:0}
</style>
