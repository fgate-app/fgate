import {ref} from 'vue';
import {usePolling} from './usePolling.js';

export function useConnectionTelemetry(api, activeUserId) {
  const telemetry = ref(null);

  usePolling(activeUserId, {
    interval: 2000,
    request: signal => api('profiles/telemetry', {signal}),
    onReset: () => { telemetry.value = null; },
    onData: data => { telemetry.value = data; },
    onError: () => { telemetry.value = null; }
  });

  return telemetry;
}
