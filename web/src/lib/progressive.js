import { computed, ref, watch } from 'vue';

// Long option lists are rendered in chunks and extended when the user scrolls.
export function useProgressiveList(source, { step = 40 } = {}) {
  const limit = ref(step);
  watch(source, () => {
    limit.value = step;
  });
  const visible = computed(() => source.value.slice(0, limit.value));
  const hasMore = computed(() => source.value.length > limit.value);
  function ensure(index) {
    if (index >= limit.value) limit.value = index + 1;
  }
  function onScroll(event) {
    const element = event.currentTarget;
    if (!element || !hasMore.value) return;
    if (element.scrollTop + element.clientHeight >= element.scrollHeight - 24) limit.value += step;
  }
  return { visible, hasMore, limit, ensure, onScroll };
}

// Available space for a popup: from the anchor to the viewport edge, flipped
// above the anchor when there is more room there. Content height wins when the
// list is short.
export function popupHeight(anchor, contentHeight, { gap = 12, minimum = 80 } = {}) {
  const rect = anchor.getBoundingClientRect();
  const below = innerHeight - rect.bottom - gap;
  const above = rect.top - gap;
  const flip = below < Math.min(contentHeight, 240) && above > below;
  const available = flip ? above : below;
  return { maxHeight: Math.max(minimum, Math.min(contentHeight, available)), flip, below, above };
}
