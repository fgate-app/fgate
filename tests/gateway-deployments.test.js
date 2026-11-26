import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {Store} from '../server/store.js';
import {fingerprint} from '../server/access-points/ssh.js';
import {newDeployment,deploymentLink,publicDeployment} from '../server/gateway-deployments/model.js';
import {vpnServerConfig,vpnInstallScript,provisionVpn} from '../server/gateway-deployments/provision.js';
import {GatewayDeploymentService} from '../server/gateway-deployments/service.js';
const hostKey='ssh-ed25519 '+randomBytes(32).toString('base64');
const input={name:'Own VPN',host:'203.0.113.10',username:'root',sshPort:22,publicPort:443,protocol:'vless',serverName:'www.microsoft.com',hostKey,fingerprint:fingerprint(hostKey),sshKey:'-----BEGIN OPENSSH PRIVATE KEY-----\nfixture-private\n-----END OPENSSH PRIVATE KEY-----'};
function fixture(options={}){const dir=mkdtempSync(join(tmpdir(),'fg-deploy-')),store=new Store(join(dir,'db'));return {store,dir,service:new GatewayDeploymentService(store,{stateDir:dir,install:async()=>({platform:'linux-amd64'}),...options}),close(){store.close();rmSync(dir,{recursive:true,force:true});}};}
test('VPS settings reject shell injection, conflicting ports, unsupported protocols and changed SSH fingerprints',()=>{
 for(const value of [{host:'x;id'},{username:'root;id'},{publicPort:22},{protocol:'ssh'},{serverName:'x;id'},{fingerprint:'bad'},{sshKey:'bad'}])assert.throws(()=>newDeployment({...input,...value}));
 for(const protocol of ['vless','shadowsocks']){const row=newDeployment({...input,protocol});assert.match(deploymentLink(row),protocol==='vless'?/^vless:\/\//:/^ss:\/\//);assert.doesNotMatch(JSON.stringify(publicDeployment(row)),/fixture-private|realityPrivate|password|hostKey/);}
});
test('installer uses pinned architecture assets, isolated ownership, verified archives and valid shell',()=>{
 for(const protocol of ['vless','shadowsocks'])for(const platform of ['linux-arm64','linux-amd64']){
  const row=newDeployment({...input,protocol}),config=vpnServerConfig(row),script=vpnInstallScript(row,platform);assert.equal(config.inbounds[0].port,443);assert.equal(config.outbounds[0].protocol,'freedom');assert.ok(config.routing.rules[0].ip.includes('169.254.0.0/16'));
  assert.match(script,/hashlib.sha256/);assert.match(script,/owner/);assert.match(script,/rollback/);assert.match(script,/systemctl is-active/);assert.doesNotMatch(script,/curl.*\|.*sh|iptables -F|ufw reset/);execFileSync('/bin/sh',['-n'],{input:script});
 }
 assert.equal(vpnServerConfig(newDeployment({...input,host:'2001:db8::1'})).inbounds[0].listen,'::');
});
test('background deployment creates one imported personal gateway, encrypts secrets and erases SSH credentials',async()=>{
 for(const protocol of ['vless','shadowsocks']){const value=fixture();try{
  const job=value.service.create({...input,protocol});assert.equal(job.state,'installing');await value.service.jobs.get(job.id);const row=value.service.get(job.id);assert.equal(row.state,'completed');assert.ok(value.store.profiles().some(profile=>profile.id===row.profileId));assert.match(value.service.key(job.id).link,protocol==='vless'?/^vless:/:/^ss:/);
  assert.equal(value.service.repository.get(job.id).secrets.sshKey,undefined);assert.doesNotMatch(readFileSync(join(value.dir,'db')).toString(),/fixture-private/);assert.doesNotMatch(JSON.stringify(value.service.list()),/realityPrivate|clientId|password|sshKey/);assert.throws(()=>value.service.create({...input,protocol}),/already uses/);
 }finally{await value.service.close();value.close();}}
});
test('installation failure and local apply failure preserve recoverable jobs without extra gateways',async()=>{
 let installs=0;const value=fixture({install:async()=>{if(++installs===1)throw Error('private-key-must-not-leak');return {platform:'linux-arm64'};}});
 try{const job=value.service.create(input);await value.service.jobs.get(job.id);assert.equal(value.service.get(job.id).state,'error');assert.doesNotMatch(JSON.stringify(value.service.get(job.id)),/must-not-leak/);assert.throws(()=>value.service.key(job.id));value.service.retry(job.id,input);await value.service.jobs.get(job.id);assert.equal(value.service.get(job.id).state,'completed');assert.equal(value.service.repository.all().length,1);}finally{await value.service.close();value.close();}
 const failing=fixture({apply:async()=>{throw Error('apply failed');}});try{const before=failing.store.profiles().length,job=failing.service.create(input);await failing.service.jobs.get(job.id);assert.equal(failing.store.profiles().length,before);assert.equal(failing.service.get(job.id).profileId,null);assert.equal(failing.service.get(job.id).state,'error');}finally{await failing.service.close();failing.close();}
});
test('restart marks interrupted installations for explicit retry without reusing SSH keys',async()=>{
 const value=fixture();try{const row=newDeployment(input);row.state='installing';value.service.repository.save(row);const restarted=new GatewayDeploymentService(value.store,{stateDir:value.dir});assert.equal(restarted.get(row.id).state,'error');assert.equal(restarted.repository.get(row.id).secrets.sshKey,undefined);await restarted.close();}finally{value.close();}
});
test('provisioner reports bounded stages and refuses unsupported remote platforms',async()=>{
 const stages=[];await provisionVpn(newDeployment(input),{progress:stage=>stages.push(stage),ssh:async(_row,operation)=>operation(async(script,options)=>script.includes('FREEDOMGATE_VPN_INSTALLED')?(assert.equal(options.timeout,180000),'FREEDOMGATE_VPN_INSTALLED'):'linux-amd64')});assert.deepEqual(stages,['checking','installing','verifying']);
 await assert.rejects(provisionVpn(newDeployment(input),{ssh:async(_row,operation)=>operation(async()=> 'darwin-arm64')}),/Supported VPS/);
});
test('deployment API requires admin and CSRF; only explicit key export returns a VPN credential',async()=>{
 const {createServer}=await import('../server/index.js');const value=fixture(),server=createServer(value.store,{gatewayDeployments:value.service});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
 try{
  assert.equal((await fetch(base+'/api/gateway-deployments')).status,401);
  const setup=await fetch(base+'/api/auth/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:'fixture password 12345'})}),session=await setup.json(),headers={'Content-Type':'application/json',Cookie:setup.headers.get('set-cookie').split(';')[0],'X-CSRF-Token':session.csrf};
  assert.equal((await fetch(base+'/api/gateway-deployments',{method:'POST',headers:{...headers,'X-CSRF-Token':'wrong'},body:JSON.stringify(input)})).status,403);
  const created=await fetch(base+'/api/gateway-deployments',{method:'POST',headers,body:JSON.stringify(input)});assert.equal(created.status,202);const job=await created.json();await value.service.jobs.get(job.id);
  const logs=await(await fetch(base+'/api/logs',{headers})).text();assert.match(logs,/POST \/api\/gateway-deployments/);assert.doesNotMatch(logs,/fixture-private|sshKey/);
  const list=await(await fetch(base+'/api/gateway-deployments',{headers})).text();assert.doesNotMatch(list,/fixture-private|sshKey|realityPrivate|vless:\/\//);
  const exported=await fetch(base+'/api/gateway-deployments/'+job.id+'/key',{headers});assert.equal(exported.headers.get('cache-control'),'no-store');assert.match((await exported.json()).link,/^vless:/);
  await fetch(base+'/api/users',{method:'POST',headers,body:JSON.stringify({username:'operator',password:'operator password 12345',role:'operator'})});const login=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'operator',password:'operator password 12345'})});const cookie=login.headers.get('set-cookie').split(';')[0];assert.equal((await fetch(base+'/api/gateway-deployments',{headers:{Cookie:cookie}})).status,403);assert.equal((await fetch(base+'/api/gateway-deployments/'+job.id+'/key',{headers:{Cookie:cookie}})).status,403);
 }finally{await new Promise(resolve=>server.close(resolve));await server.cleanup;value.close();}
});

test('retry recovers a gateway imported immediately before an interrupted state write',async()=>{
 for(const protocol of ['vless','shadowsocks']){const value=fixture();try{const row=newDeployment({...input,protocol}),profile=value.store.importProfile({name:row.name,value:deploymentLink(row)});row.state='error';value.service.repository.save(row);const before=value.store.profiles().length;value.service.retry(row.id,input);await value.service.jobs.get(row.id);assert.equal(value.service.get(row.id).profileId,profile.id);assert.equal(value.store.profiles().length,before);}finally{await value.service.close();value.close();}}
});
