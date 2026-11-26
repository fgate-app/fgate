<script setup>
import AppButton from './AppButton.vue';
import AppIcon from './AppIcon.vue';
import {usePreferences} from '../preferences.js';
import {notify} from '../lib/toasts.js';
import {useFormFeedback} from '../composables/useFormFeedback.js';
const props=defineProps({copyable:Boolean,value:[String,Number],icon:String,label:String,disabled:Boolean});
const emit=defineEmits(['action']);
const {t}=usePreferences(),{reportError}=useFormFeedback();
async function activate(event){
 if(!props.copyable){emit('action',event);return;}
 const text=String(props.value ?? ''),trigger=event.currentTarget;
 try{
  let copied=false;
  if(navigator.clipboard?.writeText){try{await navigator.clipboard.writeText(text);copied=true;}catch{}}
  if(!copied){
   const active=document.activeElement,field=document.createElement('textarea');
   field.value=text;field.style.position='fixed';field.style.opacity='0';
   (trigger.closest('dialog') || document.body).append(field);
   try{field.focus();field.select();if(!document.execCommand('copy'))throw Error();}
   finally{field.remove();active?.focus({preventScroll:true});}
  }
  notify(t('Содержимое скопировано'));
 }catch{reportError(t('Не удалось скопировать содержимое.'));}
}
</script>
<template><AppButton class="field-action" variant="blanc" size="s" icon-only :disabled="disabled" :aria-label="label || t('Копировать содержимое')" :title="label || t('Копировать содержимое')" @click.prevent.stop="activate"><AppIcon :name="icon || 'copy'" /></AppButton></template>
