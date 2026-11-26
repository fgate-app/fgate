import {applyRoutesIfReady} from './route-runtime.js';

// Runtime-only override: diagnostics never persist an enabled flag or overwrite
// edits made while the measurement is running.
export async function diagnosticGatewaySession(store,supervisor,id,{signal}={}) {
 const profiles=store.profiles(),ids=new Set();let profile=profiles.find(row=>row.id===id);
 while(profile){if(ids.has(profile.id))throw Error('Gateway chain contains a cycle.');ids.add(profile.id);if(!profile.gatewayId)break;profile=profiles.find(row=>row.id===profile.gatewayId);if(!profile)throw Error('Gateway dependency is unavailable.');}
 const temporary=profiles.some(row=>ids.has(row.id) && row.enabled===false);
 let released=false,activated=false;
 const release=async()=>{
  if(released)return;released=true;
  if(activated){supervisor.diagnosticEnabledIds=null;await applyRoutesIfReady(store,supervisor);}
  supervisor.rememberDiagnosticLocation?.(id,store.profiles());
 };
 try{
  if(signal?.aborted)throw Error('Diagnostic cancelled.');
  if(temporary){activated=true;supervisor.diagnosticEnabledIds=ids;await applyRoutesIfReady(store,supervisor);}
  if(signal?.aborted)throw Error('Diagnostic cancelled.');
  return release;
 }catch(error){await release();throw error;}
}
