import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {isIP} from 'node:net';
import {AccessPointError} from './model.js';
export function execute(binary,args,{input='',timeout=15000,maxOutput=65536,env=process.env}={}){
 return new Promise((resolve,reject)=>{
  const child=spawn(binary,args,{stdio:['pipe','pipe','pipe'],env});let output='',error='',settled=false;
  const finish=(failure,result)=>{if(settled)return;settled=true;clearTimeout(timer);failure?reject(failure):resolve(result);};
  const timer=setTimeout(()=>{child.kill('SIGKILL');finish(new AccessPointError('SSH operation timed out.',504));},timeout);
  child.stdout.on('data',data=>{output+=data;if(Buffer.byteLength(output)>maxOutput){child.kill('SIGKILL');finish(new AccessPointError('SSH response is too large.',502));}});
  child.stderr.on('data',data=>{if(error.length<8192)error+=data;});
  child.stdin.on('error',()=>{});child.stdin.end(input);
  child.once('error',()=>finish(new AccessPointError('SSH tools are unavailable.',503)));
  child.once('close',code=>finish(null,{code,output,error}));
 });
}
export function fingerprint(hostKey){
 const parts=String(hostKey).trim().split(/\s+/);
 if(parts.length!==2 || parts[0]!=='ssh-ed25519' || !/^[A-Za-z0-9+/]+={0,2}$/.test(parts[1]))throw new AccessPointError('Invalid SSH host key.');
 return 'SHA256:'+createHash('sha256').update(Buffer.from(parts[1],'base64')).digest('base64').replace(/=+$/,'');
}
export async function inspectHost(input){
 const host=String(input.host || '').trim(),port=Number(input.sshPort || 22);
 if(!isIP(host) || !Number.isInteger(port)||port<1||port>65535)throw new AccessPointError("Enter the VPS IP address and SSH port.");
 const result=await execute('ssh-keyscan',['-T','5','-t','ed25519','-p',String(port),host],{timeout:10000});
 const line=result.output.split('\n').find(line=>!line.startsWith('#')&&line.includes(' ssh-ed25519 '));
 if(!line)throw new AccessPointError('SSH server is unreachable or has no Ed25519 host key.',502);
 const hostKey=line.trim().split(/\s+/).slice(1).join(' ');
 return {hostKey,fingerprint:fingerprint(hostKey)};
}
export async function withSsh(server,operation){
 if(fingerprint(server.hostKey)!==server.fingerprint)throw new AccessPointError('SSH fingerprint mismatch.');
 if(typeof server.secrets.sshKey!=='string' || server.secrets.sshKey.length>32768 || !server.secrets.sshKey.includes('PRIVATE KEY-----'))throw new AccessPointError("Enter the SSH private key.");
 const folder=await mkdtemp(join(tmpdir(),'fg-ssh-'));
 try{
  const key=join(folder,'identity'),hosts=join(folder,'known_hosts');
  await writeFile(key,server.secrets.sshKey.trim()+'\n',{mode:0o600});
  const keyEnv={...process.env};
  if(server.secrets.sshPassphrase){
   const phrase=join(folder,'passphrase'),askpass=join(folder,'askpass');
   await writeFile(phrase,server.secrets.sshPassphrase,{mode:0o600});
   await writeFile(askpass,'#!/bin/sh\nexec /bin/cat "$FREEDOMGATE_SSH_PASSPHRASE_FILE"\n',{mode:0o700});
   Object.assign(keyEnv,{SSH_ASKPASS:askpass,SSH_ASKPASS_REQUIRE:'force',DISPLAY:':0',FREEDOMGATE_SSH_PASSPHRASE_FILE:phrase});
  }
  const valid=await execute('ssh-keygen',server.secrets.sshPassphrase?['-y','-f',key]:['-y','-P','','-f',key],{env:keyEnv});
  if(valid.code!==0)throw new AccessPointError('SSH key or passphrase is invalid.');
  await writeFile(hosts,`[${server.host}]:${server.sshPort} ${server.hostKey}\n${server.host} ${server.hostKey}\n`,{mode:0o600});
  const args=['-F','/dev/null','-T','-i',key,'-p',String(server.sshPort),'-o','BatchMode='+(server.secrets.sshPassphrase?'no':'yes'),'-o','PasswordAuthentication=no','-o','KbdInteractiveAuthentication=no','-o','PreferredAuthentications=publickey','-o','NumberOfPasswordPrompts=1','-o','IdentitiesOnly=yes','-o','IdentityAgent=none','-o','StrictHostKeyChecking=yes','-o','UserKnownHostsFile='+hosts,'-o','GlobalKnownHostsFile=/dev/null','-o','ConnectTimeout=8','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=3',server.username+'@'+server.host];
  return await operation(async (script,options={})=>{
   const result=await execute('ssh',[...args,server.username==='root'?'/bin/sh -s':'sudo -n /bin/sh -s'],{...options,input:script,env:keyEnv});
   if(result.code!==0){const code=/^FREEDOMGATE_VPN_ERROR:([a-z-]+)$/m.exec(result.output)?.[1];if(code && Object.hasOwn(options.errors || {},code))throw new AccessPointError(options.errors[code],502);}
   if(result.code!==0)throw new AccessPointError('Remote operation failed. Check SSH access, host fingerprint and passwordless sudo.',502);
   return result.output;
  });
 }finally{await rm(folder,{recursive:true,force:true});}
}
