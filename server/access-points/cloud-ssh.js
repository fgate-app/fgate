import {stopManagedProcess} from '../managed-process.js';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {unusedPort} from '../xray.js';
import {validCloudSsh,validEd25519Key,generateCloudSshIdentity} from '../cloud/ssh-policy.js';

export async function createCloudSshIdentity(){return generateCloudSshIdentity();}
// Preserve every byte, but never send client data before the SSH server greeting.
// This is a fixed destination relay, not an unauthenticated general proxy.
export async function createSshBannerRelay({host,port,connect=options=>net.connect(options)}){
 const sockets=new Set();let closed=false;
 const track=s=>{sockets.add(s);s.once('close',()=>sockets.delete(s));s.on('error',()=>{});};
 const server=net.createServer(client=>{
  if(closed || sockets.size>=16){client.destroy();return;}
  track(client);client.pause();let upstream;
  try{upstream=connect({host,port});}catch{client.destroy();return;}
  track(upstream);let greeting=Buffer.alloc(0),ready=false;
  const stop=()=>{client.destroy();upstream.destroy();};
  client.once('close',()=>upstream.destroy());upstream.once('close',()=>client.destroy());client.once('error',stop);upstream.once('error',stop);
  upstream.setTimeout(8000,stop);
  const first=chunk=>{
   greeting=Buffer.concat([greeting,chunk]);if(greeting.length>8192)return stop();
   if(!/(?:^|\n)SSH-2\.0-[^\r\n]+\r?\n/.test(greeting.toString('latin1')))return;
   ready=true;upstream.setTimeout(0);upstream.off('data',first);
   client.write(greeting);upstream.pipe(client);client.pipe(upstream);client.resume();
  };
  upstream.on('data',first);upstream.once('end',()=>{if(!ready)stop();});
 });
 try{await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});}
 catch(error){for(const s of sockets)s.destroy();throw error;}
 return {port:server.address().port,close:async()=>{if(closed)return;closed=true;for(const s of sockets)s.destroy();await new Promise(resolve=>server.close(resolve));}};
}
export function cloudSshAvailable(server){return validCloudSsh(server.secrets?.cloudSsh,server.secrets?.instanceId || '') && validEd25519Key(server.secrets?.cloudSshPublicKey) && typeof server.secrets?.cloudSshPrivateKey==='string';}
export async function startCloudSsh(server,{stateDir,signal,spawnProcess=spawn,timeout=10000}={}){
 if(!cloudSshAvailable(server))throw Error('Cloud SSH fallback is unavailable');
 stateDir=process.env.FREEDOMGATE_SSH_RUNTIME_DIR || stateDir || tmpdir();
 signal?.throwIfAborted();mkdirSync(stateDir,{recursive:true,mode:0o700});const folder=mkdtempSync(join(stateDir,'ssh-'));
 let relay,child,closed=false;const sockets=new Set();
 const close=async()=>{
  if(closed)return;closed=true;for(const s of sockets)s.destroy();
  await stopManagedProcess(child,{timeout:1500});
  await relay?.close();rmSync(folder,{recursive:true,force:true});
 };
 try{
  relay=await createSshBannerRelay({host:server.host,port:server.secrets.cloudSsh.port});
  const key=join(folder,'identity'),hosts=join(folder,'known_hosts'),relayPort=await unusedPort(),enrollmentPort=await unusedPort();
  writeFileSync(key,server.secrets.cloudSshPrivateKey,{mode:0o600});
  writeFileSync(hosts,`freedomgate-cloud ${server.secrets.cloudSsh.hostKey}\n[freedomgate-cloud]:${relay.port} ${server.secrets.cloudSsh.hostKey}\n`,{mode:0o600});
  const args=['-F','/dev/null','-N','-T','-i',key,'-p',String(relay.port),'-o','HostKeyAlias=freedomgate-cloud','-o','StrictHostKeyChecking=yes','-o','UserKnownHostsFile='+hosts,'-o','GlobalKnownHostsFile=/dev/null','-o','BatchMode=yes','-o','IdentitiesOnly=yes','-o','IdentityAgent=none','-o','PasswordAuthentication=no','-o','KbdInteractiveAuthentication=no','-o','PreferredAuthentications=publickey','-o','ForwardAgent=no','-o','ExitOnForwardFailure=yes','-o','ConnectTimeout=8','-o','ServerAliveInterval=5','-o','ServerAliveCountMax=2','-o','KexAlgorithms=curve25519-sha256','-L',`127.0.0.1:${relayPort}:127.0.0.1:${server.transportPort}`,'-L',`127.0.0.1:${enrollmentPort}:127.0.0.1:7443`,server.secrets.cloudSsh.username+'@127.0.0.1'];
  child=spawnProcess('ssh',args,{stdio:'ignore',env:{...process.env,SSH_AUTH_SOCK:''}});let failed=false;child.once('error',()=>{failed=true;});
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline){
   signal?.throwIfAborted();if(failed || child.exitCode!==null || child.signalCode!==null)throw Error('Cloud SSH connection failed');
   const ready=await new Promise(resolve=>{const s=net.connect(relayPort,'127.0.0.1');sockets.add(s);const finish=ok=>{sockets.delete(s);s.destroy();resolve(ok);};s.once('connect',()=>finish(true));s.once('error',()=>finish(false));s.setTimeout(200,()=>finish(false));});
   if(ready){await delay(50,undefined,{signal});if(child.exitCode!==null || child.signalCode!==null)throw Error('Cloud SSH connection failed');return {relayPort,enrollmentPort,child,close};}
   await delay(100,undefined,{signal});
  }
  throw Error('Cloud SSH connection timed out');
 }catch(error){await close();throw error;}
}
