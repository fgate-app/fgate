<script setup>
import {computed, onMounted} from 'vue';
import AppButton from '../components/AppButton.vue';
import NetworkSettingsFields from '../components/NetworkSettingsFields.vue';
import {useNetworkSettings} from '../composables/useNetworkSettings.js';
import {usePreferences} from '../preferences.js';

const props = defineProps(['api', 'run', 'can', 'busy']);
const emit = defineEmits(['notice']);
const {t} = usePreferences();
const {network, warnings, interfaces, pending, load, apply} = useNetworkSettings({
  api: (...args) => props.api(...args),
  canWrite: () => props.can('settings:write'),
  onApplied: action => emit('notice', action === 'apply' ? 'Схема применена.' : '')
});
const disabled = computed(() => props.busy || pending.value || !props.can('settings:write'));
onMounted(() => props.run(load));
</script>
<template>
  <div id="settings-content" role="tabpanel" class="card-stack network-layout" :aria-labelledby="'settings-tabs-tab-'+encodeURIComponent('Сеть')">
    <section class="panel network-settings" :aria-busy="pending">
      <div v-if="!network" class="empty">{{t('Загрузка…')}}</div>
      <div v-else class="network-settings-body">
        <NetworkSettingsFields v-model="network" :interfaces="interfaces" :disabled="disabled" />
        <div v-if="warnings.length" class="alert">{{warnings.map(w=>t(w)).join(' ')}}</div>
        <div class="dns-actions">
          <AppButton :disabled="disabled" @click="props.run(apply)">{{t('Сохранить и применить')}}</AppButton>
        </div>
      </div>
    </section>
  </div>
</template>
<style scoped>
.network-settings-body{display:grid;gap:var(--space-6);min-width:0}
.network-settings-body>.dns-actions{display:flex;flex-wrap:wrap;gap:var(--space-4)}
.network-settings-body>.alert,.network-settings-body>.dns-actions{margin:0}
</style>
