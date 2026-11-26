<script setup>
import {validResolver} from '../lib/form-validation.js';
import {useFormFeedback} from '../composables/useFormFeedback.js';
import { computed, ref, watch } from 'vue';
import { usePreferences } from '../preferences.js';
import AppButton from './AppButton.vue';
import AppDialog from './AppDialog.vue';
import AppInput from './AppInput.vue';
import AppSelect from './AppSelect.vue';
import ResolverPicker from './ResolverPicker.vue';
const {reportError}=useFormFeedback();

const props = defineProps({
  open: Boolean,
  title: String,
  resolvers: { type: Array, default: () => [] },
  existing: { type: Array, default: () => [] },
  disabled: Boolean,
});
const emit = defineEmits(['close', 'add']);
const { t } = usePreferences();

const selected = ref(null);
const custom = ref('');
const protocol = ref('');
const via = ref('');

const protocolOptions = computed(() => {
  if (!selected.value) return [];
  return Object.keys(selected.value.protocols || {}).map(key => ({
    value: key,
    label: { doh: 'DoH', dot: 'DoT', doq: 'DoQ', udp: 'UDP' }[key] || key.toUpperCase(),
  }));
});
const viaOptions = computed(() => [
  { value: '', label: t('По умолчанию') },
  { value: 'DIRECT', label: t('Напрямую') },
  { value: 'RULES', label: t('По правилам') },
]);
const url = computed(() => (selected.value ? selected.value.protocols[protocol.value] || '' : custom.value.trim()));
const duplicate = computed(() => Boolean(url.value) && props.existing.includes(url.value));
const canAdd = computed(() => !props.disabled && !!url.value && !duplicate.value && validResolver(url.value));

watch(
  () => props.open,
  open => {
    if (!open) return;
    selected.value = null;
    custom.value = '';
    protocol.value = '';
    via.value = '';
  },
);

function select(resolver) {
  selected.value = resolver;
  custom.value = '';
  protocol.value = resolver.protocols.doh ? 'doh' : Object.keys(resolver.protocols)[0];
  }

function customInput(value) {
  selected.value = null;
  protocol.value = '';
  custom.value = value;
  }

function clearSelection() {
  selected.value = null;
  protocol.value = '';
  custom.value = '';
  }

function submit() {
  if(props.disabled)return;
  if (!canAdd.value) {
    reportError(duplicate.value ? t('Этот резолвер уже добавлен в список.') : t("Enter a valid resolver address."));
    return;
  }
  emit('add', { url: url.value, via: via.value });
  emit('close');
}
</script>

<template>
  <AppDialog :form-state="[selected,custom,protocol,via]" :open="open" :title="title" @close="emit('close')">
    <div class="dialog-body">
      <div class="form-section">
        <ResolverPicker
          :resolvers="resolvers"
          :selected="selected"
          :disabled="disabled"
          :show-add-button="false"
          @select="select"
          @custom="customInput"
          @clear="clearSelection"
        />
        <label v-if="selected">
          {{ t('Протокол') }}
          <AppSelect :model-value="protocol" :label="t('Протокол')" :options="protocolOptions" :disabled="disabled" @update:model-value="protocol = $event" />
        </label>
        <label v-else>
          {{ t('Или свой адрес') }}
          <AppInput :model-value="custom" placeholder="https://dns.example/dns-query" maxlength="512" :disabled="disabled" @update:model-value="customInput" />
        </label>
        <label>
          {{ t('Прокси для запросов') }}
          <AppSelect :model-value="via" :label="t('Прокси для запросов')" :options="viaOptions" :disabled="disabled" @update:model-value="via = $event" />
        </label>
        <p v-if="url" class="muted dialog-url">{{ url }}</p>
      </div>
    </div>
    <template #footer>
      <AppButton variant="secondary" @click="emit('close')">{{ t('Отмена') }}</AppButton>
      <AppButton :disabled="disabled || !url" data-testid="dialog-add-resolver" @click="submit">{{ t('Добавить') }}</AppButton>
    </template>
  </AppDialog>
</template>
