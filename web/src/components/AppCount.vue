<script setup>
defineProps({
  value: { type: [Number, String], required: true },
  label: { type: String, default: '' },
});
</script>

<template>
  <span class="app-count" :aria-label="label || undefined">{{ value }}</span>
</template>
