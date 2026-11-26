import { reactive } from 'vue';

export const toasts = reactive([]);
let nextId = 1;

export function notify(message, type = 'info', timeout = 4500) {
  if (!message) return null;
  const id = nextId++;
  toasts.push({ id, message, type });
  if (timeout > 0) setTimeout(() => dismiss(id), timeout);
  return id;
}

export function dismiss(id) {
  const index = toasts.findIndex(toast => toast.id === id);
  if (index >= 0) toasts.splice(index, 1);
}

export function clearToasts() {
  toasts.splice(0, toasts.length);
}

export function updateToast(id,patch){const toast=toasts.find(item=>item.id===id);if(!toast)return false;Object.assign(toast,patch);return true;}
