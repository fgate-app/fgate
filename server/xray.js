import {wrapXhttpStream,xhttpDownloadStream} from '../shared/xray-xhttp.js';
import {stopManagedProcess} from './managed-process.js';
import {moduleBinary} from './module-paths.js';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {lookup} from 'node:dns/promises';
import net from 'node:net';
import {existsSync,mkdirSync,writeFileSync,openSync,closeSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {normalizeXrayProfile} from './xray-profile.js';
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export async function unusedPort(){const server=net.createServer();await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;}
function listening(port){return new Promise(resolve=>{const socket=net.connect({host:'127.0.0.1',port,timeout:200});const done=ok=>{socket.destroy();resolve(ok);};socket.once('connect',()=>done(true));socket.once('error',()=>done(false));socket.once('timeout',()=>done(false));});}

export class XraySupervisor {
 constructor({binary=process.env.FREEDOMGATE_XRAY || moduleBinary('xray','xray','/opt/freedomgate/modules/xray/v26.10.31/xray'),stateDir=process.env.FREEDOMGATE_STATE_DIR || '/var/lib/freedomgate',resolve=lookup,diagnosticLog=null}={}){
  this.binary=binary;this.dir=join(stateDir,'xray');this.entries=new Map();this.resolve=resolve;this.diagnosticLog=diagnosticLog;
 }
 status(){return {state:!existsSync(this.binary)?'unavailable':[...this.entries.values()].some(entry=>!entry.process)?'error':this.entries.size?'running':'stopped',running:this.entries.size,ready:[...this.entries.values()].filter(entry=>entry.process).length};}
 async prepare(configs){
  const next=new Map(),created=[];
  try{
   for(const row of configs.filter(row=>row.engine==='xray')){
    const config=normalizeXrayProfile(row.config);
    const hash=createHash('sha256').update(JSON.stringify([config,row.wrapEndpoint || null])).digest('hex');
    let entry=this.entries.get(row.profile_id);
    if(!entry || entry.hash!==hash || !entry.process){
     if(!existsSync(this.binary))throw new Error("Xray-core is not installed.");
     const outbound=config.outbounds[0],peer=outbound.settings.vnext[0],download=xhttpDownloadStream(outbound.streamSettings);
     const peers=[{peer,stream:outbound.streamSettings},...(download?[{peer:download,stream:download}]:[])];
     for(const item of peers){
      const hostname=item.peer.address;
      if(net.isIP(hostname) || row.wrapEndpoint?.remoteDns)continue;
      let timer,address;
      try{const result=await Promise.race([this.resolve(hostname,{all:true}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error("Bootstrap DNS is unavailable.")),5000);})]);address=(result.find(item=>item.family===4) || result[0])?.address;}
      finally{clearTimeout(timer);}
      if(!net.isIP(address))throw new Error("Failed to resolve the VPN server address.");
      if(item.stream.security==='tls')item.stream.tlsSettings={...item.stream.tlsSettings,serverName:item.stream.tlsSettings?.serverName || hostname};
      item.peer.address=address;
     }
     const address=peer.address,addresses=peers.map(item=>item.peer.address);
     const port=await unusedPort(),folder=join(this.dir,row.profile_id+'-'+hash.slice(0,12)+'-'+port);
     mkdirSync(folder,{recursive:true,mode:0o700});
     entry={id:row.profile_id,hash,port,folder,path:join(folder,'config.json'),address,addresses,process:null,timer:null,stopping:false,retries:0};
     created.push(entry);
     if(row.wrapEndpoint)wrapXhttpStream(outbound.streamSettings,'gateway-wrapper');
     const managed={log:{loglevel:this.diagnosticLog?'info':'error'},inbounds:[{tag:'local',listen:'127.0.0.1',port,protocol:'socks',settings:{auth:'noauth',udp:true}}],outbounds:[{...outbound,tag:'vpn'},...(row.wrapEndpoint?[{tag:'gateway-wrapper',protocol:'socks',settings:{servers:[{address:'127.0.0.1',port:row.wrapEndpoint.port,users:[{user:row.wrapEndpoint.username,pass:row.wrapEndpoint.password}]}]}}]:[])],routing:{rules:[{type:'field',inboundTag:['local'],outboundTag:'vpn'}]}};
     writeFileSync(entry.path,JSON.stringify(managed),{mode:0o600});
     await this.validate(entry.path);this.start(entry);await this.ready(entry);
    }
    next.set(row.profile_id,entry);
   }
  }catch(error){await Promise.all(created.map(entry=>this.stopEntry(entry)));throw error;}
  let settled=false;
  return {
   bridges:Object.fromEntries([...next].map(([id,entry])=>[id,{port:entry.port,address:entry.address,addresses:entry.addresses}])),
   commit:async()=>{if(settled)return;settled=true;const previous=this.entries;this.entries=next;await Promise.all([...previous.values()].filter(entry=>next.get(entry.id)!==entry).map(entry=>this.stopEntry(entry)));},
   rollback:async()=>{if(settled)return;settled=true;await Promise.all(created.map(entry=>this.stopEntry(entry)));},
  };
 }
 validate(path){return new Promise((resolve,reject)=>{
  const child=spawn(this.binary,['run','-test','-config',path],{stdio:'ignore'});
  const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error("Xray validation timed out."));},15000);
  child.once('error',()=>{clearTimeout(timer);reject(new Error("Failed to start Xray."));});
  child.once('exit',code=>{clearTimeout(timer);code===0?resolve():reject(new Error("Xray rejected the connection configuration."));});
 });}
 command(entry){return ['run','-config',entry.path];}
 start(entry){
  let child;
  if(this.diagnosticLog){
   child=spawn(this.binary,this.command(entry),{stdio:['ignore','pipe','pipe']});
   child.stdout.on('data',this.diagnosticLog);child.stderr.on('data',this.diagnosticLog);
  }else{
   const fd=openSync(join(entry.folder,this.logName || 'xray.log'),'a',0o600);
   try{child=spawn(this.binary,this.command(entry),{stdio:['ignore',fd,fd]});}finally{closeSync(fd);}
  }
  entry.process=child;
  const exited=()=>{
   if(entry.process!==child)return;entry.process=null;
   this.scheduleRestart(entry);
  };
  child.once('exit',exited);child.once('error',exited);
 }
 scheduleRestart(entry){
  if(entry.stopping || this.entries.get(entry.id)!==entry)return;
  entry.timer=setTimeout(()=>{
   entry.timer=null;if(entry.stopping)return;
   try{this.start(entry);this.ready(entry).catch(()=>{});}
   catch{entry.process=null;this.scheduleRestart(entry);}
  },Math.min(30000,1000*2**Math.min(entry.retries++,5)));
  entry.timer.unref();
 }
 async ready(entry){for(let n=0;n<80;n++){if(!entry.process || entry.process.exitCode!==null)break;if(await listening(entry.port))return;await wait(100);}throw new Error("Xray did not open its local connection port.");}
 async stopEntry(entry){
  entry.stopping=true;clearTimeout(entry.timer);const child=entry.process;entry.process=null;
  await stopManagedProcess(child,{timeout:2000});
  rmSync(entry.folder,{recursive:true,force:true});
 }
 async stop(){const entries=[...this.entries.values()];this.entries.clear();await Promise.all(entries.map(entry=>this.stopEntry(entry)));}
}
