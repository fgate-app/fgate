import {randomUUID} from 'node:crypto';
// One server-side quiet window across clients. Browser navigation cannot lose it.
export class InlineChanges {
 constructor(apply,{delay=5000}={}){this.instance=randomUUID();this.apply=apply;this.delay=delay;this.tail=Promise.resolve();this.value={revision:0,state:'idle',deadline:null,error:null};}
 status(){return {...this.value,instance:this.instance};}
 enqueue(action){const result=this.tail.then(action,action);this.tail=result.catch(()=>{});return result;}
 change(action){return this.enqueue(async()=>{
  const result=await action();
  clearTimeout(this.timer);
  this.value={revision:this.value.revision+1,state:'pending',deadline:Date.now()+this.delay,error:null};
  const revision=this.value.revision;
  this.timer=setTimeout(()=>{this.enqueue(()=>this.commit(revision));},this.delay);
  this.timer.unref?.();
  return result;
 });}
 async commit(revision){
  if(this.closed || revision!==this.value.revision || this.value.state!=='pending')return;
  this.value={...this.value,state:'applying',deadline:null};
  try{await this.apply();this.value={...this.value,state:'applied',error:null};}
  catch(error){this.value={...this.value,state:'error',error:error.message || "Could not apply changes."};}
 }
 close(){this.closed=true;clearTimeout(this.timer);}
}
