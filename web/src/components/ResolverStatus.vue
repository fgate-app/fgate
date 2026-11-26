<script setup>
import { computed } from 'vue';
import { usePreferences } from '../preferences.js';

const props = defineProps({ status: Object });
const { t } = usePreferences();

const state = computed(() => props.status?.state || 'unknown');
const label = computed(
  () => ({ ok: 'Доступен', fail: 'Недоступен', unsupported: 'Не проверяется', unknown: 'Не проверено' })[state.value],
);
</script>

<template>
  <span class="resolver-status" :class="'is-' + state" role="status">
    <span class="resolver-dot" aria-hidden="true" />
    <span>
      {{ t(label) }}
      <small v-if="state === 'ok' && status?.ms"> · {{ status.ms }} {{ t('мс') }}</small>
      <small v-else-if="state === 'fail' && status?.error"> · {{ status.error }}</small>
    </span>
  </span>
</template>
