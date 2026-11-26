import {clientNetworks,logicalInterface} from '../shared/network.js';
import {execFile} from 'node:child_process';import {promisify} from 'node:util';
const execute=promisify(execFile);
// DHCP leases describe remembered clients, not presence. Only live station /
// neighbour evidence is used; unavailable probes must not mean "offline".
async function networkPresence(setup,{run=execute}={}){
 const iface=logicalInterface(setup?.client?.interface,setup?.client?.vlanId);if(!/^[a-zA-Z0-9_.:-]{1,15}$/.test(iface || ''))return null;
 try{
  if(setup.client.type==='ap'){
   const {stdout}=await run('iw',['dev',iface,'station','dump'],{timeout:2000,maxBuffer:256*1024});
   return {kind:'ap',online:new Set([...stdout.matchAll(/^Station ([0-9a-f:]{17})\b/gim)].map(m=>m[1].toLowerCase()))};
  }
  const {stdout}=await run('ip',['-j','neigh','show','dev',iface],{timeout:2000,maxBuffer:256*1024});
  const online=new Set(JSON.parse(stdout).filter(row=>(row.state || []).some(state=>['REACHABLE','DELAY','PROBE'].includes(state))).map(row=>String(row.lladdr || '').toLowerCase()));
  return {kind:'wired',online};
 }catch{return null;}
}
export async function clientPresence(setup,options={}) {
 if(!setup?.wired?.enabled) return networkPresence(setup,options);
 const results=await Promise.all(clientNetworks(setup).map(client=>networkPresence({client},options)));
 const valid=results.filter(Boolean);
 return valid.length?{kind:'mixed',online:new Set(valid.flatMap(result=>[...result.online]))}:null;
}
export function clientActivity(clients,presence,traffic){
 return clients.map(client=>({...client,
  online:presence?.online.has(client.mac.toLowerCase())?true:presence?.kind==='ap'?false:null,
  traffic:traffic?.available?(traffic.clients?.[client.mac.toLowerCase()] || {upload:0,download:0}):null,
 }));
}
