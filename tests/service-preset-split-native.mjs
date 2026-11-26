import assert from 'node:assert/strict';
import http from 'node:http';import net from 'node:net';
import {spawn,execFile} from 'node:child_process';import {promisify} from 'node:util';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {groupRouteRules} from '../server/route-entries.js';
const execute=promisify(execFile),binary=process.env.FREEDOMGATE_MIHOMO_BINARY || '/opt/freedomgate/modules/mihomo/current/mihomo',folder=mkdtempSync(join(tmpdir(),'fg-service-split-native-'));
const origin=http.createServer((_req,res)=>res.end('fixture'));await new Promise(r=>origin.listen(0,'127.0.0.1',r));
const port=async()=>{const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const value=s.address().port;await new Promise(r=>s.close(r));return value;};
const service={entries:['vk.example','regexp:^app[0-9]{1,3}\\.other\\.example$'],exclusions:['ads.vk.example','full:telemetry.vk.example','regexp:^ads[0-9]{1,3}\\.vk\\.example$']},tracking={entries:service.exclusions};const results=[];const standardHosts=['vk.example','ads.vk.example','telemetry.vk.example','app1.other.example','ads1.vk.example','sub.ads.vk.example','sub.telemetry.vk.example'],idnHosts=['xn--80aswg.xn--p1ai','sub.xn--80aswg.xn--p1ai','xn--c1abqtis.xn--p1ai'];
try{
 for(const [name,group,expected,after=[],target='DIRECT',fallback='REJECT',names=standardHosts] of [
  ['unicode-domain',{entries:['сайт.рф']},[true,true,false],[],'DIRECT','REJECT',idnHosts],
  ['unicode-exact',{entries:['full:сайт.рф']},[true,false,false],[],'DIRECT','REJECT',idnHosts],
  ['unicode-wildcard',{entries:['*.сайт.рф']},[false,true,false],[],'DIRECT','REJECT',idnHosts],
  ['unicode-exclusion',{entries:['рф','exclude:сайт.рф']},[false,false,true],[],'DIRECT','REJECT',idnHosts],
  ['unicode-exact-exclusion',{entries:['рф','exclude:full:сайт.рф']},[false,true,true],[],'DIRECT','REJECT',idnHosts],
  ['service',{entries:service.entries,manualEntries:[],presets:[service]},[true,false,false,true,false,false,true]],
  ['tracking',{entries:tracking.entries,manualEntries:[],presets:[tracking]},[false,true,true,false,true,true,false]],
  ['both',{entries:[...service.entries,...tracking.entries],manualEntries:[],presets:[service,tracking]},[true,true,true,true,true,true,true]],
  ['manual',{entries:[...service.entries,'ads.vk.example'],manualEntries:['ads.vk.example'],presets:[service]},[true,true,false,true,false,true,true]],
  ['exclude-suffix',{entries:['vk.example'],manualEntries:['exclude:ads.vk.example'],presets:[{entries:['vk.example']}]},[true,false,true,false,true,false,true]],
  ['exclude-exact',{entries:['vk.example'],manualEntries:['exclude:full:ads.vk.example'],presets:[{entries:['vk.example']}]},[true,false,true,false,true,true,true]],
  ['exclude-manual-inclusion',{entries:['vk.example'],manualEntries:['ads.vk.example','exclude:ads.vk.example'],presets:[{entries:['vk.example']}]},[true,false,true,false,true,false,true]],
  ['exclude-tracking-preset',{entries:[...service.entries,...tracking.entries],manualEntries:['exclude:ads.vk.example'],presets:[service,tracking]},[true,false,true,true,true,false,true]],
  ['fallthrough-to-another-rule',{entries:['vk.example'],manualEntries:['exclude:ads.vk.example'],presets:[{entries:['vk.example']}]},[true,true,true,false,true,true,true],['DOMAIN-SUFFIX,ads.vk.example,DIRECT']],
  ['independent-block',{entries:['vk.example'],manualEntries:['exclude:ads.vk.example'],presets:[{entries:['vk.example']}]},[true,false,true,false,true,false,true],['DOMAIN-SUFFIX,ads.vk.example,REJECT']],
  ['block-with-local-exclusion',{entries:['vk.example'],manualEntries:['exclude:ads.vk.example'],presets:[{entries:['vk.example']}]},[false,true,false,true,false,true,false],[],'REJECT','DIRECT']
 ]){
  const proxyPort=await port(),config=join(folder,name+'.json');writeFileSync(config,JSON.stringify({port:proxyPort,'bind-address':'127.0.0.1',mode:'rule','log-level':'silent',ipv6:false,hosts:Object.fromEntries(names.map(name=>[name,'127.0.0.1'])),dns:{enable:false},rules:[...groupRouteRules(group,target),...after,'MATCH,'+fallback]}));
  await execute(binary,['-t','-d',folder,'-f',config],{timeout:10000});const child=spawn(binary,['-d',folder,'-f',config],{stdio:'ignore'});const closed=new Promise(r=>child.once('exit',r));
  try{
   let ready=false;for(let i=0;i<60;i++){ready=await new Promise(r=>{const s=net.connect(proxyPort,'127.0.0.1');s.once('connect',()=>{s.destroy();r(true)});s.once('error',()=>r(false));});if(ready)break;await new Promise(r=>setTimeout(r,50));}assert.ok(ready,'fixture listener starts');
   const statuses=[];for(const host of names){const {stdout}=await execute('curl',['-s','-o','/dev/null','-w','%{http_code}','--noproxy','','--proxy','http://127.0.0.1:'+proxyPort,'--max-time','3',`http://${host}:${origin.address().port}/`],{timeout:5000});statuses.push(Number(stdout));}
   assert.deepEqual(statuses.map(status=>status===200),expected,name+' matches only its intended traffic');results.push({name,statuses});
  }finally{child.kill('SIGTERM');await closed;}
 }
 console.log(JSON.stringify({passed:true,cases:results},null,2));
}finally{await new Promise(r=>origin.close(r));rmSync(folder,{recursive:true,force:true});}
