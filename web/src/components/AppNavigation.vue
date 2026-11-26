<script setup>
import AppButton from './AppButton.vue';
import AppIcon from './AppIcon.vue';
import {usePreferences} from '../preferences.js';
defineProps({pages:Array,modelValue:String});const emit=defineEmits(['update:modelValue']);const {t}=usePreferences();
const icons={'Обзор':'overview','Подключения':'public','Журнал':'journal','Клиенты':'clients','Точки доступа':'incoming','Маршруты':'routes','Настройки':'settings'};
</script>
<template><nav class="main-navigation" :aria-label="t('Основная навигация')"><AppButton v-for="item in pages" :key="item" variant="secondary" :class="{active:modelValue===item}" :title="t(item)" :aria-label="t(item)" :aria-current="modelValue===item?'page':undefined" @click="emit('update:modelValue',item)"><AppIcon :name="icons[item]" /><span class="nav-label">{{t(item)}}</span></AppButton></nav></template>
