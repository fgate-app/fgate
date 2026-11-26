<script setup>
import {onBeforeUnmount,ref} from 'vue';
import {cancelOverlay,enterOverlay,leaveOverlay} from '../lib/overlay-motion.js';
defineOptions({inheritAttrs:false});
const props=defineProps({open:{type:Boolean,default:true},to:{type:[String,Object],default:'body'},role:{type:String,default:'listbox'},label:String,listId:String,emptyText:String,upward:Boolean});
const element=ref();
defineExpose({element});
function enter(popup,done){
 if(typeof popup.showPopover==='function' && !popup.matches(':popover-open'))popup.showPopover();
 enterOverlay(popup,done,{upward:props.upward});
}
function leave(popup,done){leaveOverlay(popup,()=>{if(typeof popup.hidePopover==='function' && popup.matches(':popover-open'))popup.hidePopover();done();});}
onBeforeUnmount(()=>cancelOverlay(element.value));
</script>
<template>
 <Teleport :to="to">
  <Transition appear :css="false" @enter="enter" @leave="leave">
  <div v-if="open" ref="element" v-bind="$attrs" popover="manual" class="select-popup popup-list">
   <slot name="content"><ul :id="listId" :role="role" :aria-label="label"><slot /></ul></slot>
   <div v-if="emptyText" class="select-empty" role="status">{{emptyText}}</div>
  </div>
  </Transition>
 </Teleport>
</template>
<style>
.popup-list{position:fixed;z-index:1200;margin:0;padding:0;right:auto;bottom:auto;background:var(--color-surface);color:var(--color-text-primary);border:1px solid transparent;border-radius:var(--radius-popup);box-shadow:0 12px 36px #0003;overflow-y:auto;overscroll-behavior:contain;font-size:var(--font-size-body)}
:root[data-theme="dark"] .popup-list{box-shadow:0 12px 36px #0009}
.popup-list ul{list-style:none;margin:0;padding:0}
.popup-list li{display:flex;align-items:center;justify-content:space-between;gap:var(--space-3);min-height:44px;padding:var(--space-2) var(--space-3);border-radius:calc(var(--radius-control) / 2);cursor:pointer;overflow-wrap:anywhere}
.popup-list li:not(.disabled):hover,.popup-list li:not(.disabled):focus-visible,.popup-list li.highlighted:not(.disabled){background:var(--color-secondary)}
.popup-list li[aria-selected=true]{font-weight:500}
.popup-list li.is-danger{color:var(--color-danger)}
.popup-list li.disabled{opacity:.45;cursor:not-allowed}
.popup-list li svg{width:18px;height:18px;flex-shrink:0;color:var(--color-on-secondary)}
.popup-list .select-empty{padding:var(--space-4) var(--space-3);color:var(--color-text-secondary)}
</style>
