<script setup>
import {ref,onMounted,onUpdated} from 'vue';
import {usePreferences} from '../preferences.js';
defineProps({loading:Boolean,skeletonRows:{type:Number,default:5}});
const {t}=usePreferences();
const columns=ref(1);
const table=ref();
// Derive card labels from the same localized headers used on desktop.
// Attribute-only updates preserve existing Vue cells, controls and row handlers.
function syncLabels(){
 const element=table.value;if(!element)return;
 const headers=[...(element.tHead?.rows[0]?.cells || [])].map(cell=>cell.textContent.trim());
 columns.value=Math.max(1,headers.length);
 if(element.tHead){element.tHead.setAttribute('role','rowgroup');for(const row of element.tHead.rows){row.setAttribute('role','row');for(const cell of row.cells)cell.setAttribute('role','columnheader');}}
 for(const body of element.tBodies){body.setAttribute('role','rowgroup');for(const row of body.rows){
  row.setAttribute('role','row');
  [...row.cells].forEach((cell,index)=>{cell.setAttribute('role','cell');const label=cell.colSpan===1?headers[index] || '':'';if(cell.dataset.label!==label)cell.dataset.label=label;});
 }}
}
onMounted(syncLabels);onUpdated(syncLabels);
</script>
<template><table ref="table" role="table" class="responsive-table" :class="{'table-loading':loading}" :aria-busy="loading">
 <caption v-if="loading" class="table-loading-caption" role="status">{{t('Загрузка…')}}</caption>
 <slot />
 <tbody v-if="loading" class="table-skeleton" aria-hidden="true" data-testid="table-skeleton">
  <tr v-for="row in skeletonRows" :key="row"><td v-for="column in columns" :key="column"><span class="skeleton-bar" :class="{'skeleton-short':column===columns}" /></td></tr>
 </tbody>
</table></template>
<style scoped>
.responsive-table{--table-row-min-height:57px}
.responsive-table>:deep(thead>tr),.responsive-table>:deep(tbody>tr),.responsive-table>:deep(tfoot>tr){height:var(--table-row-min-height)}
/* Grid cards need automatic height so their contents can grow on narrow screens. */
@media(max-width:900px){
 .responsive-table>:deep(thead>tr),.responsive-table>:deep(tbody>tr),.responsive-table>:deep(tfoot>tr){height:auto;min-height:var(--table-row-min-height)}
}
.table-loading>:deep(tbody:not(.table-skeleton)){display:none!important}
.table-loading-caption{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.table-skeleton tr{pointer-events:none}
.table-skeleton tr:hover{background:transparent!important}
.skeleton-bar{display:block;height:var(--space-3);width:75%;min-width:var(--space-6);margin-block:var(--space-2);border-radius:var(--radius-pill);background:var(--color-border-subtle);animation:table-skeleton-pulse 1.4s ease-in-out infinite}
.table-skeleton tr:nth-child(even) .skeleton-bar{width:55%;animation-delay:.15s}
.skeleton-bar.skeleton-short{width:var(--space-6)}
@keyframes table-skeleton-pulse{50%{opacity:.4}}
@media(prefers-reduced-motion:reduce){.skeleton-bar{animation:none}}
</style>
