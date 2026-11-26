import {PublicError,publicErrorMessage} from './public-error.js';
import {readFileSync,existsSync} from 'node:fs';
import {mkdir,writeFile,rename,readlink,symlink,rm,readdir,chmod,stat,chown,mkdtemp,readFile} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {installedModuleVersions} from './module-paths.js';
const exec=promisify(execFile);
const lock=JSON.parse(readFileSync(new URL('../packaging/modules.lock.json',import.meta.url),'utf8'));
const fallback=Object.fromEntries(lock.modules.map(m=>[m.id,m.version]));
fallback.zapret=lock.sourceModules.find(m=>m.id==='zapret2').commit.slice(0,7);
fallback.frp=JSON.parse(readFileSync(new URL('./access-points/assets.json',import.meta.url),'utf8')).version;
export const updateSources={mihomo:'MetaCubeX/mihomo',xray:'XTLS/Xray-core',adguard:'AdguardTeam/AdGuardHome',zapret:'bol-van/zapret2',frp:'fatedier/frp'};
const activeStates=['checking','downloading','verifying','installing','restarting'];
export function releaseAsset(id,release,arch='arm64'){
 const target={arm64:'arm64',x64:'amd64'}[arch];
 if(!target)throw new PublicError("Unsupported architecture.");
 const version=release?.tag_name;
 if(!/^v?\d+\.\d+[.\w-]*$/.test(version || '') || release.draft || release.prerelease)throw new PublicError("Invalid stable release.");
 const name={mihomo:`mihomo-linux-${target==='amd64'?'amd64-compatible':'arm64'}-${version}.gz`,xray:target==='amd64'?'Xray-linux-64.zip':'Xray-linux-arm64-v8a.zip',adguard:`AdGuardHome_linux_${target}.tar.gz`,zapret:`zapret2-${version}.tar.gz`,frp:`frp_${version.replace(/^v/,'')}_linux_${target}.tar.gz`}[id];
 const asset=release.assets?.find(a=>a.name===name);
 if(!asset || !/^sha256:[a-f0-9]{64}$/.test(asset.digest || '') || !(asset.size>0 && asset.size<=128*1024*1024))throw new PublicError("No compatible archive with SHA-256 is available.");
 const url=`https://github.com/${updateSources[id]}/releases/download/${encodeURIComponent(version)}/${name}`;
 if(asset.browser_download_url!==url)throw new PublicError("Invalid update source.");
 return {version,url,sha256:asset.digest.slice(7),size:asset.size,platform:'linux-'+target};
}
async function copyPrivateConfig(source,destination){
 // copyFile can require metadata privileges absent from the bounded root helper.
 // Copy bytes only; ownership and private permissions are set explicitly.
 await writeFile(destination,await readFile(source),{mode:0o600,flag:'wx'});
}
export async function restoreModuleConfig(backup,path){
 const owner=await stat(dirname(path)),temporary=path+'.restore-'+randomUUID();
 try{await copyPrivateConfig(backup,temporary);await chmod(temporary,0o600);await chown(temporary,owner.uid,owner.gid);await rename(temporary,path);}finally{await rm(temporary,{force:true});}
}
const moduleName=id=>({mihomo:'mihomo',xray:'Xray',adguard:'AdGuard Home',zapret:'zapret2',frp:'frp'}[id] || id);
function failure(status,message){return Object.assign(new PublicError(message),{status});}
export class ModuleUpdates {
 constructor({root='/opt/freedomgate/modules',state='/opt/freedomgate/module-updates',fetchImpl=fetch,healthFetch=fetch,execute=exec,install=null,restart=null,platform=process.platform,arch=process.arch}={}){
  Object.assign(this,{root,state,fetchImpl,healthFetch,execute,platform,arch});this.install=install || this.stage.bind(this);this.restart=restart || this.restartService.bind(this);this.rows={};this.task=null;this.interrupted=[];
  try{this.rows=JSON.parse(readFileSync(join(state,'status.json'),'utf8'));}catch{}
  for(const id of ['system','outline','tor','lantern'])delete this.rows[id];
  for(const row of Object.values(this.rows))if(activeStates.includes(row.state) || row.rollbackPending){this.interrupted.push(row);row.state='error';row.error="Update interrupted. Check the version and try again.";}
 }
 snapshot(){return Object.entries(updateSources).map(([id])=>({id,current:installedModuleVersions(fallback)[id],supported:this.platform==='linux' && ['arm64','x64'].includes(this.arch),...this.rows[id]}));}
 async recover(){
  for(const row of this.interrupted)if(row.id && Object.hasOwn(row,'previous')){
   if(row.id==='adguard' && row.configBackup && existsSync(row.configBackup))await restoreModuleConfig(row.configBackup,join(process.env.FREEDOMGATE_STATE_DIR || '/var/lib/freedomgate','adguard/AdGuardHome.yaml'));
   if(row.previous)await this.link(row.id,row.previous);else await rm(join(this.root,row.id,'current'),{force:true});
   if(row.configBackup)await rm(row.configBackup,{force:true});delete row.previous;delete row.configBackup;delete row.rollbackPending;
  }
  if(this.interrupted.length)await this.persist();
 }
 async persist(){await mkdir(this.state,{recursive:true,mode:0o755});const file=join(this.state,'status.next');await writeFile(file,JSON.stringify(this.rows),{mode:0o644});await rename(file,join(this.state,'status.json'));}
 async set(id,patch){this.rows[id]={...this.rows[id],id,...patch};await this.persist();}
 start(op,id,version){
  if(!['check','update'].includes(op))throw failure(400,"Unknown update operation.");
  if(id!==undefined && (typeof id!=='string' || !Object.hasOwn(updateSources,id)))throw failure(400,"This module is updated with the application.");
  if(op==='update' && !id)throw failure(400,"Select a module.");
  if(this.task)throw failure(409,"Wait for the current update to finish.");
  if(op==='update' && (this.platform!=='linux' || !['arm64','x64'].includes(this.arch)))throw failure(400,"Updates are supported on Linux ARM64 and x86-64.");
  if(op==='update' && (!this.rows[id]?.candidate || this.rows[id].candidate.version!==version || this.rows[id].candidate.platform!==('linux-'+{arm64:'arm64',x64:'amd64'}[this.arch]) || this.rows[id].state!=='available'))throw failure(409,"Check for module updates first.");
  const ids=id?[id]:Object.keys(updateSources);
  this.task=Promise.resolve().then(async()=>{
   for(const current of ids)try{if(op==='check')await this.check(current);else await this.update(current);}catch(error){await this.set(current,{state:'error',error:publicErrorMessage(error,"Could not update the module. The previous version has been preserved.")}).catch(()=>{});}
  }).finally(()=>{this.task=null;});
  return {ok:true,accepted:true};
 }
 async check(id){
  await this.set(id,{state:'checking',error:null,candidate:null});

  const response=await this.fetchImpl(`https://api.github.com/repos/${updateSources[id]}/releases/latest`,{headers:{'User-Agent':'FreedomGate','Accept':'application/vnd.github+json'},signal:AbortSignal.timeout(20000),redirect:'error',validate:bytes=>releaseAsset(id,JSON.parse(bytes.toString('utf8')),this.arch)});
  if(!response.ok)throw new PublicError("Could not check for updates.");
  const candidate=releaseAsset(id,await response.json(),this.arch),current=installedModuleVersions(fallback)[id];
  const normalized=v=>String(v).replace(/^v/,'');
  // A pinned source commit (zapret) cannot be compared to release tags.
  const a=normalized(candidate.version).split('.').map(Number),b=normalized(current).split('.').map(Number);
  const newer=!/^\d+\.\d+/.test(normalized(current)) || a.some((value,i)=>value>(b[i]||0) && a.slice(0,i).every((n,j)=>n===(b[j]||0)));
  await this.set(id,{state:newer?'available':'current',candidate,checkedAt:Date.now()});
 }
 async download(candidate,path){
  const response=await this.fetchImpl(candidate.url,{headers:{'User-Agent':'FreedomGate'},signal:AbortSignal.timeout(120000),maxBytes:128*1024*1024,validate:bytes=>{if((candidate.size!==null && bytes.length!==candidate.size) || createHash('sha256').update(bytes).digest('hex')!==candidate.sha256)throw new PublicError('The update checksum does not match.');}});
  if(!response.ok)throw new PublicError("Could not download the update.");
  const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.length;if(size>128*1024*1024 || (candidate.size!==null && size>candidate.size))throw new PublicError("The update archive is too large.");chunks.push(chunk);}
  const bytes=Buffer.concat(chunks);
  if((candidate.size!==null && size!==candidate.size) || createHash('sha256').update(bytes).digest('hex')!==candidate.sha256)throw new PublicError("The update checksum does not match.");
  await writeFile(path,bytes,{mode:0o600});
 }
 async stage(id,candidate){
  await mkdir(this.root,{recursive:true,mode:0o755});await chmod(this.root,0o755);
  const dir=join(this.root,id);await mkdir(dir,{recursive:true,mode:0o755});await chmod(dir,0o755);
  const stage=join(dir,'.stage-'+randomUUID());await mkdir(stage,{mode:0o755});await chmod(stage,0o755);
  try{
   const archive=join(stage,'archive');await this.download(candidate,archive);await this.set(id,{state:'verifying'});
   await this.execute('python3',[new URL('../scripts/extract-module.py',import.meta.url).pathname,id,candidate.version,archive,stage,this.arch],{timeout:30000});await rm(archive);
   const [binary,args]={mihomo:['mihomo',['-v']],xray:['xray',['version']],adguard:['AdGuardHome',['--version']],zapret:['nfqws2',['--version']],frp:['frpc',['--version']]}[id];
   await this.execute(join(stage,binary),args,{timeout:10000});
   await this.validateConfig(id,join(stage,binary));
   await writeFile(join(stage,'manifest.json'),JSON.stringify({version:candidate.version,sha256:candidate.sha256}),{mode:0o644});
   await chmod(join(stage,'manifest.json'),0o644);
   const target=join(dir,candidate.version+'-'+randomUUID());await rename(stage,target);return target;
  }finally{await rm(stage,{force:true,recursive:true});}
 }
 async validateConfig(id,binary){
  const state=process.env.FREEDOMGATE_STATE_DIR || '/var/lib/freedomgate';
  const candidates={mihomo:[join(state,'mihomo/config.yaml'),p=>['-t','-d',join(state,'mihomo'),'-f',p]],adguard:[join(state,'adguard/AdGuardHome.yaml'),p=>['--check-config','-c',p]]};
  if(id==='xray')for(const entry of await readdir(join(state,'xray'),{withFileTypes:true}).catch(()=>[])){
   const path=join(state,'xray',entry.name,'config.json');if(entry.isDirectory() && existsSync(path))await this.execute(binary,['run','-test','-config',path],{timeout:20000});
  }
  if(id==='frp')for(const entry of await readdir(join(state,'access-runtime'),{withFileTypes:true}).catch(()=>[])){
   const path=join(state,'access-runtime',entry.name,'frpc.json');if(entry.isDirectory() && existsSync(path))await this.execute(binary,['verify','-c',path],{timeout:20000});
  }
  const pair=candidates[id];if(pair && existsSync(pair[0])){
   // Some validators migrate and atomically replace YAML, even with --check-config.
   // Validate only a private copy; never let a root validator rewrite live state.
   await mkdir(this.state,{recursive:true,mode:0o755});const work=await mkdtemp(join(this.state,'config-check-'));
   try{await chmod(work,0o700);const copy=join(work,'config.yaml');await copyPrivateConfig(pair[0],copy);await chmod(copy,0o600);await this.execute(binary,pair[1](copy),{timeout:20000});}finally{await rm(work,{recursive:true,force:true});}
  }
 }
 async link(id,target){const next=join(this.root,id,'current.next');await rm(next,{force:true});await symlink(target,next);await rename(next,join(this.root,id,'current'));}
 async update(id){
  const candidate=this.rows[id].candidate;await this.set(id,{state:'downloading',error:null});
  let previous=null,activated=false,configBackup=null,keepBackup=false;
  const configPath=id==='adguard'?join(process.env.FREEDOMGATE_STATE_DIR || '/var/lib/freedomgate','adguard/AdGuardHome.yaml'):null;
  try{
   const target=await this.install(id,candidate);previous=await readlink(join(this.root,id,'current')).catch(()=>null);
   if(configPath && existsSync(configPath)){configBackup=join(this.state,'config-'+randomUUID());await copyPrivateConfig(configPath,configBackup);await chmod(configBackup,0o600);}
   await this.set(id,{state:'installing',previous,configBackup});await this.link(id,target);activated=true;
   await this.set(id,{state:'restarting'});await this.restart(id);
   await this.set(id,{state:'updated',rollbackPending:undefined,configBackup:undefined,previous:undefined,installedVersion:candidate.version,updatedAt:Date.now(),error:null});
  }catch(error){
   if(activated)try{
    if(configBackup)await restoreModuleConfig(configBackup,configPath);if(previous)await this.link(id,previous);else await rm(join(this.root,id,'current'),{force:true});await this.restart(id);
   }catch{
    keepBackup=true;await this.set(id,{rollbackPending:true});throw new PublicError(`Could not restore freedomgate.service after updating ${moduleName(id)}.`);
   }
   await this.set(id,{previous:undefined,configBackup:undefined});
   throw error;
  }finally{if(configBackup && !keepBackup)await rm(configBackup,{force:true});}
 }
 async restartService(id){
  // Readiness is checked after systemd has started the service and its children.
  await this.execute('systemctl',['restart','freedomgate.service'],{timeout:120000});
  for(let n=0;n<60;n++){
   try{const response=await this.healthFetch('http://127.0.0.1/api/health',{signal:AbortSignal.timeout(1500)});if(response.ok && (await response.json()).ready){await this.execute('systemctl',['is-active','--quiet','freedomgate.service']);return;}}catch{}
   await new Promise(r=>setTimeout(r,500));
  }
  throw new PublicError(`Service freedomgate.service did not become ready after updating ${moduleName(id)}.`);
 }
}
