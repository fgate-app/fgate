<script setup>
import { usePreferences } from '../preferences.js';
import AppButton from './AppButton.vue';
import AppDialog from './AppDialog.vue';

defineProps({
  open: Boolean,
  title: { type: String, default: '' },
  message: { type: String, default: '' },
  confirmLabel: { type: String, default: 'Удалить' },
  cancelLabel: { type: String, default: 'Отмена' },
  disabled: Boolean,
});
const emit = defineEmits(['close', 'confirm', 'closed']);
const { t } = usePreferences();
</script>

<template>
  <AppDialog :open="open" :title="title || t('Подтвердите удаление')" @close="emit('close')" @closed="emit('closed')">
    <div class="dialog-body">
      <slot><p class="confirm-message">{{ message }}</p></slot>
    </div>
    <template #footer>
      <AppButton variant="secondary" :disabled="disabled" @click="emit('close')">{{ t(cancelLabel) }}</AppButton>
      <AppButton data-testid="confirm-delete" :disabled="disabled" @click="emit('confirm')">{{ t(confirmLabel) }}</AppButton>
    </template>
  </AppDialog>
</template>
