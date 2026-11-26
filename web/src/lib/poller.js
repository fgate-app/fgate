// One request at a time. A stopped generation cannot publish a late result.
export function createPoller({
  request,
  onData,
  onError = () => {},
  interval,
  schedule = setTimeout,
  cancel = clearTimeout
}) {
  let current = null;

  function stop() {
    if (!current) return;
    cancel(current.timer);
    current.controller.abort();
    current = null;
  }

  async function poll(state) {
    try {
      const data = await request(state.controller.signal);
      if (current === state) onData(data);
    } catch (error) {
      if (current === state && error.name !== 'AbortError') onError(error);
    } finally {
      if (current === state) state.timer = schedule(() => poll(state), interval);
    }
  }

  function start() {
    stop();
    const state = {controller: new AbortController(), timer: undefined};
    current = state;
    void poll(state);
  }

  return {start, stop};
}
