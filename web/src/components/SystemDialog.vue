<script setup>
import { usePreferences } from '../preferences.js';
import AppButton from './AppButton.vue';
import AppDialog from './AppDialog.vue';
import AppIcon from './AppIcon.vue';

defineProps({ open: Boolean, disabled: Boolean });
const emit = defineEmits(['close', 'action']);
const { t } = usePreferences();
</script>

<template>
  <AppDialog :open="open" :title="t('Перезагрузить')" @close="emit('close')">
    <div class="dialog-body">
      <div class="form-section">
        <AppButton variant="secondary" data-testid="system-config" :disabled="disabled" @click="emit('action', 'config')">
          <AppIcon name="restart" />{{ t('Перезагрузить конфиг') }}
        </AppButton>
        <AppButton variant="secondary" data-testid="system-reboot" :disabled="disabled" @click="emit('action', 'reboot')">
          <AppIcon name="restart" />{{ t('Перезагрузить систему') }}
        </AppButton>
        <AppButton variant="secondary" data-testid="system-poweroff" :disabled="disabled" @click="emit('action', 'poweroff')">
          <AppIcon name="power" />{{ t('Выключить') }}
        </AppButton>
      </div>
    </div>
  </AppDialog>
</template>
