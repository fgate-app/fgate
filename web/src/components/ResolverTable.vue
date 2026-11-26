<script setup>
import AppTable from './AppTable.vue';
import { computed } from 'vue';
import { usePreferences } from '../preferences.js';
import AppRowMenu from './AppRowMenu.vue';
import AppSelect from './AppSelect.vue';
import ResolverStatus from './ResolverStatus.vue';

const props = defineProps({
  entries: { type: Array, default: () => [] },
  statuses: { type: Object, default: () => ({}) },
  resolvers: { type: Array, default: () => [] },
  disabled: Boolean,
  loading: Boolean,
  routes: { type: Array, default: () => [] },
  label: String,
});
const emit = defineEmits(['remove', 'via']);
const { t } = usePreferences();

const actions = computed(() => [{ value: 'remove', label: t('Удалить'), danger: true }]);

const viaOptions = computed(() => [
  { value: '', label: t('По умолчанию') },
  { value: 'DIRECT', label: t('Напрямую') },
  { value: 'RULES', label: t('По правилам') },
  ...props.routes,
]);

function name(url) {
  const known = props.resolvers.find(resolver => Object.values(resolver.protocols || {}).includes(url));
  if (known) return known.name;
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function protocol(url) {
  const scheme = String(url).split(':')[0];
  return { https: 'DoH', tls: 'DoT', quic: 'DoQ', udp: 'UDP', tcp: 'TCP' }[scheme] || scheme.toUpperCase();
}
</script>

<template>
  <div class="table-wrap">
    <AppTable :loading="loading" class="data-table" :aria-label="label">
      <thead>
        <tr>
          <th>{{ t('Резолвер') }}</th>
          <th>{{ t('Адрес') }}</th>
          <th>{{ t('Протокол') }}</th>
          <th>{{ t('Прокси') }}</th>
          <th>{{ t('Статус') }}</th>
          <th class="actions-col" :aria-label="t('Действия')"></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(entry, index) in entries" :key="entry.url">
          <td><strong>{{ name(entry.url) }}</strong></td>
          <td><code class="resolver-url">{{ entry.url }}</code></td>
          <td>{{ protocol(entry.url) }}</td>
          <td>
            <AppSelect
              size="s"
              :label="t('Прокси для запросов') + ' ' + entry.url"
              :model-value="entry.via"
              :options="viaOptions"
              :disabled="disabled"
              @update:model-value="emit('via', { index, via: $event })"
            />
          </td>
          <td><ResolverStatus :status="statuses[entry.url]" /></td>
          <td class="actions-cell">
            <AppRowMenu :actions="actions" :label="t('Действия')" :disabled="disabled" @select="emit('remove', index)" />
          </td>
        </tr>
        <tr v-if="!entries.length">
          <td colspan="6" class="table-empty">{{ t('Пока нет резолверов') }}</td>
        </tr>
      </tbody>
    </AppTable>
  </div>
</template>
