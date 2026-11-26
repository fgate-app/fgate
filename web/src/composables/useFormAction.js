import {ref} from 'vue';
import {useFormFeedback} from './useFormFeedback.js';

export function useFormAction(){
 const pending=ref(false);
 const {reportError}=useFormFeedback();
 async function run(action){
  if(pending.value)return;
  pending.value=true;
  try{return await action();}
  catch(error){reportError(error);}
  finally{pending.value=false;}
 }
 return {pending,run};
}
