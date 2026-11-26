<script setup>
import {useId} from 'vue';
import NetworkTopology from './NetworkTopology.vue';
import {usePreferences} from '../preferences.js';
defineProps({setup: {type: Object, required: true},preview:Object,traffic:Object});
const {t} = usePreferences();
const headingId='network-current-'+useId();
</script>
<template>
  <section class="panel network-current" data-testid="network-summary" :aria-labelledby="headingId">
    <h4 :id="headingId">{{t('Текущая конфигурация')}}</h4>
    <NetworkTopology :setup="preview || setup" :traffic="traffic" />
  </section>
</template>
<style scoped>
.network-current{display:grid;gap:var(--space-6);min-width:0}
.network-current h4{margin:0}
</style>
