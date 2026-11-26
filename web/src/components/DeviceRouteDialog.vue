<script setup>
import {validDeviceIdentifier} from '../lib/form-validation.js';
import {useFormFeedback} from '../composables/useFormFeedback.js';
import { computed, ref, watch } from 'vue';
import { usePreferences } from '../preferences.js';
import AppButton from './AppButton.vue';
import AppDialog from './AppDialog.vue';
import AppInput from './AppInput.vue';
import AppSelect from './AppSelect.vue';
const {validate,reportError}=useFormFeedback();

const props = defineProps({
  open: Boolean,
  api: Function,
  disabled: Boolean,
  device: { type: Object, default: null },
  routes: { type: Array, default: () => [] },
});
const emit = defineEmits(['close', 'save']);
const { t } = usePreferences();

const name = ref('');
const identifier = ref('');
const routeId = ref('');
const clients = ref([]);
const clientOptions = computed(()=>clients.value.filter(client=>client.ip).map(client=>({value:client.staticIp || client.ip,label:[client.hostname,client.staticIp || client.ip,client.mac].filter(Boolean).join(' · '),client})));
function selectClient(option){if(!name.value.trim())name.value=option.client.hostname || option.client.ip;}


watch(
  () => props.open,
  async (open,previous,onCleanup) => {
    let active=true;onCleanup(()=>{active=false;});
    if (!open) return;
    name.value = props.device?.name || '';
    identifier.value = props.device?.identifier || '';
    routeId.value = props.device?.routeId || props.routes[0]?.value || '';
    clients.value=[];
    try{const data=await props.api?.('clients');if(active)clients.value=data?.clients || [];}catch(error){if(active)reportError(error);}
  },
);

const title = computed(() => (props.device ? t('Редактировать устройство') : t('Новое устройство')));

function submit() {
  if(props.disabled)return;
  if(!validate([
    [!!name.value.trim(),'Укажите название устройства.'],
    [validDeviceIdentifier(identifier.value.trim()),"Enter the device IP or MAC address."],
    [props.routes.some(route=>route.value===routeId.value),'Выберите маршрут.']
  ]))return;
  emit('save', { name: name.value.trim(), identifier: identifier.value.trim(), routeId: routeId.value });
}

</script>

<template>
  <AppDialog :form-state="[name,identifier,routeId]" :open="open" :title="title" @close="emit('close')">
    <div class="dialog-body">
      <div class="form-section">
        <label>
          {{ t('Название устройства') }}
          <AppInput v-model="name" maxlength="100" :disabled="disabled" />
        </label>
        <label>
          {{ t('IP или MAC-адрес') }}
          <AppSelect v-model="identifier" editable :options="clientOptions" :label="t('IP или MAC-адрес')" maxlength="64" :disabled="disabled" placeholder="192.168.1.50" @select="selectClient" />
        </label>
        <label>
          {{ t('Маршрут') }}
          <AppSelect v-model="routeId" :label="t('Маршрут')" :options="routes" :disabled="disabled" />
        </label>
        <p class="muted">{{ t('При создании правила устройству будет назначен статический адрес.') }}</p>
      </div>
    </div>
    <template #footer>
      <AppButton variant="secondary" :disabled="disabled" @click="emit('close')">{{ t('Отмена') }}</AppButton>
      <AppButton data-testid="dialog-save-device" :disabled="disabled" @click="submit">{{ t('Сохранить') }}</AppButton>
    </template>
  </AppDialog>
</template>
