import net from 'node:net';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {existsSync,mkdirSync,readFileSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {releaseModule} from '../release-modules.js';
import {unusedPort} from '../xray.js';
import {stopManagedProcess} from '../managed-process.js';
export const lanternLock=JSON.parse(readFileSync(new URL('../../packaging/lantern.lock.json',import.meta.url)));
export const lanternBinary=()=>join(releaseModule('lantern').root,'lantern-headless');
export function verifyLantern(binary,{platform=process.platform,arch=process.arch}={}){
 if(platform!=='linux' || !['arm64','x64'].includes(arch))throw Error('Lantern is supported on Linux ARM64 and AMD64.');
 let manifest;try{manifest=JSON.parse(readFileSync(join(dirname(binary),'manifest.json'),'utf8'));}catch{throw Error('Install the FreedomGate proxy-only Lantern module first.');}
 const data=readFileSync(binary),machine=data.length>=20?data.readUInt16LE(18):0;
 if(data.subarray(0,4).toString('hex')!=='7f454c46' || data[4]!==2 || data[5]!==1 || machine!==(arch==='arm64'?183:62) || manifest.platform!=='linux-'+(arch==='x64'?'amd64':arch))throw Error('The Lantern module has an incompatible architecture.');
 if(manifest.routing!=='proxy-only' || manifest.transport!=='http-connect' || manifest.version!==lanternLock.version || createHash('sha256').update(data).digest('hex')!==manifest.binarySha256)throw Error('The Lantern module does not have a verified proxy-only routing adapter.');
 return manifest;
}
export async function lanternUplink(){
 try{
  const {stdout}=await promisify(execFile)('ip',['-j','route','show','table','main','default'],{timeout:3000,maxBuffer:65536});
  const routes=JSON.parse(stdout).filter(row=>typeof row.dev==='string' && row.dev!=='lo' && row.type!=='unreachable').sort((a,b)=>(a.metric || 0)-(b.metric || 0));
  if(routes.length)return routes[0].dev;
 }catch{}
 throw Error('Lantern uplink interface is unavailable.');
}
export class LanternGateway{
 constructor({id,stateDir,binary=lanternBinary(),spawnProcess=spawn,verify=verifyLantern,resolveInterface=lanternUplink,wrapEndpoint=null}={}){Object.assign(this,{id,dir:join(stateDir,'lantern','data'),binary,spawnProcess,verify,resolveInterface,wrapEndpoint});this.state='stopped';this.sockets=new Set();this.child=null;this.gate=null;this.startedAt=null;this.stopped=false;}
 snapshot(){return {state:this.state,startedAt:this.startedAt,mode:'proxy-only',udp:false};}
 async start({deferLaunch=false}={}){
  this.verify(this.binary);this.interfaceName=this.wrapEndpoint?'':await this.resolveInterface();mkdirSync(this.dir,{recursive:true,mode:0o700});const upstreamPort=await unusedPort();this.upstreamPort=upstreamPort;
  this.gate=net.createServer(client=>{
   if(this.state!=='running' || this.stopped){client.destroy();return;}
   const upstream=net.connect(upstreamPort,'127.0.0.1');this.sockets.add(client);this.sockets.add(upstream);
   const close=()=>{client.destroy();upstream.destroy();this.sockets.delete(client);this.sockets.delete(upstream);};client.on('error',close);upstream.on('error',close);client.on('close',close);upstream.on('close',close);upstream.pipe(client);client.pipe(upstream);
  });
  await new Promise((resolve,reject)=>{this.gate.once('error',reject);this.gate.listen(0,'127.0.0.1',resolve);});this.port=this.gate.address().port;this.state='connecting';this.startedAt=new Date().toISOString();
  if(!deferLaunch)this.activate();return this;
 }
 activate(){
  if(this.child || this.stopped)return;
  const fail=()=>{if(!this.stopped)this.state='error';this.drop();};
  let buffer='';try{this.child=this.spawnProcess(this.binary,['--data-path',this.dir,'--raw','start','--http-proxy-addr','127.0.0.1:'+this.upstreamPort,'--socks-proxy-addr','127.0.0.1:0'],{stdio:['ignore','pipe','pipe'],env:{...process.env,FG_LANTERN_INTERFACE:this.interfaceName,FG_LANTERN_UPSTREAM:this.wrapEndpoint?JSON.stringify({port:this.wrapEndpoint.port,username:this.wrapEndpoint.username,password:this.wrapEndpoint.password}):''}});}catch{fail();return;}
  this.child.once('error',fail);this.child.once('exit',fail);this.child.stderr.resume();
  this.child.stdout.on('data',data=>{buffer=(buffer+data.toString()).slice(-8192);if(!this.stopped && this.child.exitCode==null && this.child.signalCode==null && buffer.includes('Proxy is ready to receive connections'))this.state='running';});
 }
 drop(){for(const socket of this.sockets)socket.destroy();this.sockets.clear();}
 async stop(){this.stopped=true;this.state='stopped';this.drop();await stopManagedProcess(this.child);if(this.gate)await new Promise(resolve=>this.gate.close(resolve));}
}
export class LanternSupervisor{
 constructor({stateDir=process.env.FREEDOMGATE_STATE_DIR || '/var/lib/freedomgate',create=options=>new LanternGateway(options)}={}){Object.assign(this,{stateDir,create});this.entries=new Map();this.pending=false;}
 available(){const binary=lanternBinary();return existsSync(binary) && existsSync(join(dirname(binary),'manifest.json'));}
 status(){return Object.fromEntries([...this.entries].map(([id,row])=>[id,row.snapshot()]));}
 async prepare(configs){
  if(this.pending)throw Error('A Lantern configuration update is already pending.');this.pending=true;const rows=configs.filter(row=>row.engine==='lantern'),created=[],next=new Map();
  try{if(rows.length>1)throw Error('Only one Lantern gateway is supported.');for(const config of rows){const key=JSON.stringify(config.wrapEndpoint || null);let row=this.entries.get(config.profile_id);if(!row || row.key!==key){if(this.entries.size && !this.entries.has(config.profile_id))throw Error('Stop the previous Lantern gateway before creating another one.');const stateDir=config.wrapEndpoint?join(this.stateDir,'lantern-runs',createHash('sha256').update(config.profile_id+'\0'+(config.wrapEndpoint.key || key)).digest('hex').slice(0,24)):this.stateDir;row=this.create({id:config.profile_id,stateDir,wrapEndpoint:config.wrapEndpoint || null});row.key=key;created.push(row);await row.start({deferLaunch:true});}next.set(config.profile_id,row);}}
  catch(error){await Promise.allSettled(created.map(row=>row.stop()));this.pending=false;throw error;}
  let settled=false;return {bridges:Object.fromEntries([...next].map(([id,row])=>[id,{address:'127.0.0.1',port:row.port,udp:false,type:'http'}])),commit:async()=>{if(settled)return;settled=true;try{const old=this.entries;this.entries=next;for(const row of created)row.activate?.();await Promise.all([...old].filter(([id,row])=>next.get(id)!==row).map(([,row])=>row.stop()));}finally{this.pending=false;}},rollback:async()=>{if(settled)return;settled=true;try{await Promise.all(created.map(row=>row.stop()));}finally{this.pending=false;}}};
 }
 async stop(){const entries=this.entries;this.entries=new Map();await Promise.all([...entries.values()].map(row=>row.stop()));}
}
export async function waitForLantern(row,{signal,onProgress=()=>{},timeoutMs=120000,pollMs=500}={}){
 const started=Date.now();
 while(row){
  if(signal?.aborted)throw Error('Diagnostic cancelled.');
  const value=row.snapshot();onProgress(value);
  if(value.state==='running')return {...value,outcome:'ok'};
  if(['error','stopped'].includes(value.state))return {...value,outcome:'failed'};
  if(Date.now()-started>=timeoutMs)return {...value,outcome:'unavailable',reason:'bootstrap-timeout'};
  await new Promise((resolve,reject)=>{const abort=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);reject(Error('Diagnostic cancelled.'));};const timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve();},pollMs);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();});
 }
 return {state:'unavailable',outcome:'failed'};
}
