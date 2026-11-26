import {ref, watch, onMounted, onUnmounted} from 'vue';

export function useMobileNavigation(page) {
  const open = ref(false);
  const desktop = window.matchMedia('(min-width:901px)');
  const closeOnDesktop = () => {
    if (desktop.matches) open.value = false;
  };

  watch(page, () => { open.value = false; });
  onMounted(() => desktop.addEventListener('change', closeOnDesktop));
  onUnmounted(() => desktop.removeEventListener('change', closeOnDesktop));

  return open;
}
