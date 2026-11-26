<script setup>
import { computed, nextTick, onMounted, onUnmounted, onBeforeUnmount, ref, watch } from 'vue';
import {cancelOverlay,enterOverlay,leaveOverlay} from '../lib/overlay-motion.js';
import { usePreferences } from '../preferences.js';
import { popupHeight, useProgressiveList } from '../lib/progressive.js';
import AppButton from './AppButton.vue';
import AppIcon from './AppIcon.vue';

const props = defineProps({
  resolvers: { type: Array, default: () => [] },
  items: { type: Array, default: () => [] },
  variant: { type: String, default: 'resolver', validator: value => ['resolver', 'bootstrap'].includes(value) },
  disabled: Boolean,
  label: String,
  placeholder: String,
  showAddButton: { type: Boolean, default: true },
  selected: { type: Object, default: null },
});
const emit = defineEmits(['select', 'custom', 'clear']);
const { t } = usePreferences();

const filteringLabels = {
  none: 'без фильтрации',
  malware: 'вредоносные',
  'malware+adult': 'вредоносные и взрослые',
  'ads+trackers': 'реклама и трекеры',
  'ads+trackers+adult': 'реклама, трекеры и взрослые',
  ads: 'реклама',
  family: 'семейный фильтр',
  sanctions: 'санкционные домены',
  'child-abuse': 'блокировка противоправного контента',
  'ads+malware+trackers': 'реклама, вредоносные и трекеры',
  'ads+phishing': 'реклама и фишинг',
  phishing: 'фишинг',
  'malware+phishing': 'вредоносные и фишинг',
};

const source = computed(() => (props.items.length ? props.items : props.resolvers));
const query = ref('');
const openList = ref(false);
const active = ref(0);
const listStyle = ref({});
const root = ref();
const listEl = ref();
const inputEl = ref();
let blurTimer;
function cancelBlur(){clearTimeout(blurTimer);blurTimer=undefined;}

function preferred(item) {
  return item.protocols?.doh || item.protocols?.dot || item.protocols?.quic || item.protocols?.udp || '';
}

function displayCode(item) {
  return props.variant === 'bootstrap' ? (item.ips || []).join(' · ') : preferred(item);
}

function searchable(item) {
  return [item.name, item.vendor, item.country, item.region, ...(item.aliases || []), ...Object.values(item.protocols || {}), ...(item.ips || [])]
    .join(' ')
    .toLocaleLowerCase();
}

const filtered = computed(() => {
  const text = query.value.trim().toLocaleLowerCase();
  return text ? source.value.filter(item => searchable(item).includes(text)) : source.value;
});

const { visible, ensure, onScroll } = useProgressiveList(filtered);
watch(active, index => ensure(index));

function placeList() {
  if (!openList.value || !root.value) return;
  const rect = root.value.getBoundingClientRect();
  const content = Math.min(filtered.value.length * 44 + 12, 640);
  const { maxHeight, flip } = popupHeight(root.value, content);
  const left = Math.max(8, Math.min(rect.left, innerWidth - rect.width - 8));
  const width = Math.min(rect.width, innerWidth - 16);
  listStyle.value = {
    position: 'fixed',
    left: `${left}px`,
    width: `${width}px`,
    maxHeight: `${maxHeight}px`,
    margin: '0',
    right: 'auto',
    ...(flip
      ? { top: 'auto', bottom: `${innerHeight - rect.top + 6}px` }
      : { top: `${rect.bottom + 6}px`, bottom: 'auto' }),
  };
}

function enterList(element,done){
 if(typeof element.showPopover==='function' && !element.matches(':popover-open'))element.showPopover();
 enterOverlay(element,done,{upward:listStyle.value.top==='auto'});
}
function leaveList(element,done){leaveOverlay(element,()=>{if(typeof element.hidePopover==='function' && element.matches(':popover-open'))element.hidePopover();done();});}
onBeforeUnmount(()=>{cancelBlur();cancelOverlay(listEl.value);});

// A popover lives in the top layer, so a modal cannot clip it.
async function showListPopover() {
  await nextTick();
  const element = listEl.value;
  if (!element || !openList.value || typeof element.showPopover !== 'function') return;
  if (element.matches(':popover-open')) return;
  try {
    element.showPopover();
  } catch {
    /* unsupported or already open */
  }
}
watch(openList, open => {
  if (open) showListPopover();
});
watch(() => props.selected, async value => {
  if (value) {
    openList.value = false;
    return;
  }
  await nextTick();
  inputEl.value?.focus();
});
watch(filtered, () => {
  if (openList.value) showListPopover();
});

function choose(item) {
  if (!item || props.disabled) return;
  emit('select', props.variant === 'bootstrap' ? item : { ...item, url: preferred(item) });
  query.value = '';
  openList.value = false;
}

function submit() {
  if (props.disabled) return;
  const text = query.value.trim();
  if (openList.value && filtered.value[active.value]) {
    choose(filtered.value[active.value]);
    return;
  }
  if (!text) return;
  emit('custom', text);
  query.value = '';
  openList.value = false;
}

function move(step) {
  if (!filtered.value.length) return;
  active.value = (active.value + step + filtered.value.length) % filtered.value.length;
}

function keydown(event) {
  if (event.isComposing) return;
  if (event.key === 'Enter') {
    event.preventDefault();
    submit();
    return;
  }
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    openList.value = true;
    move(1);
    placeList();
    return;
  }
  if (event.key === 'ArrowUp') {
    event.preventDefault();
    openList.value = true;
    move(-1);
    placeList();
    return;
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    openList.value = false;
  }
}

function input(event) {
  cancelBlur();
  query.value = event.target.value;
  openList.value = true;
  active.value = 0;
  placeList();
}

function focus() {
  cancelBlur();
  openList.value = true;
  placeList();
}

function blur() {
  cancelBlur();
  blurTimer=setTimeout(() => {
    openList.value = false;
  }, 150);
}

function onViewportChange() {
  if (openList.value) placeList();
}

watch(filtered, () => {
  if (openList.value) placeList();
});

onMounted(() => {
  window.addEventListener('resize', onViewportChange);
  window.addEventListener('scroll', onViewportChange, true);
});
onUnmounted(() => {
  window.removeEventListener('resize', onViewportChange);
  window.removeEventListener('scroll', onViewportChange, true);
});
</script>

<template>
  <div ref="root" class="resolver-picker">
    <div v-if="selected" class="resolver-chip">
      <div class="resolver-chip-head">
        <div class="resolver-chip-title">
          <strong class="resolver-chip-name">{{ selected.name }}</strong>
          <small>{{ selected.vendor }} · {{ t(selected.region) }}</small>
          <small v-if="selected.notes">{{ selected.notes }}</small>
        </div>
        <button type="button" class="resolver-chip-clear" :aria-label="t('Отменить выбор')" :disabled="disabled" @click="emit('clear')">
          <AppIcon name="close" />
        </button>
      </div>
    </div>
    <div v-else class="resolver-picker-field">
      <input
        ref="inputEl"
        class="app-input"
        role="combobox"
        aria-autocomplete="list"
        :aria-expanded="openList"
        :aria-label="label || t('Резолвер')"
        :placeholder="placeholder || t('Начните вводить имя или адрес резолвера')"
        :disabled="disabled"
        :value="query"
        @input="input"
        @focus="focus"
        @keydown="keydown"
        @blur="blur"
      />
      <AppButton v-if="showAddButton" size="s" variant="secondary" :disabled="disabled || !query.trim()" @click="submit">{{ t('Добавить') }}</AppButton>
    </div>
    <Transition :css="false" @enter="enterList" @leave="leaveList">
    <ul v-if="openList && filtered.length" ref="listEl" popover="manual" class="resolver-suggest" :style="listStyle" role="listbox" :aria-label="t('Известные резолверы')" @scroll="onScroll">
      <li
        v-for="(item, index) in visible"
        :key="item.id"
        role="option"
        :title="item.notes"
        :aria-selected="index === active"
        :class="{ highlighted: index === active }"
        @mousedown.prevent="choose(item)"
        @pointermove="active = index"
      >
        <span class="resolver-suggest-main">
          <strong>{{ item.name }}</strong>
          <small>{{ item.vendor }} · {{ t(item.region) }} · {{ t(filteringLabels[item.filtering] || item.filtering) }}</small>
        </span>
        <code>{{ displayCode(item) }}</code>
      </li>
    </ul>
    </Transition>
    <p v-if="openList && !filtered.length && query.trim()" class="muted resolver-hint">
      {{ t('Нет совпадений в библиотеке. Свой адрес добавляется вручную.') }}
    </p>
  </div>
</template>
