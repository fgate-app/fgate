<script setup>
import {onBeforeUnmount,onUnmounted,ref,watch,computed} from 'vue';
import ConfirmDialog from './ConfirmDialog.vue';
import {usePreferences} from '../preferences.js';
import {cancelOverlay,enterOverlay,leaveOverlay} from '../lib/overlay-motion.js';
const props=defineProps({open:Boolean,title:String,label:String,placement:{type:String,default:'center'},wide:Boolean,formState:{default:undefined},formSession:{default:undefined}});
const emit=defineEmits(['close','closed']);
const {t}=usePreferences();
const dialog=ref();
let backdropPointer=null;
const confirmOpen=ref(false),confirmMounted=ref(false);
let baseline,interacted=false;
const serialized=computed(()=>JSON.stringify(props.formState));
// Keep a draft baseline across multi-step dialogs; capture after asynchronous defaults load.
watch(()=>props.formSession ?? props.open,()=>{interacted=false;baseline=serialized.value;confirmOpen.value=false;},{flush:'sync'});
watch(serialized,value=>{if(!interacted)baseline=value;},{flush:'sync',immediate:true});
function captureForm(){if(props.formState===undefined)return;if(!interacted){baseline=serialized.value;interacted=true;}}
function closeFromBackdrop(){
 if(props.formState!==undefined && serialized.value!==baseline){confirmMounted.value=true;confirmOpen.value=true;}
 else emit('close');
}
function discard(){confirmOpen.value=false;emit('close');}
function lock(){
 document.body.style.overflow=document.querySelector('dialog[open]')?'hidden':'';
 window.dispatchEvent(new Event('freedomgate:dialogs-changed'));
}
function enter(_,done){
 backdropPointer=null;
 const element=dialog.value;
 element.inert=false;element.removeAttribute('aria-hidden');
 const firstField=element.querySelector('.app-dialog-body input:not([disabled]):not([readonly]):not([type="hidden"]),.app-dialog-body textarea:not([disabled]):not([readonly])');
 const firstAction=element.querySelector('.app-dialog-actions button:not([disabled])');
 const firstControl=element.querySelector('.app-dialog-body button:not([disabled]),.app-dialog-body input:not([disabled]):not([type="hidden"]),.app-dialog-body select:not([disabled]),.app-dialog-body textarea:not([disabled]),.app-dialog-body a[href]');
 const target=firstField || firstAction || firstControl || element.querySelector('.dialog-close');
 const hadAutofocus=target?.hasAttribute('autofocus');target?.setAttribute('autofocus','');
 if(!element.open)element.showModal();
 target?.focus({preventScroll:true});if(target && !hadAutofocus)target.removeAttribute('autofocus');
 lock();enterOverlay(element,done,{kind:props.placement==='drawer'?'drawer':'dialog',backdrop:true});
}
function leave(_,done){
 backdropPointer=null;
 const element=dialog.value;
 leaveOverlay(element,()=>{element.close();done();lock();emit('closed');},{kind:props.placement==='drawer'?'drawer':'dialog',backdrop:true});
}
onBeforeUnmount(()=>{cancelOverlay(dialog.value);dialog.value?.close();});
onUnmounted(lock);
function onCancel(event){event.preventDefault();emit('close');}
function isBackdrop(event){
 if(event.target!==dialog.value)return false;
 const bounds=dialog.value.getBoundingClientRect();
 return event.clientX<bounds.left || event.clientX>bounds.right || event.clientY<bounds.top || event.clientY>bounds.bottom;
}
function onPointerDown(event){backdropPointer=event.isPrimary && event.button===0 && isBackdrop(event)?event.pointerId:null;}
function onClick(event){const close=backdropPointer!==null && event.pointerId===backdropPointer && isBackdrop(event);backdropPointer=null;if(close)closeFromBackdrop();}
</script>

<template>
  <Teleport to="body">
    <dialog ref="dialog" class="app-dialog" :class="{'is-drawer':placement==='drawer','is-wide':wide}" :aria-label="label || title" @keydown.capture="captureForm" @pointerdown.capture="captureForm" @beforeinput.capture="captureForm" @cancel="onCancel" @pointerdown="onPointerDown" @pointercancel="backdropPointer = null" @click="onClick">
      <Transition appear :css="false" @enter="enter" @leave="leave">
      <div v-if="open" class="app-dialog-inner">
        <header class="app-dialog-head">
          <h2>{{ title }}</h2>
          <button type="button" class="dialog-close" :aria-label="t('Закрыть')" @click="emit('close')">×</button>
        </header>
        <div class="app-dialog-body"><slot /></div>
        <footer v-if="$slots.footer" class="app-dialog-actions"><slot name="footer" /></footer>
      </div>
      </Transition>
      <!-- Teleports must not share the Transition's managed child anchors. -->
      <div data-popup-host></div>
    </dialog>
    <ConfirmDialog v-if="confirmMounted" :open="confirmOpen" :title="t('Выйти без сохранения')" :message="t('Несохранённые изменения будут потеряны.')" :confirm-label="t('dialog.discard.exit')" cancel-label="Остаться" @close="confirmOpen=false" @confirm="discard" @closed="confirmMounted=false" />
  </Teleport>
</template>
