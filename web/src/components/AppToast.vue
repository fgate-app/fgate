<script setup>
import { nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { toasts, dismiss } from '../lib/toasts.js';
import { usePreferences } from '../preferences.js';
import AppIcon from './AppIcon.vue';

const { t } = usePreferences();
const now=ref(Date.now());let countdownTimer;
watch(()=>toasts.filter(toast=>toast.deadline).map(toast=>toast.id+':'+toast.deadline).join(','),active=>{clearInterval(countdownTimer);now.value=Date.now();if(active)countdownTimer=setInterval(()=>{now.value=Date.now();},250);},{immediate:true});
onUnmounted(()=>clearInterval(countdownTimer));
const stack = ref();
const target = ref('body');

async function sync(visible) {
  // Body-teleported popovers can end up behind a native modal dialog.
  // Move the stack into the open dialog so it stays in the same top layer.
  const dialog = visible ? [...document.querySelectorAll('dialog[open]')].at(-1) : null;
  target.value = dialog?.querySelector('[data-popup-host]') || dialog || 'body';
  await nextTick();
  const element = stack.value;
  if (!element) return;
  if (visible && typeof element.showPopover === 'function' && !element.matches(':popover-open')) {
    try {
      element.showPopover();
    } catch {
      /* already open */
    }
  }
  if (!visible && element.matches(':popover-open')) element.hidePopover();
}

watch(() => toasts.length, length => sync(length > 0), { immediate: true });
function dialogsChanged(){sync(toasts.length>0);}
onMounted(() => {window.addEventListener('freedomgate:dialogs-changed',dialogsChanged);sync(toasts.length > 0);});
onUnmounted(()=>window.removeEventListener('freedomgate:dialogs-changed',dialogsChanged));
</script>

<template>
  <Teleport :to="target">
    <div ref="stack" popover="manual" class="toast-stack" aria-live="polite" aria-atomic="false">
      <div v-for="toast in toasts" :key="toast.id" class="toast" :class="'is-' + toast.type" :role="toast.type==='error'?'alert':'status'">
        <AppIcon :name="toast.type === 'error' ? 'warning' : toast.type === 'success' ? 'selected' : 'dns'" />
        <span class="toast-text">{{ toast.message }}<template v-if="toast.deadline">{{' '+Math.max(0,Math.ceil((toast.deadline-now)/1000))+' '+t('с')}}</template></span>
        <button type="button" class="toast-close" :aria-label="t('Закрыть')" @click="dismiss(toast.id)">×</button>
      </div>
    </div>
  </Teleport>
</template>
