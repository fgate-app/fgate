import {ref, onUnmounted} from 'vue';
import {networkResponse} from '../lib/network-settings.js';

export function useNetworkSettings({api, canWrite, onApplied}) {
  const network = ref(null), saved = ref(null), interfaces = ref([]), plan = ref([]), warnings = ref([]);
  const pending = ref(false);
  let controller;

  async function request(action = 'load') {
    if (pending.value || (action !== 'load' && !canWrite())) return;
    const active = new AbortController();
    controller = active;
    pending.value = true;
    try {
      const options = {signal: active.signal};
      if (action !== 'load') {
        options.method = 'POST';
        options.body = JSON.stringify(network.value);
      }
      const data = await api(action === 'apply' ? 'network/apply' : 'network', options);
      if (active.signal.aborted) return;
      const next = networkResponse(data, {setup: network.value, interfaces: interfaces.value, plan: plan.value});
      network.value = next.setup;
      saved.value = structuredClone(next.setup);
      interfaces.value = next.interfaces;
      plan.value = next.plan;
      warnings.value = next.warnings;
      if (action !== 'load') onApplied(action);
    } catch (error) {
      if (!active.signal.aborted) throw error;
    } finally {
      if (controller === active) pending.value = false;
    }
  }

  onUnmounted(() => controller?.abort());
  return {network, saved, interfaces, plan, warnings, pending, load: () => request(), apply: () => request('apply')};
}
