import test from 'node:test';import assert from 'node:assert/strict';
import {canReuseNetwork} from '../server/network-reuse.js';
const parsed={uplink:'eth0',client:'wlan0',clientType:'ap',subnet:'10.20.0.1/24',address:'10.20.0.1',prefix:24,dhcpStart:'10.20.0.100',dhcpEnd:'10.20.0.200'};
function fixture(){return {parsed,current:{...parsed,uplinkSubnet:'192.168.1.86/24'},apConfig:'AP settings',savedApConfig:'AP settings',daemonRunning:async()=>true,run:async(command,args)=>command==='sysctl'?'1':command==='nft'?'table':args.at(-1)==='eth0'?'2: eth0 inet 192.168.1.86/24 scope global eth0':'3: wlan0 inet 10.20.0.1/24 scope global wlan0'};}
test('unchanged live network survives config reload; changes or missing runtime require recovery',async()=>{
 assert.equal(await canReuseNetwork(fixture()),true);
 for(const mutate of [f=>f.current=null,f=>f.savedApConfig='old password',f=>f.parsed={...parsed,address:'10.21.0.1'},f=>f.daemonRunning=async()=>false,f=>f.run=async()=>{throw Error('missing nft table');},f=>f.run=async(cmd)=>cmd==='sysctl'?'0':'']){
  const f=fixture();mutate(f);assert.equal(await canReuseNetwork(f),false);
 }
 const wired=fixture();wired.parsed={...parsed,clientType:'ethernet'};wired.current={...wired.current,clientType:'ethernet'};wired.savedApConfig=null;assert.equal(await canReuseNetwork(wired),true);
});
