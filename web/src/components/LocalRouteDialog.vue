<script setup>
import {normalizeLocalRoute} from '../lib/form-validation.js';
import {useFormFeedback} from '../composables/useFormFeedback.js';
import { computed, ref, watch } from 'vue';
import { usePreferences } from '../preferences.js';
import AppButton from './AppButton.vue';
import AppDialog from './AppDialog.vue';
import AppInput from './AppInput.vue';
const {reportError,validate}=useFormFeedback();

const props = defineProps({
  open: Boolean,
  disabled: Boolean,
  route: { type: Object, default: null },
});
const emit = defineEmits(['close', 'save']);
const { t } = usePreferences();

const alias = ref('');
const target = ref('');

watch(
  () => props.open,
  open => {
    if (!open) return;
    alias.value = props.route?.alias || '';
    target.value = props.route?.target || '';
  },
);

const title = computed(() => (props.route ? t('Редактировать псевдоним') : t('Новый псевдоним')));

function submit() {
  if(props.disabled)return;
  if(!validate([
    [!!alias.value.trim(),'Укажите псевдоним.'],
    [!!target.value.trim(),'Укажите адрес.']
  ]))return;
  try{emit('save',normalizeLocalRoute({alias:alias.value,target:target.value}));}catch(error){reportError(error);}
}

</script>

<template>
  <AppDialog :form-state="[alias,target]" :open="open" :title="title" @close="emit('close')">
    <div class="dialog-body">
      <div class="form-section">
        <label>
          {{ t('Псевдоним') }}
          <AppInput v-model="alias" maxlength="253" :disabled="disabled" placeholder="router.home" />
        </label>
        <label>
          {{ t('Адрес') }}
          <AppInput v-model="target" maxlength="253" :disabled="disabled" :placeholder="t('192.168.1.1 или youtube.com')" />
        </label>
      </div>
    </div>
    <template #footer>
      <AppButton variant="secondary" :disabled="disabled" @click="emit('close')">{{ t('Отмена') }}</AppButton>
      <AppButton data-testid="dialog-save-local-route" :disabled="disabled" @click="submit">{{ t('Сохранить') }}</AppButton>
    </template>
  </AppDialog>
</template>
