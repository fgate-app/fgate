import {watch,onUnmounted} from 'vue';
import {notify,updateToast,dismiss} from '../lib/toasts.js';
import {usePreferences} from '../preferences.js';
export function useInlineChanges(api,state,user){
 const {t,locale}=usePreferences();let pollTimer,dismissTimer,id=null,active=false,generation=0,lastTerminal='',lastState='';
 const message=value=>value.state==='pending'?t("Changes will apply in"):value.state==='applying'?t('Применение изменений…'):value.state==='applied'?t("Changes applied."):t("Could not apply changes.")+(value.error?' '+t(value.error):'');
 function show(value){
  const terminal=['applied','error'].includes(value.state),key=value.instance+':'+value.revision+':'+value.state;
  if(key===lastState || (terminal && key===lastTerminal))return;
  lastState=key;
  if(value.state==='applied' && !id){lastTerminal=key;return;}
  clearTimeout(dismissTimer);
  const patch={message:message(value),type:value.state==='error'?'error':value.state==='applied'?'success':'info',deadline:value.state==='pending'?value.deadline:null};
  if(!id || !updateToast(id,patch)){id=notify(patch.message,patch.type,0);updateToast(id,patch);}
  if(terminal){lastTerminal=key;if(value.state==='applied'){const previous=id;dismissTimer=setTimeout(()=>{dismiss(previous);if(id===previous)id=null;},3000);}}
 }
 async function poll(){
  const current=generation;try{const value=await api('changes/status');if(active && current===generation && (!state.value || value.instance!==state.value.instance || value.revision>=state.value.revision))state.value=value;}
  catch{/* Keep the pending notice during a temporary connection failure. */}
  finally{if(active && current===generation)pollTimer=setTimeout(poll,500);}
 }
 watch(state,value=>{if(!active || !value)return;if(value.state==='idle'){if(id)dismiss(id);id=null;lastState='';return;}show(value);});
 watch(locale,()=>{if(active && id && state.value)updateToast(id,{message:message(state.value)});});
 watch(user,value=>{
  active=!!value;generation++;clearTimeout(pollTimer);clearTimeout(dismissTimer);if(id)dismiss(id);id=null;lastTerminal='';lastState='';
  if(active)poll();
 },{immediate:true});
 onUnmounted(()=>{active=false;generation++;clearTimeout(pollTimer);clearTimeout(dismissTimer);if(id)dismiss(id);});
}
