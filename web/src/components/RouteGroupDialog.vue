<script setup>
import {normalizeDnsPolicy} from '../../../shared/adguard-policy.js';
import {normalizeRouteEntries} from '../lib/form-validation.js';
import {useFormFeedback} from '../composables/useFormFeedback.js';
import { ZAPRET_PRESETS } from '../../../shared/zapret.js';
import { computed, ref, watch } from 'vue';
import { usePreferences } from '../preferences.js';
import AppButton from './AppButton.vue';
import AppDialog from './AppDialog.vue';
import AppInput from './AppInput.vue';
import AppSelect from './AppSelect.vue';
import AppTextarea from './AppTextarea.vue';
import RouteEntryInput from './RouteEntryInput.vue';
import AppInfoBlock from './AppInfoBlock.vue';
const {reportError,validate}=useFormFeedback();

const props = defineProps({
  open: Boolean,
  api: Function,
  disabled: Boolean,
  group: { type: Object, default: null },
  routes: { type: Array, default: () => [] },
});
const emit = defineEmits(['close', 'save']);
const { t } = usePreferences();

const dnsRules=ref('');
const name = ref('');
const entries = ref([]),presets=ref([]);
const routeId = ref('');
const zapretStrategy = ref('');
const usesZapret = computed(() => props.routes.find(route=>route.value===routeId.value)?.engine==='zapret');
const strategyOptions = computed(() => [{value:'',label:t('Наследовать общую')},...ZAPRET_PRESETS.map(preset=>({value:preset.id,label:t(preset.label)}))]);

watch(
  () => props.open,
  open => {
    if (!open) return;
    name.value = props.group?.name || '';
    dnsRules.value=(props.group?.dnsRules || []).join('\n');
    entries.value = [...(props.group?.manualEntries || props.group?.entries || [])];
    presets.value=(props.group?.presets || []).map(preset=>({...preset}));
    routeId.value = props.group?.routeId || props.routes[0]?.value || '';
    zapretStrategy.value = props.group?.zapretStrategy || '';
  },
);

const title = computed(() => (props.group ? t('Редактировать группу') : t('Новая группа')));


function submit() {
  if(props.disabled)return;
  if(!validate([
    [!!name.value.trim(),'Укажите название группы.'],
    [!!entries.value.length || !!presets.value.length || (routeId.value==='block' && !!dnsRules.value.trim()),'Укажите адреса или DNS-фильтр для блокировки.'],
    [props.routes.some(route=>route.value===routeId.value),'Выберите маршрут.']
  ]))return;
  let policy;try{policy=normalizeDnsPolicy({routeId:routeId.value,dnsRules:dnsRules.value});if(entries.value.length){const normalized=normalizeRouteEntries(entries.value);if(normalized.some(entry=>entry.startsWith('exclude:'))){if(dnsRules.value.trim())throw Error('Domain exclusions cannot be combined with custom DNS rules or filters.');if(!presets.value.length && normalized.every(entry=>entry.startsWith('exclude:')))throw Error('Add an included address or a domain preset before exclusions.');}}}catch(error){reportError(error);return;}
  emit('save', { ...policy, name: name.value.trim(), entries: entries.value,presetIds:presets.value.map(preset=>preset.id), routeId: routeId.value, zapretStrategy: usesZapret.value ? zapretStrategy.value || null : null });
}

</script>

<template>
  <AppDialog :form-state="[name,entries,presets.map(preset=>preset.id),dnsRules,routeId,zapretStrategy]" :open="open" :title="title" @close="emit('close')">
    <div class="dialog-body">
      <div class="form-section">
        <label>
          {{ t('Название группы') }}
          <AppInput v-model="name" maxlength="100" :disabled="disabled" />
        </label>
        <div class="route-entries-field">
          <span>{{ t('Домены и IP-адреса') }}</span>
          <RouteEntryInput v-model="entries" v-model:presets="presets" :disabled="disabled" :api="api" :active="open" />
        </div>
        <AppInfoBlock v-if="presets.some(preset=>preset.available===false)" variant="warning">{{t('Some presets are unavailable. Their last saved rules remain active.')}}</AppInfoBlock>
        <label>
          {{ t('Маршрут') }}
          <AppSelect v-model="routeId" :label="t('Маршрут')" :options="routes" :disabled="disabled" />
        </label>
        <label v-if="routeId==='block' && dnsRules"><span>{{t('Пользовательские DNS-правила')}}</span><AppTextarea v-model="dnsRules" :rows="4" :disabled="disabled" /></label>
        <label v-if="usesZapret">
          {{ t('Стратегия zapret') }}
          <AppSelect v-model="zapretStrategy" :label="t('Стратегия zapret')" :options="strategyOptions" :disabled="disabled" />
        </label>
      </div>
    </div>
    <template #footer>
      <AppButton variant="secondary" :disabled="disabled" @click="emit('close')">{{ t('Отмена') }}</AppButton>
      <AppButton data-testid="dialog-save-group" :disabled="disabled" @click="submit">{{ t('Сохранить') }}</AppButton>
    </template>
  </AppDialog>
</template>

<style scoped>
.route-entries-field{display:grid;gap:var(--space-2)}
.route-entries-field>span{font-size:var(--font-size-label-m);color:var(--color-text-label)}
</style>
