<script setup>
import {computed} from 'vue';
import AppGridFilters from './AppGridFilters.vue';
import {usePreferences} from '../preferences.js';
const props=defineProps({options:Array,local:Boolean});const model=defineModel();const {t}=usePreferences();
const filters=computed(()=>props.local?[]:[{key:'connection',label:t('Фильтр по подключению'),options:[{value:'',label:t('Все подключения')},...props.options]}]);
</script>
<template><AppGridFilters v-model="model" :search-label="t('Поиск маршрутов')" :filters="filters" data-testid="route-filters" /></template>
