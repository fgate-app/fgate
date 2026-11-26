<script setup>
import {useFormFeedback} from '../composables/useFormFeedback.js';
import {computed,ref,useId,watch} from 'vue';
import {usePreferences} from '../preferences.js';
import AppButton from './AppButton.vue';
import AppIcon from './AppIcon.vue';
const {reportError}=useFormFeedback();
defineOptions({inheritAttrs:false});
const props=defineProps({modelValue:{type:Object,default:null},label:{type:String,required:true},accept:String,maxSize:{type:Number,default:0},disabled:Boolean,loading:Boolean,hint:String,error:String});
const emit=defineEmits(['update:modelValue','reject']);
const {t,locale}=usePreferences();
const id=useId(),input=ref(),chooseButton=ref(),dragging=ref(false),validation=ref('');
const blocked=computed(()=>props.disabled || props.loading);
const message=computed(()=>t(props.error || validation.value));
const fileSize=computed(()=>{
 const bytes=props.modelValue?.size ?? 0,unit=bytes>=1048576?'MB':bytes>=1024?'KB':'B',divisor=unit==='MB'?1048576:unit==='KB'?1024:1;
 return new Intl.NumberFormat(locale.value,{style:'unit',unit:unit==='MB'?'megabyte':unit==='KB'?'kilobyte':'byte',unitDisplay:'short',maximumFractionDigits:1}).format(bytes/divisor);
});
watch(()=>props.error,value=>{if(value)reportError(value);});
watch(()=>props.modelValue,()=>{validation.value='';if(input.value)input.value.value='';});
watch(blocked,value=>{if(value)dragging.value=false;});
function reject(text){validation.value=text;reportError(text);emit('reject',t(text));}
function receive(files){
 if(blocked.value)return;
 validation.value='';
 if(!files?.length)return;
 if(files.length!==1){reject('Выберите один файл.');return;}
 const file=files[0];
 const formats=(props.accept || '').split(',').map(s=>s.trim().toLowerCase()).filter(Boolean);
 const mime=file.type.toLowerCase(),name=file.name.toLowerCase();
 if(formats.length && !formats.some(format=>format==='*/*' || (format.startsWith('.')?name.endsWith(format):format.endsWith('/*')?mime.startsWith(format.slice(0,-1)):mime===format))){reject('Этот формат файла не поддерживается.');return;}
 if(props.maxSize && file.size>props.maxSize){reject('Размер файла превышает допустимый.');return;}
 emit('update:modelValue',file);
}
function change(event){receive(event.target.files);event.target.value='';}
function drop(event){dragging.value=false;receive(event.dataTransfer?.files);}
function leave(event){if(!event.currentTarget.contains(event.relatedTarget))dragging.value=false;}
function clear(){if(blocked.value)return;validation.value='';emit('update:modelValue',null);chooseButton.value?.focus();}
defineExpose({focus:()=>chooseButton.value?.focus()});
</script>
<template>
 <div class="app-file-upload" :class="{dragging,disabled:blocked,invalid:!!message}" role="group" :aria-labelledby="id+'-label'" :aria-describedby="hint?id+'-hint':undefined" :aria-busy="loading" :aria-disabled="blocked" :aria-invalid="!!message" @dragenter.prevent="!blocked && (dragging=true)" @dragover.prevent="!blocked && (dragging=true)" @dragleave.prevent="leave" @drop.prevent="drop">
  <span :id="id+'-label'" class="file-upload-label">{{label}}</span>
  <input :id="id" ref="input" v-bind="$attrs" class="file-upload-native" type="file" hidden :accept="accept" :disabled="blocked" :aria-label="label" :aria-describedby="hint?id+'-hint':undefined" :aria-invalid="!!message" @change="change" />
  <div class="file-upload-zone">
   <AppIcon :name="modelValue?'file':'upload'" class="file-upload-icon" />
   <div class="file-upload-details" role="status" aria-live="polite">
    <span class="file-upload-title">{{modelValue?modelValue.name:t('Перетащите файл сюда')}}</span>
    <span class="file-upload-caption">{{loading?t('Чтение файла…'):modelValue?fileSize:t('Или выберите файл на устройстве')}}</span>
   </div>
   <div class="file-upload-actions">
    <AppButton ref="chooseButton" variant="secondary" :disabled="blocked" :aria-controls="id" :aria-describedby="hint?id+'-hint':undefined" @click="input?.click()">{{t(modelValue?'Заменить файл':'Выбрать файл')}}</AppButton>
    <AppButton v-if="modelValue" variant="secondary" size="s" icon-only :disabled="blocked" :aria-label="t('Убрать файл')" @click="clear"><AppIcon name="close" /></AppButton>
   </div>
  </div>
  <small v-if="hint" :id="id+'-hint'" class="file-upload-hint">{{hint}}</small>
 </div>
</template>
<style scoped>
.app-file-upload{display:grid;gap:var(--space-2);min-width:0;font-size:var(--font-size-body)}
.file-upload-label{color:var(--color-text-primary)}
.file-upload-native{display:none}
.file-upload-zone{display:flex;align-items:center;flex-wrap:wrap;gap:var(--space-3);padding:var(--space-4);border:1px dashed var(--control-outline);border-radius:var(--radius-control);background:var(--color-secondary);transition:background-color .15s,border-color .15s}
.app-file-upload:not(.disabled) .file-upload-zone:hover{background:var(--color-secondary-hover)}
.app-file-upload.dragging .file-upload-zone{background:var(--color-accent-soft);border-color:var(--color-primary)}
.app-file-upload:focus-within .file-upload-zone{border-color:var(--color-accent)}
.app-file-upload.invalid .file-upload-zone{border-color:var(--color-danger)}
.app-file-upload.disabled .file-upload-zone{opacity:.5}
.file-upload-icon{width:var(--space-6);height:var(--space-6);flex-shrink:0;color:var(--color-text-secondary)}
.file-upload-details{display:grid;gap:var(--space-1);flex:1;min-width:0;flex-basis:var(--space-12)}
.file-upload-title{font-weight:500;color:var(--color-text-primary);overflow-wrap:anywhere}
.file-upload-caption,.file-upload-hint{color:var(--color-text-secondary);line-height:1.45;font-size:var(--font-size-body)}
.file-upload-actions{display:flex;align-items:center;gap:var(--space-2);flex-wrap:wrap}
@media(max-width:600px){.file-upload-actions{flex-basis:100%;justify-content:flex-end}}
</style>
