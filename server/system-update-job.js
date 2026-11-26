// Runs in a separate systemd unit so restarting the application/helper cannot
// terminate the update. No user-provided commands or repository URLs are used.
import {readFile,writeFile,rename,rm} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {sourceCommit} from './system-updates.js';
const exec=promisify(execFile);
export async function runSystemUpdate({work,execute=exec,healthFetch=fetch,release='/opt/freedomgate/current',transaction=new URL('../scripts/install-transaction.py',import.meta.url).pathname}={}){
const state=dirname(work),source=join(work,'source');
async function set(patch){const row=JSON.parse(await readFile(join(state,'system.json'),'utf8'));const file=join(state,'system.worker.next');await writeFile(file,JSON.stringify({...row,...patch}),{mode:0o644});await rename(file,join(state,'system.json'));}
let backup;
try{
 const job=JSON.parse(await readFile(join(work,'job.json'),'utf8'));sourceCommit(job.commit);
 const result=await execute('python3',[transaction,'snapshot'],{timeout:30000});backup=result.stdout.trim();
 await set({state:'installing',backup,error:null});
 await writeFile(join(source,'system-release.json'),JSON.stringify({commit:job.commit,installedAt:new Date().toISOString()}),{mode:0o644});
 // The native installer creates its own state backup and rollback transaction.
 const installation=await execute('sh',[join(source,'install.sh')],{cwd:source,timeout:45*60*1000,maxBuffer:8*1024*1024,env:{...process.env,DEBIAN_FRONTEND:'noninteractive'}});
 await writeFile(join(backup,'web-update.log'),installation.stdout+'\n'+installation.stderr,{mode:0o600});
 await set({state:'restarting'});
 const response=await healthFetch('http://127.0.0.1/api/health',{signal:AbortSignal.timeout(10000)});
 if(!response.ok||!(await response.json()).ready)throw Error('Readiness failed');
 await writeFile(join(release,'system-release.json'),JSON.stringify({commit:job.commit,installedAt:new Date().toISOString()}),{mode:0o644});
 await set({state:'updated',installedVersion:job.commit,updatedAt:Date.now(),error:null,work:null});
}catch(error){
 if(backup)await writeFile(join(backup,'web-update.log'),String(error.stdout||'')+'\n'+String(error.stderr||error.message||'Update failed'),{mode:0o600}).catch(()=>{});
 let rollback=true;
 if(backup)try{await execute('python3',[transaction,'restore',backup,'--restart'],{timeout:180000});}catch{rollback=false;}
 await set({state:'error',error:rollback?'System update failed. The previous application version has been restored.':'System update failed. Could not restore freedomgate.service. Check the system journal.',work:null});
}finally{await rm(work,{recursive:true,force:true});}

}
