import {clientPresence} from './client-status.js';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const execute=promisify(execFile);
export function createDashboardTraffic(request,{now=Date.now,cacheMs=1000,profiles=()=>[]}={}){
 let previous=null,pending=null,cached=null,sampled=0;
 let flows=new Map();const totals=new Map();
 return async()=>{
  if(cached && now()-sampled<cacheMs)return cached;if(pending)return pending;
  pending=(async()=>{try{
   const snapshot=await request('/connections'),time=now();
   const upload=Number(snapshot.uploadTotal),download=Number(snapshot.downloadTotal);
   if(!Number.isFinite(upload)||!Number.isFinite(download)||upload<0||download<0||!Array.isArray(snapshot.connections))throw Error('Invalid counters');
   const gateways=profiles().filter(profile=>profile.enabled!==false && profile.engine!=='direct');
   const tags=new Map(gateways.map(profile=>['p-'+profile.id.slice(0,8),profile]));
   const current=new Map();
   for(const flow of snapshot.connections){
    const profile=(flow.chains || []).map(tag=>tags.get(tag)).find(Boolean);
    if(!profile || !flow.id)continue;
    const old=flows.get(flow.id),upload=Math.max(0,Number(flow.upload)||0),download=Math.max(0,Number(flow.download)||0);
    const total=totals.get(profile.id) || {upload:0,download:0};
    total.upload+=Math.max(0,upload-(old?.profile===profile.id?old.upload:0));
    total.download+=Math.max(0,download-(old?.profile===profile.id?old.download:0));
    totals.set(profile.id,total);current.set(flow.id,{profile:profile.id,upload,download});
   }
   flows=current;
   const topProxies=gateways.map(profile=>({id:profile.id,name:profile.name,...(totals.get(profile.id) || {upload:0,download:0})})).filter(item=>item.upload+item.download>0).sort((a,b)=>(b.upload+b.download)-(a.upload+a.download)).slice(0,5);
   const interval=previous?(time-previous.time)/1000:0;
   const valid=previous && interval>0 && upload>=previous.upload && download>=previous.download;
   cached={available:true,topProxies,uploadTotal:upload,downloadTotal:download,uploadRate:valid?(upload-previous.upload)/interval:null,downloadRate:valid?(download-previous.download)/interval:null,connections:snapshot.connections.length};
   previous={upload,download,time};sampled=time;return cached;
  }catch{previous=null;sampled=now();return cached={available:false,topProxies:[],uploadRate:null,downloadRate:null,uploadTotal:null,downloadTotal:null,connections:null};}})().finally(()=>pending=null);
  return pending;
 };
}
export async function connectedDeviceCount(setup,{run=execute}={}){
 if(setup?.wired?.enabled) {const presence=await clientPresence(setup,{run});return presence?presence.online.size:null;}
 const iface=setup?.client?.interface;if(!/^[a-zA-Z0-9_.:-]{1,15}$/.test(iface || ''))return null;
 try{
  if(setup.client.type==='ap'){
   const {stdout}=await run('iw',['dev',iface,'station','dump'],{timeout:2000,maxBuffer:256*1024});
   return new Set([...stdout.matchAll(/^Station ([0-9a-f:]{17})\b/gim)].map(match=>match[1].toLowerCase())).size;
  }
  return null;
 }catch{return null;}
}
