<script setup>
import {usePreferences} from '../preferences.js';
const {t}=usePreferences();
import AppIcon from './AppIcon.vue';
defineProps({
  label: { type: String, required: true },
  removable: { type: Boolean, default: false },
  disabled: Boolean,
  tone:{type:String,default:'neutral',validator:v=>['neutral','preset','user'].includes(v)},
  size: { type: String, default: 'm', validator: v => ['m', 's'].includes(v) },
});
const emit = defineEmits(['remove']);
</script>

<template>
  <span class="app-tag" :class="['control-'+size,{'tag-preset':tone==='preset','tag-user':tone==='user'}]">
    <span class="tag-text">{{ label }}</span>
    <button v-if="removable" type="button" class="tag-remove" :disabled="disabled" :aria-label="label" :title="t('Удалить')" @click="emit('remove')">
      <AppIcon name="close" />
    </button>
  </span>
</template>

<style scoped>
.app-tag.tag-preset{background:var(--chart-violet-soft);color:var(--chart-violet-strong);border-color:var(--chart-violet)}
.app-tag.tag-user{background:var(--color-secondary-active);color:var(--color-text-primary);border-color:var(--control-outline)}
.app-tag:is(.tag-preset,.tag-user) .tag-remove{color:inherit}
.app-tag.tag-preset .tag-remove:hover:not(:disabled){background:var(--chart-violet-strong);color:var(--chart-violet-subtle)}
.app-tag.tag-user .tag-remove:hover:not(:disabled){background:var(--color-border);color:var(--color-text-strong)}
</style>
