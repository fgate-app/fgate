<script setup>
defineProps({label:{type:String,required:true}});
</script>
<template><span class="app-spinner" role="status" :aria-label="label" data-testid="app-spinner"><span aria-hidden="true" /></span></template>
<style scoped>
.app-spinner{display:inline-flex;align-items:center;width:var(--space-4);height:var(--space-4);color:var(--color-text-secondary)}
.app-spinner>span{box-sizing:border-box;width:100%;height:100%;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:app-spin .8s linear infinite}
@keyframes app-spin{to{transform:rotate(360deg)}}
@media(prefers-reduced-motion:reduce){.app-spinner>span{animation-duration:2s}}
</style>
