<script setup>
import {ref} from 'vue';
import AppAccordion from './AppAccordion.vue';
import AppInput from './AppInput.vue';
import AppTextarea from './AppTextarea.vue';
import AppPasswordInput from './AppPasswordInput.vue';
import {usePreferences} from '../preferences.js';
const advanced=ref(false);
const form=defineModel({required:true});
defineProps({disabled:Boolean,lockedEndpoint:Boolean,lockedConnection:Boolean});
const {t}=usePreferences();
</script>
<template>
 <label>{{t('Название')}}<AppInput v-model="form.name" maxlength="100" :disabled="disabled || lockedEndpoint" /></label>
 <label>{{t('Адрес VPS')}}<AppInput v-model="form.host" :disabled="disabled || lockedEndpoint" placeholder="203.0.113.10" /></label>
 <slot name="host-info" />
 <label>{{t('SSH-логин')}}<AppInput v-model="form.username" :disabled="disabled || lockedConnection" autocomplete="off" /></label>
 <label>{{t('Закрытый SSH-ключ')}}<AppTextarea v-model="form.sshKey" :disabled="disabled" :rows="4" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" autocomplete="off" /></label>
 <AppAccordion v-model:open="advanced" :title="t('Дополнительно')"><div class="form-section">
  <label>{{t('Пароль SSH-ключа')}}<AppPasswordInput v-model="form.sshPassphrase" autocomplete="new-password" :disabled="disabled" /></label>
  <label>{{t('SSH-порт')}}<AppInput v-model="form.sshPort" type="number" min="1" max="65535" :disabled="disabled || lockedConnection" /></label>
  <slot />
 </div></AppAccordion>
</template>
