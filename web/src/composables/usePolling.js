import {watch, onUnmounted} from 'vue';
import {createPoller} from '../lib/poller.js';

// The key controls both activation and identity: changing users restarts the poll.
export function usePolling(key, options) {
  const {onReset = () => {}, ...pollOptions} = options;
  const poller = createPoller(pollOptions);

  watch(key, value => {
    poller.stop();
    onReset(value);
    if (value) poller.start();
  }, {immediate: true});

  onUnmounted(poller.stop);
  return {refresh:()=>{if(key())poller.start();}};
}
