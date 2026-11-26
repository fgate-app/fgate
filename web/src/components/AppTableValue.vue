<script setup>
import {usePreferences} from '../preferences.js';
defineProps({value:[String,Number]});
const {t}=usePreferences();
</script>
<template><span v-if="value==null || value==='—'" class="table-placeholder" role="img" :aria-label="t('Нет данных')" /><template v-else>{{value}}</template></template>
<style scoped>
.table-placeholder{display:inline-block;width:var(--space-6);height:var(--space-2);border-radius:var(--radius-pill);background:var(--color-border-subtle);vertical-align:middle}
</style>
