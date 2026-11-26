import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute=promisify(execFile);
export async function sshStatus(){
 if(os.platform()!=='linux')return {platform:os.platform(),state:'unsupported',managed:false};
 for(const unit of ['ssh.service','sshd.service']){
  try{const {stdout}=await execute('/usr/bin/systemctl',['show',unit,'--property=LoadState,ActiveState,SubState'],{timeout:2000,maxBuffer:4096});const values=Object.fromEntries(stdout.trim().split('\n').map(l=>l.split('=')));if(values.LoadState==='loaded')return {platform:'linux',unit,state:values.ActiveState,substate:values.SubState,managed:false};}catch{}
 }
 return {platform:'linux',state:'unavailable',managed:false};
}
