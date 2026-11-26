<script setup>
import {computed,ref} from 'vue';
import * as materialIcons from '@mdi/js';
import AppInput from '../components/AppInput.vue';
import {useProgressiveList} from '../lib/progressive.js';
import {usePreferences} from '../preferences.js';
const {locale}=usePreferences();
const labels=computed(()=>({ru:{search:'Поиск по названию иконки',count:'Иконки',empty:'Иконки не найдены'},'zh-CN':{search:'按图标名称搜索',count:'图标',empty:'未找到图标'}}[locale.value]||{search:'Search icons by name',count:'Icons',empty:'No icons found'}));
const query=ref('');
const icons=Object.entries(materialIcons).filter(([name,path])=>name.startsWith('mdi')&&typeof path==='string').sort(([a],[b])=>a.localeCompare(b));
const normalize=value=>value.toLowerCase().replace(/[^a-z0-9]/g,'');
const matches=computed(()=>{const text=normalize(query.value.trim());return icons.filter(([name])=>normalize(name).includes(text));});
const {visible,onScroll}=useProgressiveList(matches,{step:120});
</script>
<template>
 <section class="material-catalog">
  <div class="material-catalog-toolbar">
   <AppInput v-model="query" type="search" :aria-label="labels.search" :placeholder="labels.search" />
   <span class="material-catalog-count" role="status">{{labels.count}}: {{matches.length}} / {{icons.length}}</span>
  </div>
  <div :key="query" class="material-catalog-scroll" @scroll="onScroll">
   <div v-if="matches.length" class="material-catalog-grid">
    <div v-for="[name,path] in visible" :key="name" class="material-catalog-item" :data-icon="name">
     <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path :d="path" fill="currentColor" /></svg>
     <span>{{name}}</span>
    </div>
   </div>
   <p v-else class="material-catalog-empty">{{labels.empty}}</p>
  </div>
 </section>
</template>
<style scoped>
.material-catalog{display:grid;gap:var(--space-6);color:var(--color-text-primary)}
.material-catalog-toolbar{display:flex;align-items:center;flex-wrap:wrap;gap:var(--space-4)}
.material-catalog-toolbar .app-input{flex:1;min-width:0}
.material-catalog-count{color:var(--color-text-secondary);font-size:var(--font-size-body)}
.material-catalog-scroll{height:70vh;overflow:auto;min-height:0}
.material-catalog-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:var(--space-3)}
.material-catalog-item{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:var(--space-3);padding:var(--space-4);border:1px solid var(--color-border);border-radius:var(--radius-control);text-align:center}
.material-catalog-item svg{flex-shrink:0;width:24px;height:24px}
.material-catalog-item span{font-size:var(--font-size-body);overflow-wrap:anywhere;user-select:text}
.material-catalog-empty{padding:var(--space-6);color:var(--color-text-secondary)}
</style>
