<script setup>
import AppPasswordInput from './AppPasswordInput.vue';
import {validUsername,validPassword} from '../../../shared/account-validation.js';
import {useFormFeedback} from '../composables/useFormFeedback.js';
import { computed, ref, watch } from 'vue';
import { usePreferences } from '../preferences.js';
import AppButton from './AppButton.vue';
import AppDialog from './AppDialog.vue';
import AppInput from './AppInput.vue';
import AppSelect from './AppSelect.vue';
const {validate}=useFormFeedback();

const props = defineProps({ open: Boolean, disabled: Boolean });
const emit = defineEmits(['close', 'add']);
const { t } = usePreferences();

const username = ref('');
const password = ref('');
const role = ref('viewer');

const roles = computed(() => [
  { value: 'admin', label: t('Администратор') },
  { value: 'operator', label: t('Оператор') },
  { value: 'viewer', label: t('Наблюдатель') },
]);

watch(
  () => props.open,
  open => {
    if (!open) return;
    username.value = '';
    password.value = '';
    role.value = 'viewer';
  },
);

function submit() {
  if(props.disabled)return;
  const name = username.value.trim();
  if(!validate([
    [validUsername(name),"Username: 3–40 Latin letters, digits, or _ . -"],
    [validPassword(password.value),"Password must be 12–256 characters."]
  ]))return;
  emit('add', { username: name, password: password.value, role: role.value });
}

</script>

<template>
  <AppDialog :form-state="[username,password,role]" :open="open" :title="t('Новый пользователь')" @close="emit('close')">
    <div class="dialog-body">
      <div class="form-section">
        <label>
          {{ t('Логин пользователя') }}
          <AppInput v-model="username" autocomplete="off" maxlength="40" :disabled="disabled" />
        </label>
        <label>
          {{ t('Начальный пароль') }}
          <AppPasswordInput v-model="password" autocomplete="new-password" maxlength="256" :disabled="disabled" />
        </label>
        <label>
          {{ t('Роль') }}
          <AppSelect v-model="role" :label="t('Роль')" :options="roles" :disabled="disabled" />
        </label>
      </div>
    </div>
    <template #footer>
      <AppButton variant="secondary" :disabled="disabled" @click="emit('close')">{{ t('Отмена') }}</AppButton>
      <AppButton data-testid="dialog-add-user" :disabled="disabled || !username.trim() || !password" @click="submit">{{ t('Добавить') }}</AppButton>
    </template>
  </AppDialog>
</template>
