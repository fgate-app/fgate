import {METACUBE_REPOSITORY,METACUBE_BRANCH} from './metacube-catalog.js';
import {PublicError,publicErrorMessage} from './public-error.js';
// Domain catalogs are data, so they remain owned by the unprivileged service.
export class DomainListUpdates {
 constructor({current,update,fetchImpl=fetch,id='domain-lists',repository=METACUBE_REPOSITORY,branch=repository===METACUBE_REPOSITORY?METACUBE_BRANCH:'HEAD',details=()=>({})}){Object.assign(this,{current,update,fetchImpl,repository,branch,details});this.row={id,supported:true};this.task=null;}
 snapshot(){return {...this.details(),...this.row,current:this.current()?.slice(0,7) || '—'};}
 start(op,version){
  if(this.task)throw Object.assign(new PublicError("Wait for the current update to finish."),{status:409});
  if(op==='update' && (this.row.state!=='available' || version!==this.row.candidate?.version))throw Object.assign(new PublicError("Check for module updates first."),{status:409});
  this.row={...this.row,state:op==='check'?'checking':'downloading',error:null};
  this.task=(async()=>{
   if(op==='check'){
    const response=await this.fetchImpl(`https://api.github.com/repos/${this.repository}/commits/${this.branch}`,{headers:{'User-Agent':'FreedomGate'},signal:AbortSignal.timeout(20000),redirect:'error',maxBytes:1048576,validate:bytes=>{const data=JSON.parse(bytes.toString('utf8'));if(!/^[a-f0-9]{40}$/.test(data.sha || ''))throw new PublicError('Invalid stable release.');}});
    if(!response.ok)throw new PublicError("Could not check for updates.");
    const data=await response.json();if(!/^[a-f0-9]{40}$/.test(data.sha || ''))throw new PublicError("Invalid stable release.");
    this.row={...this.row,candidate:{version:data.sha},state:data.sha===this.current()?'current':'available'};
   }else{
    await this.update(this.row.candidate.version);this.row={...this.row,state:'updated'};
   }
  })().catch(error=>{this.row={...this.row,state:'error',error:publicErrorMessage(error,"Could not update the catalog.")};}).finally(()=>{this.task=null;});
  return {ok:true,accepted:true};
 }
}
