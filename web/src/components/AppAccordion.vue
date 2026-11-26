<script setup>
import { useId } from 'vue';
import AppIcon from './AppIcon.vue';

const props = defineProps({
  open: Boolean,
  title: { type: String, required: true },
});
const emit = defineEmits(['update:open']);
const contentId = useId();

function toggle() {
  emit('update:open', !props.open);
}
</script>

<template>
  <div class="app-accordion">
    <button type="button" class="accordion-toggle" :aria-expanded="open" :aria-controls="contentId" @click="toggle">
      <span class="accordion-line" aria-hidden="true" />
      <span class="accordion-label">
        {{ title }}
        <AppIcon name="chevron" />
      </span>
      <span class="accordion-line" aria-hidden="true" />
    </button>
    <div v-if="open" :id="contentId" class="accordion-body">
      <slot />
    </div>
  </div>
</template>
