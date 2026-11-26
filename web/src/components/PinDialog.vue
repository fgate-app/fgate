<script setup>
import {ipVersion} from '../lib/form-validation.js';
import {useFormFeedback} from '../composables/useFormFeedback.js';
import { computed, ref, watch } from 'vue';
import { usePreferences } from '../preferences.js';
import AppButton from './AppButton.vue';
import AppDialog from './AppDialog.vue';
import AppInput from './AppInput.vue';
const {validate}=useFormFeedback();

const props = defineProps({
  open: Boolean,
  disabled: Boolean,
  client: { type: Object, default: null },
});
const emit = defineEmits(['close', 'save']);
const { t } = usePreferences();

const ip = ref('');
const hostname = ref('');

watch(
  () => props.open,
  open => {
    if (!open) return;
    ip.value = props.client?.staticIp || props.client?.ip || '';
    hostname.value = props.client?.hostname || '';
  },
);

const title = computed(() => t('Статический адрес'));

function submit() {
  if(props.disabled)return;
  const value=ip.value.trim();
  if(!validate([
    [ipVersion(value)===4,'Укажите корректный IP-адрес.']
  ]))return;
  emit('save', { ip: value, hostname: hostname.value.trim() });
}

</script>

<template>
  <AppDialog :form-state="[ip,hostname]" :open="open" :title="title" @close="emit('close')">
    <div class="dialog-body">
      <div class="form-section">
        <label>
          {{ t('Клиент') }}
          <AppInput :model-value="client?.hostname || client?.mac || ''" disabled />
        </label>
        <label>
          {{ t('MAC-адрес') }}
          <AppInput :model-value="client?.mac || ''" disabled />
        </label>
        <label>
          {{ t('IP-адрес') }}
          <AppInput v-model="ip" maxlength="15" :disabled="disabled" placeholder="10.20.0.150" />
        </label>
        <label>
          {{ t('Имя хоста') }}
          <AppInput v-model="hostname" maxlength="100" :disabled="disabled" />
        </label>
      </div>
    </div>
    <template #footer>
      <AppButton variant="secondary" :disabled="disabled" @click="emit('close')">{{ t('Отмена') }}</AppButton>
      <AppButton data-testid="dialog-save-static" :disabled="disabled" @click="submit">{{ t('Сохранить') }}</AppButton>
    </template>
  </AppDialog>
</template>
