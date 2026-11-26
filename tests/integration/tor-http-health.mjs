// Run as the unprivileged service user. Uses separate loopback ports; never enables TUN.
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {spawn} from 'node:child_process';
import {TorGateway} from '../../server/tor/runtime.js';
import {buildMihomoConfig} from '../../server/mihomo.js';
import {defaultDnsSettings} from '../../server/dns-resolvers.js';
import {createHttpHealth} from '../../server/http-health.js';
import {unusedPort} from '../../server/xray.js';
import {stopManagedProcess} from '../../server/managed-process.js';
const dir=mkdtempSync(join(tmpdir(),'fg-tor-http-')),tor=new TorGateway({id:'health',stateDir:dir,bundle:process.env.FREEDOMGATE_TOR_BUNDLE,settings:{mode:'snowflake',connectTimeout:120,retries:0}});
const profile={id:'http-tor-fixture',engine:'tor',enabled:true},events=[];let child,health,calls=0;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
try{
 await tor.start();const controller=await unusedPort();
 const config=buildMihomoConfig(defaultDnsSettings,{mixedPort:await unusedPort(),dnsPort:await unusedPort(),controllerPort:controller,controllerSecret:'fixture'},{profiles:[profile],configs:[{profile_id:profile.id,engine:'tor',config:'{}'}],groups:[],devices:[],bridges:{[profile.id]:{port:tor.port,address:'127.0.0.1',udp:false}}}).replace('tun:\n  enable: true','tun:\n  enable: false');
 writeFileSync(join(dir,'config.yaml'),config,{mode:0o600});child=spawn(process.env.FREEDOMGATE_MIHOMO || '/opt/freedomgate/modules/mihomo/current/mihomo',['-d',dir,'-f',join(dir,'config.yaml')],{stdio:'ignore'});
 const request=async(path,options={})=>{const response=await fetch('http://127.0.0.1:'+controller+path,{headers:{Authorization:'Bearer fixture'},signal:AbortSignal.timeout(options.timeout || 2000)});if(!response.ok)throw Object.assign(Error('Controller check failed.'),{status:response.status});return response.json();};
 for(let n=0;n<100;n++){try{await request('/version');break;}catch{await sleep(100);}}
 health=createHttpHealth(async(...args)=>{calls++;return request(...args);},{transport:()=>({state:tor.state==='ready'?'ready':['failed','unavailable','stopped'].includes(tor.state)?'failed':'connecting',timeout:20000}),report:event=>events.push(event)});
 await health.start([profile]);assert.equal(calls,0);assert.equal(health.get(profile).httpStatus,'checking');
 for(let n=0;n<170;n++){await sleep(1000);if(n%15===0)console.log(JSON.stringify({state:tor.state,progress:tor.progress,http:health.get(profile).httpStatus}));if(health.get(profile).httpStatus==='ok')break;if(['failed','unavailable'].includes(tor.state))break;}
 assert.equal(health.get(profile).httpStatus,'ok');assert.ok(health.get(profile).ping>0);
 console.log(JSON.stringify({result:'ok',serviceUser:process.getuid(),bootstrap:tor.state,mode:tor.mode,httpStatus:health.get(profile).httpStatus,ping:health.get(profile).ping,endpoint:health.get(profile).httpEndpoint,requests:calls,failedEndpoints:events.filter(event=>event.failed).map(event=>event.endpoint)}));
}finally{health?.stop();await tor.stop();await stopManagedProcess(child);rmSync(dir,{recursive:true,force:true});}
