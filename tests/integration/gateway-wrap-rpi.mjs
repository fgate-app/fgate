// Run as an authorized administrator on the RPi; reads keys locally and never
// changes the production database, routes, firewall, or main gateway process.
import {DatabaseSync} from 'node:sqlite';
import {Store} from '../../server/store.js';
import {gatewayEditor} from '../../server/gateway-editor.js';
import {XraySupervisor,unusedPort} from '../../server/xray.js';
import {SsRelaySupervisor} from '../../server/ss-relay.js';
import {buildMihomoConfig} from '../../server/mihomo.js';
import {defaultDnsSettings} from '../../server/dns-resolvers.js';
import {probeUdp} from '../../server/udp-telemetry.js';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import net from 'node:net';
import assert from 'node:assert/strict';
const exec=promisify(execFile),folder=mkdtempSync(join(tmpdir(),'fg-wrap-lab-'));
const db=new DatabaseSync('/var/lib/freedomgate/freedomgate.sqlite',{readOnly:true}),store=new Store(':memory:');
const raw=name=>db.prepare('SELECT c.config FROM profile_configs c JOIN profiles p ON p.id=c.profile_id WHERE p.name=?').get(name).config;
const outer=store.importProfile({name:'Outer Amnezia',value:raw('Amnezia Xray')});
const inner=store.importProfile({name:'Nested Outline',value:raw('161 Бесконечная Уильямс')});
const nestedXray=store.importProfile({name:'Nested Xray',value:raw('Amnezia Xray')});
const editor=gatewayEditor(store.profileSnapshot(inner.id));editor.fields.server='173.211.31.246';
store.updateProfile(inner.id,{editor,gatewayId:outer.id,dpiBypass:true});
store.updateProfile(nestedXray.id,{gatewayId:outer.id});
const endpoint={port:await unusedPort(),username:'fg-wrap',password:'fixture-local-secret'};
const xray=new XraySupervisor({stateDir:folder,binary:'/opt/freedomgate/modules/xray/current/xray'}),ss=new SsRelaySupervisor({stateDir:folder,ensureDpi:async()=>{throw Error('Wrapped Outline must not install direct DPI rules');}});
const profiles=()=>store.profiles().filter(p=>!p.builtin),configs=store.db.prepare('SELECT * FROM profile_configs WHERE engine IN (\'xray\',\'outline\')').all();
const rows=configs.map(c=>({...c,dpiBypass:c.profile_id===inner.id,wrapEndpoint:c.profile_id===outer.id?undefined:endpoint}));
const binary='/opt/freedomgate/modules/mihomo/current/mihomo';
let child,xp,sp;const report={results:[],productionSettingsChanged:false};
const ports={mixedPort:await unusedPort(),dnsPort:await unusedPort(),controllerPort:await unusedPort(),wrapperEndpoints:new Map([[outer.id,endpoint]]),locationPorts:new Map()};
for(const p of profiles())ports.locationPorts.set(p.id,await unusedPort());
async function stopChild(){if(!child)return;const old=child;child=null;await new Promise(resolve=>{const timer=setTimeout(()=>{old.kill('SIGKILL');resolve();},2000);old.once('exit',()=>{clearTimeout(timer);resolve();});old.kill('SIGTERM');});}
async function startMihomo(){
 await stopChild();const path=join(folder,'mihomo.yaml');
 const yaml=buildMihomoConfig(defaultDnsSettings,ports,{profiles:profiles(),configs,groups:[],devices:[],bridges:{...xp.bridges,...sp.bridges}}).replace('tun:\n  enable: true','tun:\n  enable: false');
 writeFileSync(path,yaml,{mode:0o600});await exec(binary,['-t','-f',path]);
 child=spawn(binary,['-f',path],{stdio:'ignore'});
 for(let n=0;n<60;n++){
  if(child.exitCode!==null)throw Error('Isolated mihomo exited');
  const ready=await new Promise(resolve=>{const socket=net.connect(endpoint.port,'127.0.0.1');socket.on('error',()=>resolve(false));socket.on('connect',()=>{socket.destroy();resolve(true);});});
  if(ready)return;await new Promise(r=>setTimeout(r,100));
 }
 throw Error('Isolated mihomo listener unavailable');
}
async function https(label,port,expected=true){
 let result;
 try{const r=await exec('curl',['-sS','--proxy',`socks5h://127.0.0.1:${port}`,'--max-time','10','-o','/dev/null','-w','%{http_code}','https://www.cloudflare.com/cdn-cgi/trace']);result={label,http:r.stdout,exit:0};}
 catch(e){result={label,http:e.stdout || '000',exit:e.code};}
 report.results.push(result);console.log(JSON.stringify(result));
 if(expected)assert.equal(result.http,'200');else assert.notEqual(result.http,'200');
}
try{
 xp=await xray.prepare(rows);sp=await ss.prepare(rows);await startMihomo();
 await https('Outer Amnezia',xp.bridges[outer.id].port);
 await https('Outline inside Amnezia',sp.bridges[inner.id].port);
 await https('Xray inside Amnezia',xp.bridges[nestedXray.id].port);
 report.udp=await probeUdp(sp.bridges[inner.id].port,{timeout:5000});console.log('UDP',JSON.stringify(report.udp));
 store.updateProfile(outer.id,{enabled:false});await startMihomo();
 await https('Disabled outer rejects Outline',sp.bridges[inner.id].port,false);
 await https('Disabled outer rejects Xray',xp.bridges[nestedXray.id].port,false);
 console.log('PASS',JSON.stringify(report));
}finally{
 await stopChild();await sp?.rollback();await xp?.rollback();await ss.stop();await xray.stop();store.close();db.close();rmSync(folder,{recursive:true,force:true});
}
