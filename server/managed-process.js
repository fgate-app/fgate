// Stop one owned child. Clear the escalation timer when it exits so an old
// timer cannot signal a completed process after the next configuration apply.
export function stopManagedProcess(child,{timeout=3000}={}) {
 if(!child || child.exitCode!=null || child.signalCode!=null)return Promise.resolve();
 return new Promise(resolve=>{
  let timer,settled=false;
  const finish=()=>{if(settled)return;settled=true;clearTimeout(timer);child.removeListener('exit',finish);child.removeListener('error',finish);resolve();};
  child.once('exit',finish);child.once('error',finish);
  timer=setTimeout(()=>{try{child.kill('SIGKILL');}catch{}finish();},timeout);
  try{child.kill('SIGTERM');}catch{finish();}
 });
}
