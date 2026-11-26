// Runs in a separate systemd unit so restarting the application/helper cannot
// terminate the update. No user-provided commands or repository URLs are used.
import {readFile,writeFile,rename,rm,mkdir,cp} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {createResourceFetch} from './resource-fetch.js';
import {installerProgress,componentProgress} from './system-update-progress.js';
import {startInstallerNetwork} from './installer-network.js';
import {sourceCommit} from './system-updates.js';
const exec=promisify(execFile);
export async function runSystemUpdate({work,execute=exec,healthFetch=fetch,release='/opt/freedomgate/current',prepare=true,transaction=new URL('../scripts/install-transaction.py',import.meta.url).pathname}={}){
const state=dirname(work),source=join(work,'source');
async function set(patch){const row=JSON.parse(await readFile(join(state,'system.json'),'utf8'));if(patch.module){const {id,...detail}=patch.module;const previous=row.components?.[id]||{};if(detail.progress!==undefined)detail.progress=Math.max(previous.progress||0,detail.progress);if(previous.stage==='reuse'&&previous.progress===100&&detail.stage==='complete')detail.stage='reuse';patch={components:{...row.components,[id]:{startedAt:previous.startedAt||Date.now(),...previous,...detail,state:(detail.progress??previous.progress)===100?'complete':'installing'}}};}const file=join(state,'system.worker.next');await writeFile(file,JSON.stringify({...row,...patch}),{mode:0o644});await rename(file,join(state,'system.json'));}
let backup,network,progressWrites=Promise.resolve();
function progress(line){const module=componentProgress(line);if(module){progressWrites=progressWrites.then(()=>set({module})).catch(()=>{});return;}const patch=installerProgress(line);if(patch)progressWrites=progressWrites.then(()=>set(patch)).catch(()=>{});else if(/^FG_UPDATE_ACTION (reuse|download|build)$/.test(line))progressWrites=progressWrites.then(()=>set({action:line.split(' ')[1]})).catch(()=>{});}
try{
 const job=JSON.parse(await readFile(join(work,'job.json'),'utf8'));sourceCommit(job.commit);
 const result=await execute('python3',[transaction,'snapshot'],{timeout:30000});backup=result.stdout.trim();
 await set({state:'installing',backup,error:null});
 if(prepare)await prepareSystemModules({source,release,execute,gateways:job.gateways||[],progress:async patch=>{await set(patch);}});
 await writeFile(join(source,'system-release.json'),JSON.stringify({commit:job.commit,installedAt:new Date().toISOString()}),{mode:0o644});
 // The native installer creates its own state backup and rollback transaction.
 network=await startInstallerNetwork({gateways:job.gateways||[]});
 const pending=execute('sh',[join(source,'install.sh')],{cwd:source,timeout:45*60*1000,maxBuffer:8*1024*1024,env:{...process.env,...network.environment,DEBIAN_FRONTEND:'noninteractive',FREEDOMGATE_REUSE_RELEASE:release,FREEDOMGATE_RESOURCE_JOB:join(work,'job.json'),FREEDOMGATE_RESOURCE_NODE:process.execPath,FREEDOMGATE_RESOURCE_SCRIPT:new URL('../scripts/fetch-update-resource.mjs',import.meta.url).pathname}});
 let pendingLine='';pending.child?.stdout?.on('data',chunk=>{pendingLine+=chunk.toString();let end;while((end=pendingLine.indexOf('\n'))>=0){progress(pendingLine.slice(0,end).trim());pendingLine=pendingLine.slice(end+1);}if(pendingLine.length>8192)pendingLine='';});
 const installation=await pending;await progressWrites;
 await writeFile(join(backup,'web-update.log'),installation.stdout+'\n'+installation.stderr,{mode:0o600});
 await set({state:'restarting',stage:'health',progress:98,stageStartedAt:Date.now()});
 const response=await healthFetch('http://127.0.0.1/api/health',{signal:AbortSignal.timeout(10000)});
 if(!response.ok||!(await response.json()).ready)throw Error('Readiness failed');
 await writeFile(join(release,'system-release.json'),JSON.stringify({commit:job.commit,installedAt:new Date().toISOString()}),{mode:0o644});
 await set({state:'updated',stage:'complete',progress:100,installedVersion:job.commit,updatedAt:Date.now(),error:null,work:null});
}catch(error){
 await progressWrites.catch(()=>{});
 if(backup)await writeFile(join(backup,'web-update.log'),String(error.stdout||'')+'\n'+String(error.stderr||error.message||'Update failed'),{mode:0o600}).catch(()=>{});
 let rollback=true;
 if(backup)try{await execute('python3',[transaction,'restore',backup,'--restart'],{timeout:180000});}catch{rollback=false;}
 await set({state:'error',error:['Tor download requires a working gateway.','Could not download Tor directly or through the available gateways.'].includes(error.message)?error.message:rollback?'System update failed. The previous application version has been restored.':'System update failed. Could not restore freedomgate.service. Check the system journal.',work:null});
}finally{await network?.close();await rm(work,{recursive:true,force:true});}

}

export async function prepareSystemModules({source,release,execute=exec,gateways=[],progress=async()=>{},fetchImpl}={}){
 const platform='linux-'+(process.arch==='x64'?'amd64':process.arch);
 await progress({stage:'cache',progress:6,stageStartedAt:Date.now(),action:null});
 const copied=await execute('python3',[new URL('../scripts/reuse-release-modules.py',import.meta.url).pathname,'--source',release,'--target',source,'--platform',platform],{timeout:120000});
 try{for(const id of JSON.parse(copied.stdout).reused||[])await progress({module:{id:id.startsWith('frp-')?'frp':id,stage:'reuse',progress:100}});}catch{}
 const lock=JSON.parse(await readFile(join(source,'packaging/tor.lock.json'),'utf8'));const folder=join(source,'server/tor/bin',platform,lock.version);
 if(existsSync(join(folder,'tor/tor')))return;
 await progress({stage:'torDownload',progress:7,stageStartedAt:Date.now(),action:'download'});
 await progress({module:{id:'tor',stage:'downloading',progress:20}});
 const asset=lock.platforms[platform],get=fetchImpl||createResourceFetch({gateways:()=>gateways});
 let response;try{response=await get(lock.source+asset.asset,{timeoutMs:120000,signal:AbortSignal.timeout(180000),validate:bytes=>{if(createHash('sha256').update(bytes).digest('hex')!==asset.sha256)throw Error('Tor checksum mismatch');}});}catch{throw Error('Could not download Tor directly or through the available gateways.');}
 await progress({module:{id:'tor',downloadPath:response.downloadPath==='direct'?'direct':'gateway',stage:'verifying',progress:60}});
 const bytes=Buffer.from(await response.arrayBuffer());if(createHash('sha256').update(bytes).digest('hex')!==asset.sha256)throw Error('Tor checksum mismatch');
 const cache=join(source,'.update-tor');await mkdir(join(cache,'tor',lock.version),{recursive:true});await writeFile(join(cache,'tor',lock.version,'bundle.tar.gz'),bytes,{mode:0o600});
 await execute('python3',[join(source,'scripts/fetch-tor.py'),'--platform',platform,'--output',cache],{timeout:120000});
 await mkdir(join(source,'server/tor/bin',platform),{recursive:true});await cp(join(cache,'tor',lock.version),folder,{recursive:true});
}
