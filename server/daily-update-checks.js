import {mkdirSync,readFileSync,writeFileSync,renameSync} from 'node:fs';
import {dirname} from 'node:path';
export const updateCheckDay=24*60*60*1000;
// Runtime metadata, not portable configuration. Persist before I/O so a restart
// cannot repeatedly hammer update sources when a check is interrupted.
export class DailyUpdateChecks{
 constructor({path,check,canRun=()=>true,now=Date.now,interval=60000,retryMs=3600000,setTimer=setInterval,clearTimer=clearInterval}){
  Object.assign(this,{path,check,canRun,now,retryMs,clearTimer});this.stopped=false;this.running=false;this.nextAt=0;
  try{const value=JSON.parse(readFileSync(path,'utf8'));if(Number.isFinite(value.nextAt) && value.nextAt>0)this.nextAt=value.nextAt;}catch{}
  this.timer=setTimer(()=>{void this.tick();},interval);this.timer.unref?.();
 }
 save(nextAt){mkdirSync(dirname(this.path),{recursive:true,mode:0o700});const pending=this.path+'.pending';writeFileSync(pending,JSON.stringify({nextAt}),{mode:0o600});renameSync(pending,this.path);this.nextAt=nextAt;}
 async tick(){
  if(this.stopped || this.running)return false;
  this.running=true;
  try{
   const now=this.now();if(!this.canRun() || this.nextAt>now && this.nextAt<=now+updateCheckDay)return false;
   this.save(now+this.retryMs);
   const accepted=await this.check();if(!this.stopped)this.save(this.now()+(accepted===false?60000:updateCheckDay));return accepted!==false;
  }catch{console.warn('FreedomGate: Automatic update check could not complete.');return false;}
  finally{this.running=false;}
 }
 stop(){this.stopped=true;this.clearTimer(this.timer);}
}
