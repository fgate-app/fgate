<script setup>
import {ref, watch,onMounted,onUpdated} from 'vue';
import AppInput from './AppInput.vue';
import AppButton from './AppButton.vue';
import AppIcon from './AppIcon.vue';
import {usePreferences} from '../preferences.js';

defineOptions({inheritAttrs: false});
const props = defineProps({
  modelValue: {type: String, default: ''},
  size: {type: String, default: 'm', validator: value => ['m','s'].includes(value)},
  disabled: Boolean
});
const emit = defineEmits(['update:modelValue']);
const {t} = usePreferences();
const visible = ref(false), input = ref(),root=ref(),fieldLabel=ref('');
function syncLabel(){fieldLabel.value=root.value?.closest('label')?.textContent.trim() || '';}
onMounted(syncLabel);onUpdated(syncLabel);
watch(() => props.disabled, () => { visible.value = false; });
watch(() => props.modelValue, value => { if (!value) visible.value = false; });
defineExpose({focus: () => input.value?.focus()});
</script>
<template>
  <span ref="root" class="password-input" :class="'password-input-'+size">
    <AppInput ref="input" v-bind="$attrs" :aria-label="$attrs['aria-label'] || fieldLabel || undefined" :model-value="modelValue" :size="size" :disabled="disabled" :type="visible?'text':'password'" @update:model-value="emit('update:modelValue',$event)" />
    <AppButton class="password-toggle" icon-only variant="secondary" size="s" :disabled="disabled" :aria-label="t(visible?'Скрыть пароль':'Показать пароль')" :aria-pressed="visible" @click.prevent="visible=!visible">
      <AppIcon :name="visible?'eye-off':'eye'" />
    </AppButton>
  </span>
</template>
<style scoped>
.password-input{display:block;position:relative;min-width:0;width:100%}
.password-input :deep(.app-input){display:block;padding-inline-end:var(--space-10)}
.password-input-s :deep(.app-input){padding-inline-end:var(--space-8)}
.password-toggle{position:absolute;inset-inline-end:var(--space-2);top:50%;transform:translateY(-50%);background:transparent}
.password-input-s .password-toggle{inset-inline-end:var(--space-1)}
</style>
