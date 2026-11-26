<script setup>
import {nextTick,onMounted,onUnmounted,ref,watch,useId,computed} from 'vue';
import {useProgressiveList} from '../lib/progressive.js';
import AppIcon from './AppIcon.vue';
import AppPopupList from './AppPopupList.vue';

const props=defineProps({
 actions:{type:Array,default:()=>[]},
 label:{type:String,default:'Действия'},
 icon:{type:String,default:'more'},
 testId:String,
 triggerless:Boolean,
 disabled:Boolean
});
const emit=defineEmits(['select']);
const id=useId();
const open=ref(false),trigger=ref(),menuView=ref(),position=ref({}),teleportTarget=ref('body');
const menu=computed(()=>menuView.value?.element),upward=ref(false);
const actions=computed(()=>props.actions);
const {visible:visibleActions,onScroll,ensure}=useProgressiveList(actions);
let row,anchorPoint,externalAnchor;
const getAnchor=()=>externalAnchor || trigger.value;

function close(restoreFocus=false){
 open.value=false;
 if(restoreFocus)getAnchor()?.focus();
}
function place(point){
 const rect=getAnchor()?.getBoundingClientRect();if(!rect)return;
 const margin=8,gap=4,width=Math.min(200,innerWidth-margin*2);
 const style=menu.value?getComputedStyle(menu.value):null;
 const height=menu.value?menu.value.scrollHeight+parseFloat(style.borderTopWidth)+parseFloat(style.borderBottomWidth):props.actions.length*44;
 const anchor=point?{top:point.y,bottom:point.y}:rect;
 const below=innerHeight-anchor.bottom-gap-margin,above=anchor.top-gap-margin;
 const flip=below<Math.min(height,240) && above>below;
 upward.value=flip;
 const maxHeight=Math.max(0,flip?above:below);
 const visibleHeight=Math.min(height,maxHeight);
 const left=Math.max(margin,Math.min(point?point.x:rect.right-width,innerWidth-width-margin));
 const top=flip?anchor.top-gap-visibleHeight:anchor.bottom+gap;
 position.value={left:`${left}px`,top:`${top}px`,minWidth:`${width}px`,maxWidth:`${innerWidth-margin*2}px`,maxHeight:`${maxHeight}px`,overflowY:'auto'};
}
async function show(point){
 anchorPoint=point;
 if(props.disabled || !props.actions.length || !getAnchor())return;
 window.dispatchEvent(new CustomEvent('freedomgate:row-menu-open',{detail:id}));
 teleportTarget.value=getAnchor()?.closest('dialog')?.querySelector('[data-popup-host]') || 'body';
 open.value=true;
 place(point);
 await nextTick();
 if(!open.value)return;
 if(typeof menu.value?.showPopover==='function' && !menu.value.matches(':popover-open'))menu.value.showPopover();
 place(point);
}
function toggle(event){event.stopPropagation();if(open.value)close();else show();}
function contextMenu(event){
 if(event.target.closest('tr')!==row || props.disabled || !props.actions.length)return;
 // Keep native editing and link menus available on embedded controls.
 if(event.target.closest('input,textarea,a,[contenteditable="true"],.custom-select'))return;
 event.preventDefault();event.stopPropagation();
 show(event.clientX || event.clientY?{x:event.clientX,y:event.clientY}:undefined);
}
function choose(action){
 if(action.disabled)return;
 close();
 emit('select',action.value);
}
function outside(event){
 if(!open.value || getAnchor()?.contains(event.target) || menu.value?.contains(event.target))return;
 close();
}
function keydown(event){
 if(!open.value)return;
 if(event.key==='Tab'){close(true);return;}
 if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close(true);return;}
 if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;
 event.preventDefault();
 const enabled=props.actions.map((action,index)=>({action,index})).filter(({action})=>!action.disabled);
 if(!enabled.length)return;
 const current=enabled.findIndex(({index})=>index===Number(document.activeElement?.dataset.index));
 const next=event.key==='Home'?0:event.key==='End'?enabled.length-1:current<0?(event.key==='ArrowDown'?0:enabled.length-1):(current+(event.key==='ArrowDown'?1:-1)+enabled.length)%enabled.length;
 const index=enabled[next].index;
 ensure(index);
 nextTick(()=>menu.value?.querySelector(`[data-index="${index}"]`)?.focus());
}
function otherMenu(event){if(event.detail!==id)close();}
function viewportChanged(event){
 if(!open.value || menu.value?.contains(event.target))return;
 if(event.type==='resize' || anchorPoint){close();return;}
 // Opening a menu near the viewport edge can finish a browser scroll after
 // the click. Follow the row instead of dismissing the just-opened menu.
 const rect=getAnchor()?.getBoundingClientRect();
 if(!rect || rect.bottom<0 || rect.top>innerHeight)close();else place();
}
watch(()=>props.disabled,value=>{if(value)close();});
onMounted(()=>{
 row=trigger.value?.closest('tbody tr');
 row?.addEventListener('contextmenu',contextMenu);
 document.addEventListener('pointerdown',outside);
 document.addEventListener('keydown',keydown);
 document.addEventListener('scroll',viewportChanged,true);
 window.addEventListener('resize',viewportChanged);
 window.addEventListener('freedomgate:row-menu-open',otherMenu);
});
onUnmounted(()=>{
 row?.removeEventListener('contextmenu',contextMenu);
 document.removeEventListener('pointerdown',outside);
 document.removeEventListener('keydown',keydown);
 document.removeEventListener('scroll',viewportChanged,true);
 window.removeEventListener('resize',viewportChanged);
 window.removeEventListener('freedomgate:row-menu-open',otherMenu);
});
defineExpose({close,openAt:async(element,point)=>{
 externalAnchor=element;await show(point);
 if(!point)menu.value?.querySelector('[role="menuitem"]:not([aria-disabled="true"])')?.focus();
}});
</script>

<template>
 <button v-if="!triggerless" ref="trigger" type="button" :class="icon==='plus'?'app-button button-secondary control-m button-icon':'row-menu-trigger'" :data-testid="testId" :aria-label="label" aria-haspopup="menu" :aria-expanded="open" :disabled="disabled || !actions.length" @click="toggle"><AppIcon :name="icon"/></button>
 <AppPopupList :open="open" ref="menuView" :to="teleportTarget" role="menu" :label="label" class="row-menu" :style="position" :upward="upward" @click.stop @contextmenu.prevent @scroll="onScroll">
    <li v-for="(action,index) in visibleActions" :key="action.value" role="menuitem" tabindex="-1" :data-index="index" :aria-disabled="!!action.disabled" :class="{'is-danger':action.danger,disabled:action.disabled}" @click="choose(action)" @keydown.enter.prevent="choose(action)" @keydown.space.prevent="choose(action)">
     <span>{{action.label}}</span>
    </li>
 </AppPopupList>
</template>
