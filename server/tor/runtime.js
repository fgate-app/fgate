import net from 'node:net';
import {spawn} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync,existsSync,lstatSync,copyFileSync,chmodSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {releaseModule} from '../release-modules.js';
import {unusedPort} from '../xray.js';
import {stopManagedProcess} from '../managed-process.js';
import {normalizeTorSettings,torLabels} from '../../shared/tor.js';
const quote=value=>JSON.stringify(value);
export function torConfig({dir,bundle,mode,socksPort,controlPort,ownerPid=process.pid}){
 const rows=['ClientOnly 1','RunAsDaemon 0','AvoidDiskWrites 1','SafeLogging 1','Log notice stdout',`DataDirectory ${quote(join(dir,mode))}`,`SocksPort 127.0.0.1:${socksPort} IsolateSOCKSAuth`,`ControlPort 127.0.0.1:${controlPort}`,'CookieAuthentication 1',`CookieAuthFile ${quote(join(dir,'control.cookie'))}`,`__OwningControllerProcess ${ownerPid}`,'DormantCanceledByStartup 1','SafeSocks 0','ClientUseIPv6 1','ClientPreferIPv6ORPort 0',`GeoIPFile ${quote(join(bundle,'data/geoip'))}`,`GeoIPv6File ${quote(join(bundle,'data/geoip6'))}`];
 if(mode==='snowflake'){
  const config=JSON.parse(readFileSync(join(bundle,'tor/pluggable_transports/pt_config.json'),'utf8'));
  const bridges=config.bridges?.snowflake;
  if(!Array.isArray(bridges) || !bridges.length || bridges.some(line=>typeof line!=='string' || !line.startsWith('snowflake ') || /[\r\n]/.test(line)))throw Error('The Tor module has no valid Snowflake configuration.');
  const transport=join(bundle,'tor/pluggable_transports/lyrebird');if(/\s|["'\\]/.test(transport))throw Error('The Tor module path is not supported.');
  rows.push('UseBridges 1',`ClientTransportPlugin snowflake exec ${transport}`,...bridges.map(line=>'Bridge '+line));
 }else rows.push('UseBridges 0');
 return rows.join('\n')+'\n';
}
// Authenticate with the private per-gateway cookie. Never expose control replies or logs.
export function torInfo(port,cookie,{signal}={}){
 return new Promise((resolve,reject)=>{
  let socket,buffer='',finished=false;
  const done=(error,result)=>{if(finished)return;finished=true;signal?.removeEventListener('abort',abort);socket?.destroy();error?reject(error):resolve(result);};
  const abort=()=>done(Error('Tor check cancelled.'));
  try{const key=readFileSync(cookie);if(key.length!==32)throw Error();
   socket=net.connect({host:'127.0.0.1',port},()=>socket.write(`AUTHENTICATE ${key.toString('hex')}\r\nGETINFO status/bootstrap-phase status/circuit-established network-liveness\r\nQUIT\r\n`));
  }catch{return done(Error('Tor control is unavailable.'));}
  socket.setTimeout(2000,()=>done(Error('Tor control timed out.')));
  socket.on('error',()=>done(Error('Tor control is unavailable.')));
  socket.on('data',chunk=>{buffer+=chunk;if(buffer.length>16384)return done(Error('Invalid Tor control response.'));if(buffer.includes('status/circuit-established=') && buffer.includes('network-liveness=') && /250 OK\r\n/.test(buffer)){
   const progress=Number(/PROGRESS=(\d+)/.exec(buffer)?.[1] || 0),circuit=/status\/circuit-established=1/.test(buffer);
   done(null,{progress,ready:progress===100 && circuit,alive:progress===100 && /network-liveness=up/.test(buffer)});
  }});
  socket.on('end',()=>{if(!finished)done(Error('Tor control is unavailable.'));});
  signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
 });
}
export class TorGateway {
 constructor({id,settings,stateDir,bundle,spawnProcess=spawn,info=torInfo,pollMs=2000,port=unusedPort,clock=Date.now}={}){
  Object.assign(this,{id,settings:normalizeTorSettings(settings),dir:join(stateDir,'tor',id),bundle,spawnProcess,info,pollMs,allocatePort:port,clock});
  this.state='stopped';this.mode=null;this.progress=0;this.attempts=[];this.sockets=new Set();this.controller=new AbortController();this.child=null;this.gate=null;this.timer=null;this.wake=null;this.task=null;this.startedAt=null;this.sequence=0;
 }
 snapshot(){return {state:this.state,mode:this.mode,progress:this.progress,startedAt:this.startedAt,attempts:this.attempts.map(row=>({...row})),message:torLabels[this.state]};}
 drop(){for(const socket of this.sockets)socket.destroy();this.sockets.clear();}
 async start(){
  mkdirSync(this.dir,{recursive:true,mode:0o700});
  this.gate=net.createServer(client=>{
   if(this.state!=='ready' || !this.child || this.sockets.size>=256){client.destroy();return;}
   const upstream=net.connect({host:'127.0.0.1',port:this.socksPort});this.sockets.add(client);this.sockets.add(upstream);
   const close=()=>{client.destroy();upstream.destroy();this.sockets.delete(client);this.sockets.delete(upstream);};
   client.on('error',close);upstream.on('error',close);client.on('close',close);upstream.on('close',close);
   upstream.setTimeout(120000,close);client.pipe(upstream);upstream.pipe(client);
  });
  await new Promise((resolve,reject)=>{this.gate.once('error',reject);this.gate.listen(0,'127.0.0.1',resolve);});
  this.port=this.gate.address().port;
  this.task=this.run().catch(()=>{if(!this.controller.signal.aborted){this.state='failed';this.drop();}});
  return this;
 }
 sleep(ms){if(this.controller.signal.aborted)return Promise.resolve();return new Promise(resolve=>{this.wake=resolve;this.timer=setTimeout(()=>{this.timer=null;this.wake=null;resolve();},ms);this.timer.unref?.();});}
 async run(){
  let cycle=0;
  while(!this.controller.signal.aborted){
   for(const mode of this.settings.mode==='snowflake'?['snowflake']:['direct','snowflake']){
    if(this.controller.signal.aborted)break;
    const binary=join(this.bundle,'tor/tor');
    if(!existsSync(binary) || !existsSync(join(this.bundle,'tor/pluggable_transports/lyrebird'))){this.state='unavailable';return;}
    this.state='connecting';this.mode=mode;this.progress=0;this.startedAt=new Date(this.clock()).toISOString();
    const attempt={id:++this.sequence,mode,state:'running',startedAt:this.startedAt,progress:0};this.attempts.push(attempt);this.attempts=this.attempts.slice(-20);
    let wasReady=false;
    try{
     this.socksPort=await this.allocatePort();const controlPort=await this.allocatePort();
     const file=join(this.dir,'torrc');writeFileSync(file,torConfig({dir:this.dir,bundle:this.bundle,mode,socksPort:this.socksPort,controlPort}),{mode:0o600});
     const child=this.spawnProcess(binary,['-f',file],{cwd:this.bundle,env:{...process.env,LD_LIBRARY_PATH:join(this.bundle,'tor')},stdio:['ignore','pipe','pipe']});this.child=child;let exited=false;
     child.stdout.resume();child.stderr.resume();child.once('error',()=>{exited=true;});child.once('exit',()=>{exited=true;this.drop();if(this.state==='ready')this.state='connecting';});
     const bootstrapStarted=this.clock();let unhealthy=0;
     while(!this.controller.signal.aborted && !exited){
      let result=null;try{result=await this.info(controlPort,join(this.dir,'control.cookie'),{signal:this.controller.signal});}catch{}
      this.progress=Math.max(0,Math.min(100,result?.progress || 0));attempt.progress=this.progress;
      if(result?.ready || wasReady && result?.alive){this.state='ready';attempt.state='ok';wasReady=true;unhealthy=0;cycle=0;}
      else if(wasReady){this.drop();this.state='connecting';if(++unhealthy>=3)break;}
      else if(this.clock()>=bootstrapStarted+this.settings.connectTimeout*1000)break;
      await this.sleep(this.pollMs);
     }
     attempt.state=this.controller.signal.aborted?'cancelled':wasReady?'disconnected':'failed';attempt.reason=this.controller.signal.aborted?'cancelled':exited?'process-exited':wasReady?'connection-lost':'bootstrap-timeout';
    }catch{attempt.state='failed';attempt.reason='startup-failed';}
    finally{attempt.finishedAt=new Date(this.clock()).toISOString();this.state=this.controller.signal.aborted?'stopped':'connecting';this.drop();const child=this.child;this.child=null;await stopManagedProcess(child);}
    // Preserve a healthy Snowflake session. Only a lost connection reaches here.
    if(wasReady)break;
   }
   if(this.controller.signal.aborted)break;
   if(cycle++>=this.settings.retries){this.state='failed';return;}
   this.state='waiting';await this.sleep(this.settings.retryDelay*1000);
  }
 }
 async stop(){this.controller.abort();clearTimeout(this.timer);this.wake?.();this.state='stopped';this.drop();await stopManagedProcess(this.child);await this.task;if(this.gate)await new Promise(resolve=>this.gate.close(resolve));}
}
// Only Tor-owned reusable state is seeded; locks, sockets and control cookies stay private to each run.
const cacheFiles=['state','cached-certs','cached-consensus','cached-microdesc-consensus','cached-microdescs','cached-descriptors'];
export function seedTorCache(source,target,id){
 if(existsSync(target) || !existsSync(source))return;
 mkdirSync(target,{recursive:true,mode:0o700});
 for(const mode of ['direct','snowflake']){
  const dest=join(target,'tor',id,mode);
  for(const name of cacheFiles){
   const path=join(source,'tor',id,mode,name);
   let stat;try{stat=lstatSync(path);}catch(error){if(error.code==='ENOENT')continue;throw error;}
   if(!stat.isFile())continue;
   mkdirSync(dest,{recursive:true,mode:0o700});copyFileSync(path,join(dest,name));chmodSync(join(dest,name),0o600);
  }
 }
}
export class TorSupervisor {
 constructor({stateDir=process.env.FREEDOMGATE_STATE_DIR || '/var/lib/freedomgate',bundle=releaseModule('tor').root,create=options=>new TorGateway(options)}={}){Object.assign(this,{stateDir,bundle,create});this.entries=new Map();this.pending=false;}
 status(){return Object.fromEntries([...this.entries].map(([id,row])=>[id,row.snapshot()]));}
 async prepare(configs){
  if(this.pending)throw Error('A Tor configuration update is already pending.');
  this.pending=true;
  const next=new Map(),created=[],updates=[];
  try{for(const config of configs.filter(row=>row.engine==='tor')){
   const settings=normalizeTorSettings(JSON.parse(config.config)),key=JSON.stringify(settings);let row=this.entries.get(config.profile_id);
   const oldMode=row?normalizeTorSettings(JSON.parse(row.key)).mode:null;
   const reusable=row && oldMode===settings.mode && !['failed','unavailable','stopped'].includes(row.snapshot().state);
   if(row && row.key!==key && reusable)updates.push({row,settings,key});
   else if(!row || row.key!==key){
    const hash=value=>createHash('sha256').update(value).digest('hex').slice(0,24);
    const stateDir=join(this.stateDir,'tor-runs',hash(config.profile_id+'\0'+settings.mode));
    seedTorCache(join(this.stateDir,'tor-runs',hash(config.profile_id+key)),stateDir,config.profile_id);
    row=this.create({id:config.profile_id,settings,stateDir,bundle:this.bundle});row.key=key;created.push(row);await row.start();
   }
   next.set(config.profile_id,row);
  }}catch(error){await Promise.allSettled(created.map(row=>Promise.resolve().then(()=>row.stop())));this.pending=false;throw error;}
  let settled=false;
  return {bridges:Object.fromEntries([...next].map(([id,row])=>[id,{port:row.port,address:'127.0.0.1',udp:false}])),commit:async()=>{if(settled)return;settled=true;try{for(const {row,settings,key}of updates){row.settings=settings;row.key=key;}const old=this.entries;this.entries=next;await Promise.all([...old].filter(([id,row])=>next.get(id)!==row).map(([,row])=>row.stop()));}finally{this.pending=false;}},rollback:async()=>{if(settled)return;settled=true;try{await Promise.all(created.map(row=>row.stop()));}finally{this.pending=false;}}};
 }
 async stop(){const entries=this.entries;this.entries=new Map();await Promise.all([...entries.values()].map(row=>row.stop()));}
}

export async function waitForTor(row,{signal,onProgress=()=>{},timeoutMs=300000,pollMs=500}={}){
 const started=Date.now();
 while(row){
  if(signal?.aborted)throw Error('Diagnostic cancelled.');
  const value=row.snapshot();onProgress(value);
  if(value.state==='ready')return {...value,outcome:'ok'};
  if(['failed','unavailable','stopped'].includes(value.state))return {...value,outcome:'failed'};
  if(Date.now()-started>=timeoutMs)return {...value,outcome:'unavailable',reason:'diagnostic-timeout'};
  await new Promise((resolve,reject)=>{let timer;const abort=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);reject(Error('Diagnostic cancelled.'));};timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve();},pollMs);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();});
 }
 return {state:'unavailable',outcome:'unavailable',attempts:[],message:'Tor is stopped.'};
}
