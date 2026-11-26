<script setup>
import AppPasswordInput from './AppPasswordInput.vue';
import {validPassword} from '../../../shared/account-validation.js';
import {useFormFeedback} from '../composables/useFormFeedback.js';
import { computed, ref, watch } from 'vue';
import { usePreferences } from '../preferences.js';
import AppButton from './AppButton.vue';
import AppDialog from './AppDialog.vue';
const {validate}=useFormFeedback();

const props = defineProps({
  open: Boolean,
  disabled: Boolean,
  user: { type: Object, default: null },
  self: Boolean,
});
const emit = defineEmits(['close', 'save']);
const { t } = usePreferences();

const currentPassword = ref('');
const password = ref('');
const confirm = ref('');

watch(
  () => props.open,
  open => {
    if (!open) return;
    currentPassword.value = '';
    password.value = '';
    confirm.value = '';
  },
);

const title = computed(() => t('Смена пароля'));

function submit() {
  if(props.disabled)return;
  if(!validate([
    [!props.self || !!currentPassword.value,'Введите текущий пароль.'],
    [validPassword(password.value),"Password must be 12–256 characters."],
    [password.value===confirm.value,'Пароли не совпадают.']
  ]))return;
  emit('save', props.self ? { currentPassword: currentPassword.value, password: password.value } : { password: password.value });
}

</script>

<template>
  <AppDialog :form-state="[currentPassword,password,confirm]" :open="open" :title="title" @close="emit('close')">
    <div class="dialog-body">
      <div class="form-section">
        <p class="muted">{{ user?.username }}</p>
        <label v-if="self">
          {{ t('Текущий пароль') }}
          <AppPasswordInput v-model="currentPassword" autocomplete="current-password" maxlength="256" :disabled="disabled" />
        </label>
        <label>
          {{ t('Новый пароль') }}
          <AppPasswordInput v-model="password" autocomplete="new-password" maxlength="256" :disabled="disabled" />
        </label>
        <label>
          {{ t('Повторите новый пароль') }}
          <AppPasswordInput v-model="confirm" autocomplete="new-password" maxlength="256" :disabled="disabled" />
        </label>
      </div>
    </div>
    <template #footer>
      <AppButton variant="secondary" :disabled="disabled" @click="emit('close')">{{ t('Отмена') }}</AppButton>
      <AppButton data-testid="dialog-save-password" :disabled="disabled || !password || !confirm || (self && !currentPassword)" @click="submit">{{ t('Сохранить') }}</AppButton>
    </template>
  </AppDialog>
</template>
