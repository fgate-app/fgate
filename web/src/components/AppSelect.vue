<script setup>
import { ref, computed, nextTick, watch, onMounted, onUnmounted, useId } from 'vue';
import { mdiChevronDown, mdiCheck } from '@mdi/js';
import AppPopupList from './AppPopupList.vue';
import { usePreferences } from '../preferences.js';
import { popupHeight, useProgressiveList } from '../lib/progressive.js';
defineOptions({inheritAttrs:false});
const props=defineProps({size:{type:String,default:'m',validator:v=>['m','s'].includes(v)},modelValue:String,options:{type:Array,default:()=>[]},editable:Boolean,minSearchLength:{type:Number,default:0},hideChevron:Boolean,disabled:Boolean,label:String,placeholder:String});
const emit=defineEmits(['update:modelValue','select']);
const {t}=usePreferences();
const root=ref(),input=ref(),popupView=ref(),open=ref(false),query=ref(''),active=ref(-1),position=ref({}),teleportTarget=ref('body');
const popup=computed(()=>popupView.value?.element);
const id=useId(),listId=id+'-list';
const selected=computed(()=>props.options.find(o=>o.value===props.modelValue));
const filtered=computed(()=>{const q=query.value.trim().toLocaleLowerCase();return props.options.filter(o=>String(o.searchText ?? o.label).toLocaleLowerCase().includes(q));});
const {visible,ensure,onScroll}=useProgressiveList(filtered);
watch(active,index=>ensure(index));
function place(){if(!open.value || !root.value)return;const rect=root.value.getBoundingClientRect(),content=filtered.value.length*44,{maxHeight,flip}=popupHeight(root.value,content);position.value={position:'fixed',left:Math.max(8,Math.min(rect.left,innerWidth-rect.width-8))+'px',width:Math.min(rect.width,innerWidth-16)+'px',maxHeight:maxHeight+'px',margin:'0',right:'auto',...(flip?{top:'auto',bottom:(innerHeight-rect.top+6)+'px'}:{top:(rect.bottom+6)+'px',bottom:'auto'})};}
async function show(){if(props.disabled || open.value || (props.editable && String(props.modelValue || '').trim().length<props.minSearchLength))return;teleportTarget.value=root.value?.closest('dialog')?.querySelector('[data-popup-host]') || 'body';query.value=props.editable?(props.modelValue || ''):'';open.value=true;active.value=filtered.value.findIndex(o=>o.value===props.modelValue && !o.disabled);if(active.value<0)active.value=filtered.value.findIndex(o=>!o.disabled);place();await nextTick();input.value?.focus();scrollActive();}
function close(){open.value=false;query.value='';}
function choose(option){if(!option || option.disabled)return;emit('update:modelValue',option.value);emit('select',option);close();input.value?.focus();}
function scrollActive(){nextTick(()=>document.getElementById(id+'-option-'+active.value)?.scrollIntoView({block:'nearest'}));}
function move(step){const options=filtered.value;if(!options.length)return;let index=active.value;for(let n=0;n<options.length;n++){index=(index+step+options.length)%options.length;if(!options[index].disabled){active.value=index;scrollActive();return;}}}
function keydown(event){if(event.isComposing)return;if(!props.editable && !open.value && event.key.length===1 && !event.ctrlKey && !event.metaKey && !event.altKey){event.preventDefault();show();query.value=event.key;active.value=filtered.value.findIndex(o=>!o.disabled);place();return;}if(event.key==='Escape'){event.preventDefault();if(open.value)event.stopPropagation();close();return;}if(event.key==='Tab'){close();return;}if(['ArrowDown','ArrowUp'].includes(event.key)){event.preventDefault();if(!open.value)show();else move(event.key==='ArrowDown'?1:-1);return;}if(event.key==='Enter'){event.preventDefault();if(open.value)choose(filtered.value[active.value]);else show();return;}if(open.value && ['Home','End'].includes(event.key)){event.preventDefault();const indices=filtered.value.map((o,i)=>!o.disabled?i:-1).filter(i=>i>=0);active.value=event.key==='Home'?indices[0]:indices.at(-1);scrollActive();}}
function search(event){query.value=event.target.value;open.value=query.value.trim().length>=props.minSearchLength;if(props.editable)emit('update:modelValue',query.value);active.value=filtered.value.findIndex(o=>!o.disabled);place();}
function outside(event){if(!root.value?.contains(event.target) && !popup.value?.contains(event.target))close();}
watch(()=>props.disabled,value=>{if(value)close();});
watch(filtered,()=>{place();});
onMounted(()=>{document.addEventListener('pointerdown',outside);window.addEventListener('resize',place);window.addEventListener('scroll',place,true);});
onUnmounted(()=>{document.removeEventListener('pointerdown',outside);window.removeEventListener('resize',place);window.removeEventListener('scroll',place,true);});
</script>
<template><div ref="root" class="custom-select" :class="[{disabled,open},'control-'+size]"><input ref="input" v-bind="$attrs" class="select-input" :class="['control-'+size,{'editable-input':editable}]" role="combobox" type="text" autocomplete="off" :disabled="disabled" :aria-label="label || $attrs['aria-label']" aria-autocomplete="list" aria-haspopup="listbox" :aria-expanded="open" :aria-controls="open?listId:undefined" :aria-activedescendant="open && active>=0?id+'-option-'+active:undefined" :value="open?query:(editable?(modelValue || ''):(selected?.label || ''))" :placeholder="open && !editable?t('Поиск…'):placeholder" @click="show" @focus="editable && show()" @keydown="keydown" @input="search" @blur="close"/><span v-if="!editable && !hideChevron" class="select-chevron" aria-hidden="true" @pointerdown.prevent @click="open?close():show()"><svg viewBox="0 0 24 24"><path :d="mdiChevronDown" fill="currentColor"/></svg></span><AppPopupList :open="open" ref="popupView" :to="teleportTarget" :style="position" :upward="position.top==='auto'" :list-id="listId" :label="label || $attrs['aria-label']" :empty-text="!filtered.length?t('Нет результатов'):undefined" @scroll="onScroll"><li v-for="(option,index) in visible" :id="id+'-option-'+index" :key="option.value" role="option" :aria-selected="option.value===modelValue" :aria-disabled="!!option.disabled" :class="{highlighted:index===active,disabled:option.disabled}" @pointerdown.prevent @click="choose(option)" @pointermove="!option.disabled && (active=index)"><span>{{option.label}}</span><svg v-if="option.value===modelValue" viewBox="0 0 24 24" aria-hidden="true"><path :d="mdiCheck" fill="currentColor"/></svg></li></AppPopupList></div></template>

<style scoped>
.editable-input{cursor:text;padding-inline:var(--space-3)}
</style>
