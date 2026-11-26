<script setup>
import AppCount from './AppCount.vue';

defineProps({
  title: { type: String, default: '' },
  count: { type: [String, Number], default: null },
});
</script>

<template>
  <section class="data-card">
    <header class="data-card-head">
      <div class="data-card-title">
        <slot name="title">
          <h3>{{ title }}</h3>
          <AppCount v-if="count !== null" :value="count" />
        </slot>
      </div>
      <div v-if="$slots.actions" class="data-card-actions">
        <slot name="actions" />
      </div>
    </header>

    <div v-if="$slots.filters" class="data-card-filters">
      <slot name="filters" />
    </div>

    <div class="data-card-body">
      <slot />
    </div>
  </section>
</template>
