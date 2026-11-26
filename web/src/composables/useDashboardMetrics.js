import {useFormFeedback} from './useFormFeedback.js';
import {ref} from 'vue';
import {usePolling} from './usePolling.js';
import {loadMetricHistory, saveMetricHistory, mergeMetricSamples} from '../lib/metric-history.js';

export function useDashboardMetrics(api, userId) {
  const {reportError}=useFormFeedback();
  const metrics = ref(null), samples = ref([]), error = ref('');

  function append(data = {}) {
    const time = Date.now();
    const sample = {
      time,
      cpu: data.cpu?.percent ?? null,
      memory: data.memory?.percent ?? null,
      upload: data.traffic?.uploadRate ?? null,
      download: data.traffic?.downloadRate ?? null
    };
    samples.value = mergeMetricSamples([samples.value, [sample]], time);
    saveMetricHistory(userId(), samples.value);
  }

  usePolling(userId, {
    interval: 5000,
    request: signal => api('dashboard', {signal}),
    onReset: id => {
      metrics.value = null;
      error.value = '';
      samples.value = loadMetricHistory(id);
    },
    onData: data => {
      metrics.value = data;
      error.value = '';
      append(data);
    },
    onError: failure => {
      if(!error.value)reportError('Metrics could not be refreshed. Previous readings may be stale.');
      error.value = failure.message;
      append();
    }
  });

  return {metrics, samples, error};
}
