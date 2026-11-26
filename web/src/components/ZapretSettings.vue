<script setup>
import {createApiClient} from '../lib/api.js';
import {useFormFeedback} from '../composables/useFormFeedback.js';
import { computed, ref, watch } from 'vue';
import {ZAPRET_UDP_DEFAULTS} from '../../../shared/zapret.js';
import { usePreferences } from '../preferences.js';
import AppButton from './AppButton.vue';
import AppDialog from './AppDialog.vue';
import AppSelect from './AppSelect.vue';
import AppInput from './AppInput.vue';
import AppSwitch from './AppSwitch.vue';
import AppAccordion from './AppAccordion.vue';
import AppIcon from './AppIcon.vue';
import { notify } from '../lib/toasts.js';
const {reportError}=useFormFeedback();

const props = defineProps({ open: Boolean, disabled: Boolean, csrf: String, profile:Object });
const emit = defineEmits(['close','saved']);
const { t } = usePreferences();
const api=createApiClient({getSession:()=>({csrf:props.csrf})});
const loaded=ref(false),profileName=ref(''),profileEnabled=ref(true);
let originalProfile=null;

const settings = ref({
  mode: 'auto', strategy: '', customStrategy: '', http: true, https: true, quic: true, tcpPorts: '80,443',
  ...ZAPRET_UDP_DEFAULTS, udpPorts: '443', windowSize: 0, ttl: 0, hostlist: false, hostlistUrl: '', autoUpdate: false, autoUpdateInterval: 'daily',
});
const busy = ref(false);
const running = ref(false);
const advanced = ref(false);
const target = ref('youtube.com');
const results = ref([]);

const testTargets = ['youtube.com', 'rutracker.org', 'discord.com', 'telegram.org', 'wikipedia.org', 'instagram.com'];

const strategies = computed(() => [
  { value: '', label: t('Стандартная') },
  { value: 'md5sum', label: t('Подмена контрольной суммы') },
  { value: 'autottl', label: t('Автоподбор TTL') },
  { value: 'ipid', label: t('Подмена IP ID') },
  { value: 'nfqws2', label: t('Перехват пакетов, версия 2') },
  { value: 'tpws2', label: t('Прозрачный прокси, версия 2') },
  { value: 'youtube', label: t('YouTube (TLS + QUIC)') },
  { value: 'custom', label: t('Своя стратегия') },
]);

const modeOptions = computed(() => [
  { value: 'auto', label: t('Автоподбор (рекомендуется)') },
  { value: 'tpws', label: t('Прозрачный прокси') },
  { value: 'nfqws', label: t('Перехват пакетов') },
]);

const udpStrategyOptions = computed(() => [
  {value:'fake',label:t('Поддельные UDP-пакеты')},
  {value:'fake-quic',label:t('Поддельные QUIC-пакеты')},
]);

const intervalOptions = computed(() => [
  { value: 'never', label: t('Никогда') },
  { value: 'hourly', label: t('Каждый час') },
  { value: 'daily', label: t('Каждый день') },
  { value: 'weekly', label: t('Каждую неделю') },
]);

function strategyLabel(id) {
  return strategies.value.find(option => option.value === id)?.label || id;
}

async function load() {
  busy.value=true;
  loaded.value=false;
  try {
    const profile=props.profile?await api('profiles').then(items=>items.find(item=>item.id===props.profile.id)):null;
    originalProfile=profile;
    profileName.value=profile?.name || '';profileEnabled.value=profile?.enabled!==false;
    const data=await api('zapret');
    settings.value={...ZAPRET_UDP_DEFAULTS,...data};
    loaded.value=true;
  }catch(error){reportError(error);}
  finally{busy.value=false;}
}

async function detect() {
  if(busy.value || running.value || !loaded.value)return;
  running.value=true;
  results.value=[];
  try {
    const data=await api('zapret/autotune',{
      method:'POST',body:JSON.stringify({...settings.value,target:target.value})
    });
    results.value=data.results || data.plan?.results || [];
    settings.value=data.settings;
    notify(`${t('Стратегия определена')}: ${strategyLabel(settings.value.strategy)}`,'success');
  }catch(error){
    const list=error.data?.results || error.data?.plan?.results || [];
    results.value=list.some(result=>result.state!=='unavailable')?list:[];
    reportError(error);
  }finally{running.value=false;}
}

async function save() {
  if(busy.value || running.value || !loaded.value || (props.profile && !profileName.value.trim()))return;
  busy.value=true;
  try {
    const data=await api('zapret',{method:'PUT',body:JSON.stringify(settings.value)});
    settings.value=data;
    if(props.profile && (profileName.value.trim()!==originalProfile?.name || profileEnabled.value!==originalProfile?.enabled)){await api('profiles/'+props.profile.id,{method:'PUT',body:JSON.stringify({name:profileName.value.trim(),enabled:profileEnabled.value})});emit('saved',await api('profiles'));}
    if(data.warning)reportError(data.warning);
    emit('close');
  }catch(error){reportError(error);}
  finally{busy.value=false;}
}

watch(() => props.open, open => {
  if (!open) return;
  advanced.value = false;
  results.value = [];
  load();
});
</script>

<template>
  <AppDialog :form-state="loaded?[settings,profileName,profileEnabled]:undefined" :open="open" :title="t('Настроить')" @close="!busy && !running && emit('close')">
    <div class="dialog-body">
      <div class="form-section">
        <template v-if="profile">
          <label>{{t('Название')}}<AppInput v-model="profileName" maxlength="100" :disabled="busy || running || !loaded" /></label>
          <AppSwitch v-model="profileEnabled" :label="t('Включено')" :disabled="busy || running || !loaded" />
        </template>
        <label>
          {{ t('Режим работы') }}
          <AppSelect v-model="settings.mode" :label="t('Режим работы')" :options="modeOptions" :disabled="busy || running" />
        </label>

        <label>
          {{ t('Способ обхода') }}
          <AppSelect v-model="settings.strategy" :label="t('Способ обхода')" :options="strategies" :disabled="busy || running" />
        </label>

        <label v-if="settings.strategy==='custom'">
          {{ t('Своя стратегия (lua-desync)') }}
          <AppInput v-model="settings.customStrategy" maxlength="2048" :disabled="busy || running" placeholder="fake:blob=fake_default_tls:tcp_md5" />
        </label>

        <label>
          {{ t('Домен для проверки') }}
          <input v-model="target" class="app-input" list="zapret-targets" placeholder="youtube.com" :disabled="busy || running" />
          <datalist id="zapret-targets">
            <option v-for="domain in testTargets" :key="domain" :value="domain" />
          </datalist>
        </label>

        <AppButton variant="secondary" data-testid="zapret-detect" :disabled="busy || running || !loaded || !target.trim()" @click="detect">
          <AppIcon name="auto" />
          {{ running ? t('Проверяем…') : t('Определить автоматически') }}
        </AppButton>

        <p v-if="settings.udp" class="muted">{{ t('Автоподбор проверяет HTTP(S). Работу UDP проверяйте в нужном приложении.') }}</p>

        <ul v-if="results.length" class="autotune-results" role="status">
          <li v-for="result in results" :key="result.strategy" :class="'is-' + result.state">
            <span>{{ strategyLabel(result.strategy) }}</span>
            <small>
              {{ result.state === 'ok' ? `${t('работает')} · ${result.ms} ${t('мс')}` : result.state === 'unavailable' ? t('недоступно') : (result.error || t('не работает')) }}
            </small>
          </li>
        </ul>
      </div>

      <AppAccordion v-model:open="advanced" :title="t('Дополнительные настройки')">
        <div class="form-sections">
        <section class="form-section">
          <h3>{{ t('Протоколы и порты') }}</h3>
          <div class="dns-switches">
            <AppSwitch :model-value="settings.http" :label="t('HTTP (80)')" :disabled="busy" @update:model-value="settings.http = $event" />
            <AppSwitch :model-value="settings.https" :label="t('HTTPS (443)')" :disabled="busy" @update:model-value="settings.https = $event" />
            <AppSwitch :model-value="settings.quic" :label="t('QUIC (443 UDP)')" :disabled="busy" @update:model-value="settings.quic = $event" />
          </div>
          <div class="form-row">
            <label>
              {{ t('TCP-порты') }}
              <AppInput v-model="settings.tcpPorts" maxlength="512" :disabled="busy" :placeholder="t('80,443')" />
            </label>
            <label>
              {{ t('Порты QUIC') }}
              <AppInput v-model="settings.udpPorts" maxlength="512" :disabled="busy" :placeholder="t('443')" />
            </label>
          </div>
        </section>

        <section class="form-section">
          <h3>{{ t('UDP-трафик') }}</h3>
          <AppSwitch v-model="settings.udp" :label="t('Обрабатывать UDP кроме QUIC')" data-testid="zapret-udp" :disabled="busy || running" />
          <p class="muted">{{ t('UDP обрабатывается только для маршрутов через zapret. Для трафика без имени домена используйте правила по IP или устройству.') }}</p>
          <template v-if="settings.udp">
            <label>
              {{ t('UDP-порты') }}
              <AppInput v-model="settings.udpServicePorts" data-testid="zapret-udp-ports" maxlength="512" :disabled="busy || running" :placeholder="ZAPRET_UDP_DEFAULTS.udpServicePorts" />
            </label>
            <div class="form-row">
              <label>
                {{ t('Способ обхода UDP') }}
                <AppSelect v-model="settings.udpStrategy" :label="t('Способ обхода UDP')" :options="udpStrategyOptions" data-testid="zapret-udp-strategy" :disabled="busy || running" />
              </label>
              <label>
                {{ t('Количество повторов UDP') }}
                <AppInput v-model="settings.udpRepeats" type="number" min="1" max="20" :disabled="busy || running" data-testid="zapret-udp-repeats" />
              </label>
            </div>
            <p class="muted">{{ t('Стратегия применяется к первым трём исходящим пакетам соединения. QUIC настраивается отдельно.') }}</p>
          </template>
        </section>

        <section class="form-section">
          <h3>{{ t('Параметры пакетов') }}</h3>
          <div class="form-row">
            <label>
              {{ t('Размер окна TCP') }}
              <AppInput v-model="settings.windowSize" type="number" min="0" max="65535" :disabled="busy" />
            </label>
            <label>
              {{ t('TTL') }}
              <AppInput v-model="settings.ttl" type="number" min="0" max="255" :disabled="busy" />
            </label>
          </div>
        </section>

        <section class="form-section">
          <h3>{{ t('Hostlist') }}</h3>
          <div class="dns-switches">
            <AppSwitch :model-value="settings.hostlist" :label="t('Использовать hostlist')" :disabled="busy" @update:model-value="settings.hostlist = $event" />
          </div>

          <template v-if="settings.hostlist">
            <label>
              {{ t('URL hostlist-а') }}
              <AppInput v-model="settings.hostlistUrl" maxlength="2048" :disabled="busy" :placeholder="t('https://...')" />
            </label>

            <div class="dns-switches">
              <AppSwitch :model-value="settings.autoUpdate" :label="t('Автообновление hostlist-а')" :disabled="busy" @update:model-value="settings.autoUpdate = $event" />
            </div>

            <label v-if="settings.autoUpdate">
              {{ t('Интервал') }}
              <AppSelect v-model="settings.autoUpdateInterval" :label="t('Интервал')" :options="intervalOptions" :disabled="busy" />
            </label>
          </template>
        </section>
        </div>
      </AppAccordion>
    </div>
    <template #footer>
      <AppButton variant="secondary" :disabled="busy || running" @click="emit('close')">{{ t('Отмена') }}</AppButton>
      <AppButton :disabled="busy || running || !loaded || (profile && !profileName.trim())" @click="save">{{ t('Сохранить') }}</AppButton>
    </template>
  </AppDialog>
</template>
