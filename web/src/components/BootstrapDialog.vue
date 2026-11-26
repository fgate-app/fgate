<script setup>
import {ipVersion} from '../lib/form-validation.js';
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
  catalog: { type: Array, default: () => [] },
  existing: { type: Array, default: () => [] },
  disabled: Boolean,
});
const emit = defineEmits(['close', 'add']);
const { t } = usePreferences();

const selected = ref(null);
const custom = ref('');
const ip = ref('');

const ipOptions = computed(() => (selected.value ? selected.value.ips.map(address => ({ value: address, label: address })) : []));
const chosen = computed(() => (selected.value ? ip.value : custom.value.trim()));
const duplicate = computed(() => Boolean(chosen.value) && props.existing.includes(chosen.value));
const canAdd = computed(() => !props.disabled && !!chosen.value && !duplicate.value && !!ipVersion(chosen.value));

watch(
  () => props.open,
  open => {
    if (!open) return;
    selected.value = null;
    custom.value = '';
    ip.value = '';
  },
);

function select(item) {
  if (!item) return;
  selected.value = item;
  custom.value = '';
  ip.value = item.ips[0];
  }

function customInput(value) {
  selected.value = null;
  ip.value = '';
  custom.value = value;
  }

function clearSelection() {
  selected.value = null;
  ip.value = '';
  custom.value = '';
  }

function submit() {
  if(props.disabled)return;
  if (!canAdd.value) {
    reportError(duplicate.value ? t('Этот адрес уже добавлен.') : t('Укажите корректный IP-адрес.'));
    return;
  }
  emit('add', chosen.value);
  emit('close');
}
</script>

<template>
  <AppDialog :form-state="[selected,custom,ip]" :open="open" :title="t('Bootstrap-резолвер')" @close="emit('close')">
    <div class="dialog-body">
      <div class="form-section">
        <ResolverPicker
          variant="bootstrap"
          :items="catalog"
          :selected="selected"
          :disabled="disabled"
          :show-add-button="false"
          :placeholder="t('Поиск по провайдеру или адресу')"
          @select="select"
          @custom="customInput"
          @clear="clearSelection"
        />
        <label v-if="selected">
          {{ t('Адрес') }}
          <AppSelect :model-value="ip" :label="t('Адрес')" :options="ipOptions" :disabled="disabled" @update:model-value="ip = $event" />
        </label>
        <label v-else>
          {{ t('Или свой IP-адрес') }}
          <AppInput :model-value="custom" placeholder="1.1.1.1" maxlength="45" :disabled="disabled" @update:model-value="customInput" />
        </label>
        <p v-if="chosen" class="muted dialog-url">{{ chosen }}</p>
      </div>
    </div>
    <template #footer>
      <AppButton variant="secondary" @click="emit('close')">{{ t('Отмена') }}</AppButton>
      <AppButton :disabled="disabled || !chosen" data-testid="dialog-add-bootstrap" @click="submit">{{ t('Добавить') }}</AppButton>
    </template>
  </AppDialog>
</template>
