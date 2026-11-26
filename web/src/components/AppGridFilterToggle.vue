<script setup>
import AppIcon from './AppIcon.vue';
import {usePreferences} from '../preferences.js';
defineProps({open:Boolean,active:Boolean});defineEmits(['toggle']);const {t}=usePreferences();
</script>
<template><button type="button" class="row-menu-trigger table-filter-toggle" :class="{'is-active':active}" :aria-label="t('Фильтр')" :title="t('Фильтр')" :aria-expanded="open" :aria-pressed="active" @click="$emit('toggle')"><AppIcon name="filter" /></button></template>
