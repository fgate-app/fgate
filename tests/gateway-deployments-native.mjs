// Root under unshare -n, loopback up. SSH ForceCommand redirects all install paths.
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,readdirSync,existsSync,chmodSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {execFileSync,spawn} from 'node:child_process';
import https from 'node:https';
import http from 'node:http';
import net from 'node:net';
import dgram from 'node:dgram';
import {Store} from '../server/store.js';
import {GatewayDeploymentService} from '../server/gateway-deployments/service.js';
import {unusedPort} from '../server/xray.js';
import {moduleBinary} from '../server/module-paths.js';
const base=mkdtempSync('/tmp/fg-vps-native-');chmodSync(base,0o755);for(const name of ['bin','state','units','vpn'])mkdirSync(join(base,name),{mode:0o755});
const xray=moduleBinary('xray','xray','/opt/freedomgate/modules/xray/current/xray'),children=[],servers=[],store=new Store(join(base,'db')),service=new GatewayDeploymentService(store,{stateDir:base});
const command=(name,args)=>execFileSync(name,args,{stdio:['ignore','pipe','pipe']});
function launch(binary,args){const child=spawn(binary,args,{stdio:['ignore','ignore','ignore']});children.push(child);return child;}
async function listen(server,host='127.0.0.1'){servers.push(server);await new Promise(resolve=>server.listen(0,host,resolve));return server.address().port;}
async function ready(port){for(let i=0;i<80;i++){const ok=await new Promise(resolve=>{const socket=net.connect(port,'127.0.0.1');socket.on('connect',()=>{socket.destroy();resolve(true);});socket.on('error',()=>resolve(false));});if(ok)return;await new Promise(resolve=>setTimeout(resolve,100));}throw Error('Fixture listener did not start.');}
try{
 command('ip',['addr','add','93.184.215.14/32','dev','lo']);
 command('ssh-keygen',['-q','-t','ed25519','-N','fixture-ssh-passphrase','-f',join(base,'identity')]);command('ssh-keygen',['-q','-t','ed25519','-N','','-f',join(base,'host')]);
 command('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(base,'key'),'-out',join(base,'cert'),'-days','1','-subj','/CN=www.microsoft.com']);
 const realityTarget=await listen(https.createServer({key:readFileSync(join(base,'key')),cert:readFileSync(join(base,'cert')),minVersion:'TLSv1.3'},(_req,res)=>res.end('target')));
 writeFileSync(join(base,'fixture.json'),JSON.stringify({realityTarget}));
 const originPort=await listen(http.createServer((_req,res)=>res.end('fixture-vpn-response')),'0.0.0.0');
 const udp=dgram.createSocket('udp4');udp.on('message',(data,peer)=>udp.send(data,peer.port,peer.address));await new Promise(resolve=>udp.bind(0,'0.0.0.0',resolve));servers.push({close:callback=>udp.close(callback)});const udpPort=udp.address().port;
 command('python3',['-c',"import zipfile,sys\nwith zipfile.ZipFile(sys.argv[2],'w') as z:z.write(sys.argv[1],'xray')",xray,join(base,'xray.zip')]);
 writeFileSync(join(base,'bin','systemctl'),'#!/bin/sh\nexec python3 '+JSON.stringify(resolve('tests/integration/vps-systemctl-fixture.py'))+' "$@"\n',{mode:0o755});writeFileSync(join(base,'bin','ufw'),'#!/bin/sh\necho "Status: inactive"\n',{mode:0o755});
 const sshPort=await unusedPort();writeFileSync(join(base,'sshd_config'),`Port ${sshPort}\nListenAddress 127.0.0.1\nHostKey ${base}/host\nAuthorizedKeysFile ${base}/identity.pub\nPermitRootLogin yes\nStrictModes no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nUsePAM no\nPidFile ${base}/sshd.pid\nForceCommand /usr/bin/python3 ${resolve('tests/integration/vps-ssh-fixture.py')} ${base}\n`);
 launch('/usr/sbin/sshd',['-D','-e','-f',join(base,'sshd_config')]);await ready(sshPort);
 const identity=await service.inspect({host:'127.0.0.1',sshPort}),summary=[];
 for(const protocol of ['vless','shadowsocks']){
  const port=await unusedPort(),job=service.create({name:'Native '+protocol,host:'127.0.0.1',sshPort,username:'root',sshKey:readFileSync(join(base,'identity'),'utf8'),sshPassphrase:'fixture-ssh-passphrase',publicPort:port,serverName:'www.microsoft.com',protocol,...identity});await service.jobs.get(job.id);
  const status=service.get(job.id);assert.equal(status.state,'completed',JSON.stringify(status));const row=service.repository.get(job.id);assert.equal(row.secrets.sshKey,undefined);assert.ok(service.key(job.id).link.startsWith(protocol==='vless'?'vless:':'ss:'));
  const clientPort=await unusedPort(),outbound=protocol==='vless'?{protocol:'vless',settings:{vnext:[{address:'127.0.0.1',port,users:[{id:row.secrets.clientId,encryption:'none',flow:'xtls-rprx-vision'}]}]},streamSettings:{network:'tcp',security:'reality',realitySettings:{serverName:row.serverName,fingerprint:'chrome',publicKey:row.secrets.realityPublic,shortId:row.secrets.shortId}}}:{protocol:'shadowsocks',settings:{servers:[{address:'127.0.0.1',port,method:'chacha20-ietf-poly1305',password:row.secrets.password}]}};
  const config={log:{loglevel:'none'},inbounds:[{listen:'127.0.0.1',port:clientPort,protocol:'socks',settings:{auth:'password',accounts:[{user:'fg-geo',pass:'fixture-secret'}],udp:true}}],outbounds:[outbound]};const path=join(base,'client-'+protocol+'.json');writeFileSync(path,JSON.stringify(config));launch(xray,['run','-config',path]);await ready(clientPort);
  const response=await new Promise((resolve,reject)=>{const child=spawn('curl',['--silent','--show-error','--max-time','8','--socks5','127.0.0.1:'+clientPort,'--proxy-user','fg-geo:fixture-secret','--noproxy','','http://93.184.215.14:'+originPort+'/'],{stdio:['ignore','pipe','pipe']});let text='';child.stdout.on('data',chunk=>text+=chunk);child.once('exit',code=>code===0?resolve(text):reject(Error('VPN client request failed.')));});assert.equal(response,'fixture-vpn-response');
  const udpResult=await new Promise((resolve,reject)=>{const child=spawn('python3',['-c',`import importlib.util,time,socket\nspec=importlib.util.spec_from_file_location('d','server/dns-matrix.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\ns=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);s.bind(('127.0.0.1',0));p=s.getsockname()[1];s.close()\nu=m.ProxyUdpSocket({'port':${clientPort},'secret':'fixture-secret','localPort':p},'93.184.215.14',${udpPort},time.monotonic()+3)\nu.send(b'fixture-udp');assert u.recv(128)==b'fixture-udp';u.close();print('ok')`],{stdio:['ignore','pipe','pipe']});let text='';child.stdout.on('data',chunk=>text+=chunk);child.once('exit',code=>code===0?resolve(text.trim()):reject(Error('VPN UDP request failed.')));});assert.equal(udpResult,'ok');
  assert.ok(!existsSync('/etc/systemd/system/freedomgate-vpn-'+job.id+'.service'));summary.push({protocol,sshFingerprintPinned:true,state:status.state,tcp:true,udp:true,keyImported:true});
 }
 const occupied=net.createServer();const occupiedPort=await listen(occupied);const bad=service.create({name:'Occupied port',host:'127.0.0.1',sshPort,username:'root',sshKey:readFileSync(join(base,'identity'),'utf8'),sshPassphrase:'fixture-ssh-passphrase',publicPort:occupiedPort,protocol:'shadowsocks',...identity});await service.jobs.get(bad.id);assert.equal(service.get(bad.id).state,'error');assert.match(service.get(bad.id).error,/already in use/);assert.ok(!existsSync(join(base,'vpn',bad.id)));
 writeFileSync(join(base,'corrupt-next'),'1');const broken=service.create({name:'Checksum retry',host:'127.0.0.1',sshPort,username:'root',sshKey:readFileSync(join(base,'identity'),'utf8'),sshPassphrase:'fixture-ssh-passphrase',publicPort:await unusedPort(),protocol:'shadowsocks',...identity});await service.jobs.get(broken.id);assert.equal(service.get(broken.id).state,'error');assert.match(service.get(broken.id).error,/download or verify/);assert.ok(!existsSync(join(base,'vpn',broken.id)));const password=service.repository.get(broken.id).secrets.password;service.retry(broken.id,{sshKey:readFileSync(join(base,'identity'),'utf8'),sshPassphrase:'fixture-ssh-passphrase',...identity});await service.jobs.get(broken.id);assert.equal(service.get(broken.id).state,'completed');assert.equal(service.repository.get(broken.id).secrets.password,password);
 console.log(JSON.stringify({summary,checksumMismatch:'rejected before installing; retry keeps the personal key',encryptedSshKey:true,occupiedPort:'rejected without overwriting',realSsh:true,realXray:true,publicTraffic:false,systemd:'fixture service manager, real unprivileged Xray processes',productionFilesChanged:false}));
}finally{
 await service.close();for(const file of readdirSync(join(base,'state'))){if(!file.endsWith('.service'))continue;try{const row=JSON.parse(readFileSync(join(base,'state',file),'utf8'));if(row.pid)process.kill(-row.pid,'SIGTERM');}catch{}}
 for(const child of children)child.kill();await Promise.all(servers.map(server=>new Promise(resolve=>server.close(resolve))));store.close();rmSync(base,{recursive:true,force:true});
}
