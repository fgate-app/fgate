import {readFileSync,realpathSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {isIP} from 'node:net';
import {fileURLToPath} from 'node:url';

export function managedHttpAddress({run=execFileSync,read=readFileSync}={}){
 for(const unit of ['freedomgate.service','freedomgate-network.service'])run('systemctl',['is-active','--quiet',unit],{timeout:1000,stdio:'pipe'});
 const pid=String(run('systemctl',['show','freedomgate.service','--property=MainPID','--value'],{timeout:1000,stdio:'pipe'})).trim();
 if(!/^[1-9]\d*$/.test(pid))throw Error('The web service is not running.');
 const environment=Object.fromEntries(String(read('/proc/'+pid+'/environ','utf8')).split('\0').filter(row=>row.includes('=')).map(row=>{const index=row.indexOf('=');return [row.slice(0,index),row.slice(index+1)];}));
 const port=environment.PORT || '80';if(!/^\d+$/.test(port) || Number(port)<1 || Number(port)>65535)throw Error('Invalid service HTTP port.');
 let host=environment.HOST || '0.0.0.0';if(host==='0.0.0.0')host='127.0.0.1';else if(host==='::')host='::1';
 if(!isIP(host) && host!=='localhost')throw Error('The service HTTP bind address must be a literal IP or localhost.');
 return `http://${isIP(host)===6?'['+host+']':host}:${port}`;
}
export async function installHealth({address=managedHttpAddress,fetchImpl=fetch}={}){
 try{
  const base=address();
  const health=await fetchImpl(base+'/api/health',{signal:AbortSignal.timeout(1500),redirect:'error'});
  if(!health.ok || (await health.json()).ready!==true)return false;
  const session=await fetchImpl(base+'/api/auth/session',{signal:AbortSignal.timeout(1500),redirect:'error'});
  return session.ok && typeof (await session.json()).setupRequired==='boolean';
 }catch{return false;}
}
let main=false;try{main=!!process.argv[1] && realpathSync(process.argv[1])===fileURLToPath(import.meta.url);}catch{}
if(main)process.exit(await installHealth()?0:1);
