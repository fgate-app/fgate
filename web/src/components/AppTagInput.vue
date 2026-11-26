<script setup>
import { computed, ref, watch, nextTick, onMounted, onUnmounted, useId } from 'vue';
import AppPopupList from './AppPopupList.vue';
import {popupHeight,useProgressiveList} from '../lib/progressive.js';
import AppTag from './AppTag.vue';
import AppSelect from './AppSelect.vue';

defineOptions({inheritAttrs:false});
const props = defineProps({
  modelValue: { type: Array, default: () => [] },
  options: Array,
  suggest:Boolean,
  suggestions:{type:Array,default:()=>[]},
  tagMeta: {type:Array,default:()=>[]},
  label: String,
  suffixAlign:{type:String,default:'center',validator:value=>['center','start'].includes(value)},
  maxTags: {type:Number,default:Infinity},
  separator: { type: String, default: ',' },
  placeholder: String,
  disabled: Boolean,
  size: { type: String, default: 'm', validator: v => ['m', 's'].includes(v) },
});
const emit = defineEmits(['update:modelValue','search','suggestion']);

const text = ref('');
const inputElement = ref(),rootElement=ref(),popupView=ref(),focused=ref(false),keyboardChoice=ref(false),active=ref(-1),position=ref({}),teleportTarget=ref('body');
const listId=useId()+'-suggestions';
const popup=computed(()=>popupView.value?.element);
const shown=computed(()=>focused.value && !!text.value.trim() && !!props.suggestions.length && !props.disabled);
const suggestionRows=computed(()=>props.suggestions);
const {visible,ensure,onScroll}=useProgressiveList(suggestionRows);
watch(text,value=>{keyboardChoice.value=false;active.value=-1;emit('search',value);});
watch(()=>props.suggestions,()=>{keyboardChoice.value=false;active.value=-1;nextTick(place);});
watch(shown,()=>nextTick(place));
function place(){if(!shown.value || !rootElement.value)return;const rect=rootElement.value.getBoundingClientRect(),{maxHeight,flip}=popupHeight(rootElement.value,Math.max(popup.value?.scrollHeight || 0,props.suggestions.reduce((height,option)=>height+(option.match?64:44),0)));position.value={left:Math.max(8,Math.min(rect.left,innerWidth-rect.width-8))+'px',width:Math.min(rect.width,innerWidth-16)+'px',maxHeight:maxHeight+'px',...(flip?{top:'auto',bottom:(innerHeight-rect.top+6)+'px'}:{top:(rect.bottom+6)+'px',bottom:'auto'})};}
function focus(){focused.value=true;teleportTarget.value=rootElement.value?.closest('dialog')?.querySelector('[data-popup-host]') || 'body';place();}
function chooseSuggestion(option){emit('suggestion',option);text.value='';focused.value=false;inputElement.value?.focus();}
function outside(event){if(!rootElement.value?.contains(event.target) && !popup.value?.contains(event.target))focused.value=false;}
onMounted(()=>{document.addEventListener('pointerdown',outside);window.addEventListener('resize',place);window.addEventListener('scroll',place,true);});
onUnmounted(()=>{document.removeEventListener('pointerdown',outside);window.removeEventListener('resize',place);window.removeEventListener('scroll',place,true);});
const available=computed(()=>props.options?.filter(option=>!props.modelValue.includes(option.value)) || []);
const tagInfo=tag=>props.tagMeta.find(option=>option.value===tag) || props.options?.find(option=>option.value===tag);
const tagLabel=tag=>tagInfo(tag)?.label || tag;
function focusInput(){if(!props.disabled)rootElement.value?.querySelector('input')?.focus();}
function addOption(value){if(props.disabled || tags().length>=props.maxTags || !available.value.some(option=>option.value===value && !option.disabled))return;emit('update:modelValue',[...tags(),value]);}
defineExpose({ focus: focusInput });

const tags = () => props.modelValue.filter(value => value != null && String(value).trim() !== '');

function splitValue(raw) {
  const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`[${escape(props.separator)}\\n\\r]`);
  return raw.split(pattern).map(value => value.trim()).filter(Boolean);
}

function commit() {
  const pieces = splitValue(text.value);
  text.value = '';
  if (!pieces.length) return;
  const next = [...new Set([...tags(), ...pieces])];
  emit('update:modelValue', next);
}

function onKeydown(event) {
  if (props.disabled || event.isComposing) return;
  if(shown.value && ['ArrowDown','ArrowUp'].includes(event.key)){event.preventDefault();keyboardChoice.value=true;active.value=(active.value+(event.key==='ArrowDown'?1:-1)+props.suggestions.length)%props.suggestions.length;ensure(active.value);nextTick(()=>document.getElementById(listId+'-'+active.value)?.scrollIntoView({block:'nearest'}));return;}
  if(shown.value && event.key==='Escape'){event.preventDefault();event.stopPropagation();focused.value=false;return;}
  if(shown.value && event.key==='Enter' && keyboardChoice.value && active.value>=0){event.preventDefault();chooseSuggestion(props.suggestions[active.value]);return;}
  if (event.key === props.separator || event.key === 'Enter') {
    event.preventDefault();
    commit();
  } else if (event.key === 'Backspace' && !text.value && tags().length) {
    emit('update:modelValue', tags().slice(0, -1));
  }
}

function onInput(event) {
  const value = event.target.value;
  // Paste with separators: split immediately so it becomes multiple tags.
  if (props.separator && value.includes(props.separator)) {
    const pieces = splitValue(value);
    if (pieces.length > 1) {
      text.value = '';
      emit('update:modelValue', [...new Set([...tags(), ...pieces])]);
      return;
    }
  }
  focused.value=true;
  text.value = value;
}

function onPaste(event) {
  const pasted = (event.clipboardData || window.clipboardData)?.getData('text') || '';
  if (!pasted) return;
  const pieces = splitValue(pasted);
  if (pieces.length > 1) {
    event.preventDefault();
    emit('update:modelValue', [...new Set([...tags(), ...pieces])]);
  }
}

function blur(){focused.value=false;if(props.suggest)text.value='';else commit();}

function removeTag(index) {
  const next = [...tags()];
  next.splice(index, 1);
  emit('update:modelValue', next);
}
</script>

<template>
  <!-- The input is first in DOM so an enclosing label associates with it, not a remove button. -->
  <div v-bind="$attrs" ref="rootElement" class="app-tag-input" :class="['control-'+size, { disabled }]" @click.prevent="focusInput">
    <div class="tag-list">
      <div v-if="options" class="tag-options" @keydown="!$event.defaultPrevented && $event.key==='Backspace' && !$event.target.value && !disabled && emit('update:modelValue',tags().slice(0,-1))">
        <AppSelect hide-chevron model-value="" :size="size" :options="available" :label="label" :placeholder="placeholder" :disabled="disabled || tags().length>=maxTags" @update:model-value="addOption" />
      </div>
      <input v-else
        ref="inputElement"
        class="tag-input"
        :aria-label="label"
        :value="text"
        :placeholder="tags().length ? '' : placeholder"
        :disabled="disabled"
        spellcheck="false"
        :role="suggest?'combobox':undefined"
        :aria-expanded="shown"
        aria-autocomplete="list"
        :aria-controls="shown?listId:undefined"
        :aria-activedescendant="shown && active>=0?listId+'-'+active:undefined"
        @focus="focus"
        @input="onInput"
        @keydown="onKeydown"
        @paste="onPaste"
        @blur="blur"
      />
      <AppTag v-for="(tag, index) in tags()" :key="tag" :label="tagLabel(tag)" :tone="tagInfo(tag)?.tone || 'neutral'" :size="size" removable :disabled="disabled" @remove="removeTag(index)" />
    </div>
    <span v-if="$slots.suffix" class="tag-input-suffix" :class="{'suffix-start':suffixAlign==='start'}"><slot name="suffix" /></span>
  </div>
  <AppPopupList :open="shown" ref="popupView" :to="teleportTarget" :style="position" :list-id="listId" :label="label" @scroll="onScroll">
    <li v-for="(option,index) in visible" :id="listId+'-'+index" :key="option.value" role="option" :aria-selected="active===index" :class="{highlighted:active===index}" @pointerdown.prevent @click="chooseSuggestion(option)" @pointermove="active=index;keyboardChoice=false"><span class="suggestion-text"><span>{{option.label}}</span><small v-if="option.match" class="suggestion-match">{{option.match}}</small></span><small v-if="option.description" class="suggestion-kind">{{option.description}}</small></li>
  </AppPopupList>
</template>

<style scoped>
.suggestion-text{display:grid;gap:var(--space-1);min-width:0;overflow-wrap:anywhere}
.suggestion-match{font-size:var(--font-size-body);color:var(--color-text-secondary)}
.suggestion-kind{color:var(--color-text-secondary);font-size:var(--font-size-body);flex-shrink:0}
.app-tag-input{transition:border-color .15s;align-items:center}
.app-tag-input.control-m{--tag-input-inner-height:var(--space-8);padding:var(--space-1) var(--space-2)}
.app-tag-input.control-s{--tag-input-inner-height:var(--space-6);padding:calc(var(--space-1)/2) var(--space-2)}
.tag-input{min-height:0;height:var(--tag-input-inner-height);padding:0 var(--space-1);font-size:var(--font-size-body);line-height:var(--space-5)}
.tag-list :deep(.app-tag){padding-block:0}
.tag-list{flex:1;min-width:0}
.tag-input,.tag-options{order:1}
.tag-input-suffix{flex:none;align-self:center;white-space:nowrap;color:var(--color-text-secondary);font-size:var(--font-size-body)}
.tag-input-suffix.suffix-start{align-self:flex-start;padding-top:calc((var(--tag-input-inner-height) - var(--space-6))/2)}
.tag-options{flex:1;min-width:var(--space-12)}
.tag-options :deep(.select-input){padding-inline:var(--space-1);height:var(--tag-input-inner-height);min-height:0;padding-block:0;background:transparent;border:0;box-shadow:none}
.tag-options :deep(.select-input:hover),.tag-options :deep(.select-input:focus){background:transparent;box-shadow:none;outline:none}
</style>
