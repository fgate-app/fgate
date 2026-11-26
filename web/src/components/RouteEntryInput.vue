<script setup>
import {routeEntrySelection} from '../../../shared/route-preset-entries.js';
import {computed,ref,watch,onUnmounted,nextTick} from 'vue';
import AppTagInput from './AppTagInput.vue';
import AppTextarea from './AppTextarea.vue';
import AppButton from './AppButton.vue';
import AppIcon from './AppIcon.vue';
import DomainPresetPicker from './DomainPresetPicker.vue';
import AppPopupList from './AppPopupList.vue';
import AppRowMenu from './AppRowMenu.vue';
import {popupHeight} from '../lib/progressive.js';
import {normalizeRouteEntries} from '../lib/form-validation.js';
import {parseRouteFile} from '../../../shared/route-file.js';
import {notify} from '../lib/toasts.js';
import {usePreferences} from '../preferences.js';
const props=defineProps({modelValue:{type:Array,default:()=>[]},presets:{type:Array,default:()=>[]},disabled:Boolean,active:Boolean,api:Function});
const emit=defineEmits(['update:modelValue','update:presets']);
const {t}=usePreferences();
const preview=ref(false);
const root=ref(),plus=ref(),menu=ref(),file=ref(),catalog=ref(null),loading=ref(false),presetOpen=ref(false),popupView=ref(),position=ref({}),target=ref('body'),query=ref(''),matches=ref([]),suggestionsReady=ref(false);
let lifecycle=0,searchCycle=0,loadController,searchController,timer;
const suggestions=computed(()=>suggestionsReady.value && query.value.trim()?[...matches.value.filter(p=>!props.presets.some(selected=>selected.id===p.id)).map(p=>({value:p.id,match:p.match,label:(p.combined?t('{name} (trackers and ads)',{name:t(p.label)}):t(p.label))+' · '+p.count})),{value:'manual:',label:t('Add: {value}',{value:query.value.trim()})}]:[]);
async function load(){const cycle=lifecycle;loadController?.abort();loadController=new AbortController();const signal=loadController.signal;loading.value=true;
 try{let value=await props.api('domain-lists',{signal});if(!value.updatedAt){await props.api('domain-lists/update',{method:'POST',body:'{}',signal});value=await props.api('domain-lists',{signal});}if(cycle===lifecycle)catalog.value=value;}
 catch(error){if(error.name!=='AbortError' && cycle===lifecycle)notify(t(error.message),'error');}
 finally{if(cycle===lifecycle)loading.value=false;}
}
function search(value){query.value=value;suggestionsReady.value=false;matches.value=[];clearTimeout(timer);searchController?.abort();const cycle=++searchCycle,q=value.trim();if(!q || !props.api || !props.active)return;
 const run=async()=>{if(q.length>=3)suggestionsReady.value=true;searchController=new AbortController();try{const result=await props.api('domain-lists/search?q='+encodeURIComponent(q),{signal:searchController.signal});if(cycle===searchCycle && props.active){matches.value=result.presets || [];suggestionsReady.value=true;}}catch(error){if(error.name!=='AbortError' && cycle===searchCycle){suggestionsReady.value=true;notify(t(error.message),'error');}}};
 if(q.length>=3)run();else timer=setTimeout(run,q.length===1?450:200);
}
async function addPreset(id){if(props.disabled)return;if(props.presets.some(p=>p.id===id)){presetOpen.value=false;return;}const cycle=lifecycle;loading.value=true;
 try{const result=await props.api('domain-lists/'+id);if(cycle!==lifecycle || !props.active)return;if(!result.domains?.length)throw Error('Preset is not downloaded.');const p=catalog.value?.presets.find(p=>p.id===id) || matches.value.find(p=>p.id===id);emit('update:presets',[...props.presets,{id,label:p?.label || id,combined:!!p?.combined,entries:result.domains}]);presetOpen.value=false;}
 catch(error){if(cycle===lifecycle)notify(t(error.message),'error');}finally{if(cycle===lifecycle)loading.value=false;}
}
function selectSuggestion(option){if(option.value==='manual:')emit('update:modelValue',[...new Set([...props.modelValue,query.value.trim()])]);else addPreset(option.value);}
function place(){if(!presetOpen.value || !plus.value?.$el)return;const anchor=plus.value.$el,rect=anchor.getBoundingClientRect(),width=Math.min(360,innerWidth-16),{maxHeight,flip}=popupHeight(anchor,popupView.value?.element?.scrollHeight || 320);position.value={left:Math.max(8,Math.min(rect.right-width,innerWidth-width-8))+'px',width:width+'px',maxHeight:maxHeight+'px',...(flip?{top:'auto',bottom:(innerHeight-rect.top+6)+'px'}:{top:(rect.bottom+6)+'px',bottom:'auto'})};}
function openMenu(){presetOpen.value=false;menu.value.openAt(plus.value.$el);}
async function action(value){presetOpen.value=false;if(value==='file'){file.value.click();return;}target.value=root.value?.closest('dialog')?.querySelector('[data-popup-host]') || 'body';presetOpen.value=true;place();await nextTick();place();popupView.value?.element?.querySelector('input')?.focus({preventScroll:true});}
function outside(event){if(presetOpen.value && !plus.value?.$el?.contains(event.target) && !popupView.value?.element?.contains(event.target) && !event.target.closest?.('.select-popup'))presetOpen.value=false;}
async function importFile(event){const input=event.target,selected=input.files?.[0];input.value='';if(!selected)return;const cycle=lifecycle;
 try{if(selected.size>2*1024*1024)throw Error('The rule file is too large.');const content=new TextDecoder('utf-8',{fatal:true}).decode(await selected.arrayBuffer());const rows=parseRouteFile(content,normalizeRouteEntries);const merged=normalizeRouteEntries([...props.modelValue,...rows]);if(cycle===lifecycle && props.active && !props.disabled)emit('update:modelValue',merged);}
 catch(error){if(cycle!==lifecycle || !props.active)return;notify(t(error instanceof TypeError?'The rule file must use UTF-8.':error.message),'error');}
}
watch(()=>props.active,active=>{lifecycle++;presetOpen.value=false;preview.value=false;query.value='';matches.value=[];suggestionsReady.value=false;clearTimeout(timer);searchCycle++;searchController?.abort();loadController?.abort();if(active && props.api)load();},{immediate:true});
watch(presetOpen,open=>{if(open){document.addEventListener('pointerdown',outside);window.addEventListener('resize',place);window.addEventListener('scroll',place,true);}else{document.removeEventListener('pointerdown',outside);window.removeEventListener('resize',place);window.removeEventListener('scroll',place,true);}});
onUnmounted(()=>{lifecycle++;searchCycle++;clearTimeout(timer);loadController?.abort();searchController?.abort();document.removeEventListener('pointerdown',outside);window.removeEventListener('resize',place);window.removeEventListener('scroll',place,true);});
const prefix='preset:';
const tokens=computed(()=>[...props.presets.map(p=>prefix+p.id),...props.modelValue]);
const metadata=computed(()=>[...props.presets.map(p=>({value:prefix+p.id,label:(p.combined?t('{name} (trackers and ads)',{name:t(p.label || p.id)}):t(p.label || p.id))+' · '+(Array.isArray(p.entries)?p.entries.length:p.count ?? 0),tone:'preset'})),...props.modelValue.map(value=>({value,tone:'user'}))]);
const text=computed(()=>{const selected=routeEntrySelection(props.modelValue,props.presets);return [...selected.entries,...selected.exclusions.map(entry=>'exclude:'+entry)].join('\n');});
function update(values){emit('update:presets',props.presets.filter(p=>values.includes(prefix+p.id)));emit('update:modelValue',values.filter(value=>!value.startsWith(prefix)));}
</script>
<template>
  <div ref="root" class="route-entry-editor" data-testid="route-entry-editor">
    <div class="route-entry-row">
    <AppTextarea v-if="preview" :model-value="text" :rows="7" readonly :aria-label="t('Route entries preview')" data-testid="route-entries-preview" action-icon="mdiTagMultiple" :action-label="t('Edit route tags')" @action="preview=false" />
    <AppTagInput v-else suggest :model-value="tokens" :tag-meta="metadata" :suggestions="suggestions" @search="search" @suggestion="selectSuggestion" separator="" suffix-align="start" :label="t('Домены и IP-адреса')" :placeholder="t('Add a domain, IP or rule and press Enter')" :disabled="disabled" data-testid="route-entry-tags" @update:model-value="update">
      <template #suffix><AppButton variant="blanc" size="s" icon-only :aria-label="t('Preview route entries')" :title="t('Preview route entries')" :aria-pressed="false" data-testid="route-preview-toggle" @click.stop="preview=true"><AppIcon name="mdiCardTextOutline" /></AppButton></template>
    </AppTagInput>
    <AppButton v-if="api" ref="plus" variant="secondary" icon-only :disabled="disabled" :aria-label="t('Add rules')" data-testid="route-add-menu" @click.stop="openMenu"><AppIcon name="plus" /></AppButton>
    </div>
    <input ref="file" type="file" hidden accept="text/plain,.txt,.list,.dat" data-testid="route-file-input" @change="importFile" />
    <AppRowMenu ref="menu" triggerless :actions="[{value:'preset',label:t('Add preset')},{value:'file',label:t('Upload file')}]" :label="t('Add rules')" @select="action" />
    <AppPopupList :open="presetOpen" ref="popupView" :to="target" role="presentation" :style="position" class="user-popup route-preset-popover" @keydown.esc.stop.prevent="presetOpen=false">
      <template #content><div role="group" :aria-label="t('Add preset')"><DomainPresetPicker :catalog="catalog" :disabled="disabled || loading" @add="addPreset" /></div></template>
    </AppPopupList>
  </div>
</template>

<style scoped>
.route-entry-row{display:flex;align-items:flex-start;gap:var(--space-2)}
.route-entry-row>:first-child{flex:1;min-width:0}
.route-preset-popover{padding:var(--space-5);border-radius:var(--radius-popup)}
</style>
