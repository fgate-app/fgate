import {startGatewayTunnel} from './gateway-tunnel.js';
import {ensureOutlineDpi} from './network-helper.js';
import {createHash} from 'node:crypto';
import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import {spawnSync} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {XraySupervisor,unusedPort} from './xray.js';
import {normalizeSsProfile,outlineBinary} from './ss-profile.js';

// Reuse the existing managed child lifecycle: readiness, restart backoff,
// private configs, prepare/commit/rollback and cleanup.
export class SsRelaySupervisor extends XraySupervisor {
 constructor({stateDir=process.env.FREEDOMGATE_STATE_DIR || '/var/lib/freedomgate',resolve=lookup,ensureDpi=ensureOutlineDpi}={}){super({binary:outlineBinary(),stateDir,resolve});this.dir=join(stateDir,'ss-relay');this.logName='ss-relay.log';this.ensureDpi=ensureDpi;this.available=spawnSync(this.binary,['--version'],{timeout:5000,stdio:'ignore'}).status===0;}
 status(){return this.available?super.status():{state:'unavailable',running:0,ready:0};}
 command(entry){return [entry.path];}
 async ready(entry){try{return await super.ready(entry);}catch{throw new Error("Outline SDK did not open its local connection port.");}}
 async stopEntry(entry){await super.stopEntry(entry);await entry.tunnel?.stop();}
 async prepare(configs){
  const next=new Map(),created=[];
  try{
   for(const row of configs.filter(row=>row.engine==='outline')){
    if(!this.available)throw new Error("Outline SDK: The module is not installed.");
    const dpiBypass=!row.wrapEndpoint && (row.dpiBypass===true || row.dpiBypass===1);
    const node=normalizeSsProfile(row.config),hash=createHash('sha256').update(row.config+'\0'+dpiBypass+'\0'+JSON.stringify(row.wrapEndpoint || null)).digest('hex');
    if(dpiBypass){const result=await this.ensureDpi();if(!result?.ok)throw new Error('Outline SDK: '+(result?.error || "Failed to apply DPI bypass."));}
    node.dpi_bypass=dpiBypass;
    let entry=this.entries.get(row.profile_id);
    if(!entry || entry.hash!==hash || !entry.process){
     let address=node.server;
     if(!isIP(address) && !row.wrapEndpoint?.remoteDns){
      let timer;
      const addresses=await Promise.race([this.resolve(address,{all:true}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error("Outline SDK: Bootstrap DNS is unavailable.")),5000);})]).finally(()=>clearTimeout(timer));
      address=(addresses.find(item=>item.family===4)||addresses[0])?.address;
      if(!isIP(address))throw new Error("Outline SDK: Bootstrap DNS is unavailable.");
     }
     node.server=address;
     const port=await unusedPort(),folder=join(this.dir,row.profile_id+'-'+hash.slice(0,12)+'-'+port);
     mkdirSync(folder,{recursive:true,mode:0o700});
     entry={id:row.profile_id,hash,port,folder,path:join(folder,'config.json'),address,process:null,timer:null,stopping:false,retries:0};created.push(entry);
     if(row.wrapEndpoint){entry.tunnel=await startGatewayTunnel({upstream:row.wrapEndpoint,target:{address,port:node.port}});node.server='127.0.0.1';node.port=entry.tunnel.port;}
     writeFileSync(entry.path,JSON.stringify({node,port}),{mode:0o600});
     this.start(entry);await this.ready(entry);
    }
    next.set(row.profile_id,entry);
   }
  }catch(error){await Promise.all(created.map(entry=>this.stopEntry(entry)));throw error;}
  let settled=false;
  return {bridges:Object.fromEntries([...next].map(([id,e])=>[id,{port:e.port,address:e.address,udp:true}])),
   commit:async()=>{if(settled)return;settled=true;const old=this.entries;this.entries=next;await Promise.all([...old.values()].filter(e=>next.get(e.id)!==e).map(e=>this.stopEntry(e)));},
   rollback:async()=>{if(settled)return;settled=true;await Promise.all(created.map(e=>this.stopEntry(e)));}};
 }
}
