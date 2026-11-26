import {readFile,unlink} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {isIP} from 'node:net';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

export const strategyMark=0x20000008, strategyQueue=301, strategyTable='freedomgate_diagnostic_dpi';
export const proxyStrategies=Object.freeze([
 {id:'baseline',label:'Without DPI bypass',desync:null},
 {id:'split-1',label:'Split the first packet',desync:'multisplit:pos=1:payload=all'},
 {id:'disorder-1',label:'Reorder the first segments',desync:'multidisorder:pos=1:payload=all'},
 {id:'disorder-16',label:'Reorder segments at byte 16',desync:'multidisorder:pos=16:payload=all'},
 {id:'fake-md5-split',label:'Fake packet and split',desync:['fake:blob=0x00000000:tcp_md5:repeats=2:payload=all','multisplit:pos=1:payload=all']},
 {id:'fake-md5-disorder',label:'Fake packet and reorder',desync:['fake:blob=0x00000000:tcp_md5:repeats=2:payload=all','multidisorder:pos=1:payload=all']}
]);
export function strategyDaemonArgs({binary,lua,pidfile,strategy}){
 const selected=proxyStrategies.find(row=>row.id===strategy && row.desync);
 if(!selected)throw Error('Invalid diagnostic strategy.');
 return [binary,`--qnum=${strategyQueue}`,'--daemon',`--pidfile=${pidfile}`,'--fwmark=0x40000000','--bind-fix4','--bind-fix6','--user=root',`--lua-init=@${lua}/zapret-lib.lua`,`--lua-init=@${lua}/zapret-antidpi.lua`,
  `--filter-mark=0x${strategyMark.toString(16)}/0xffffffff`,'--filter-tcp=1-65535','--reasm-disable','--out-range=-d10','--payload=all',...[selected.desync].flat().map(value=>`--lua-desync=${value}`)];
}
export function strategyNft(address,port){
 if(!isIP(address) || !Number.isInteger(port) || port<1 || port>65535)throw Error('Invalid diagnostic target.');
 return `table inet ${strategyTable} {\n chain postrouting {\n type filter hook postrouting priority 99; policy accept;\n oifname "lo" return\n meta mark 0x${strategyMark.toString(16)} ${isIP(address)===6?'ip6':'ip'} daddr ${address} tcp dport ${port} counter queue num ${strategyQueue} bypass\n }\n}\n`;
}

// One leased relay at a time. The lease expires even if the web service crashes;
// helper shutdown/restart also removes its owned rules and daemon.
export class ProxyStrategyHelper{
 constructor({run,paths,stopDaemon,runDir,spawnProcess=spawn}){Object.assign(this,{run,paths,stopDaemon,runDir,spawnProcess});this.session=null;this.busy=false;}
 async recover(){await this.stopOwned();}
 async stopOwned(){
  const pidfile=join(this.runDir,'diagnostic-nfqws2.pid');
  try{const pid=Number((await readFile(pidfile,'utf8')).trim());if(Number.isInteger(pid) && pid>1 && (await readFile(`/proc/${pid}/cmdline`,'utf8')).split('\0').includes('--pidfile='+pidfile))await this.stopDaemon(pidfile,'nfqws2');}catch(error){if(error.code!=='ENOENT' && error.code!=='ESRCH')throw error;}
  await unlink(pidfile).catch(()=>{});
  await this.run('nft',['delete','table','inet',strategyTable]).catch(()=>{});
  for(const family of [[],['-6']])await this.run('ip',[...family,'rule','del','priority','1802','fwmark','0x20000008/0xffffffff','lookup','main']).catch(()=>{});
 }
 async stop(lease){
  const session=this.session;
  if(session && lease && session.lease!==lease)return {ok:false};
  this.session=null;
  if(session){
   clearTimeout(session.timer);session.child.stdin.end();
   for(const request of session.waiters.values())request.reject(Error('Diagnostic relay stopped.'));
   if(session.child.exitCode===null && session.child.signalCode===null)await new Promise(resolve=>{const timer=setTimeout(()=>{session.child.kill('SIGKILL');resolve();},1000);session.child.once('exit',()=>{clearTimeout(timer);resolve();});session.child.kill('SIGTERM');});
  }
  await this.stopOwned();return {ok:true};
 }
 async handle(request,{signal,interface:uplink}={}){
  if(typeof request.lease!=='string' || !/^[a-f0-9]{32}$/.test(request.lease))throw Error('Invalid diagnostic lease.');
  if(request.op==='stop')return this.stop(request.lease);
  if(request.op==='stats'){
   const s=this.session;if(!s || s.lease!==request.lease)throw Error('Diagnostic relay expired.');
   const id=randomBytes(8).toString('hex');
   return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{s.waiters.delete(id);reject(Error('Diagnostic relay unavailable.'));},1000);s.waiters.set(id,{resolve:value=>{clearTimeout(timer);resolve({ok:true,...value});},reject});s.child.stdin.write(JSON.stringify({id})+'\n');});
  }
  if(request.op!=='start' || !isIP(request.address) || !Number.isInteger(request.port) || request.port<1 || request.port>65535 || !proxyStrategies.some(row=>row.id===request.strategy) || !/^[a-zA-Z0-9_.:-]{1,15}$/.test(uplink || ''))throw Error('Invalid diagnostic relay request.');
  if(this.busy || this.session)throw Error('A diagnostic relay is already active.');
  this.busy=true;
  try{
   if(signal?.aborted)throw Error('Diagnostic cancelled.');
   await this.stopOwned();
   if(request.strategy!=='baseline'){
    const {writeFile}=await import('node:fs/promises');
    const [binary,...args]=strategyDaemonArgs({...await this.paths(),pidfile:join(this.runDir,'diagnostic-nfqws2.pid'),strategy:request.strategy});
    await this.run(binary,args.filter(arg=>arg!=='--daemon' && !arg.startsWith('--pidfile=')).concat('--dry-run'),{timeout:5000,signal});
    await this.run(binary,args,{timeout:5000,signal});
    const nftfile=join(this.runDir,'diagnostic-dpi.nft');await writeFile(nftfile,strategyNft(request.address,request.port));
    await this.run('nft',['-f',nftfile],{timeout:3000,signal});
   }
   for(const family of [[],['-6']])await this.run('ip',[...family,'rule','add','priority','1802','fwmark','0x20000008/0xffffffff','lookup','main'],{timeout:3000,signal});
   const username=randomBytes(16).toString('hex'),password=randomBytes(24).toString('hex');
   const child=this.spawnProcess('python3',[fileURLToPath(new URL('./strategy-relay.py',import.meta.url))],{stdio:['pipe','pipe','ignore']});
   const session={child,lease:request.lease,waiters:new Map(),timer:null};this.session=session;
   session.timer=setTimeout(()=>this.stop(request.lease).catch(()=>{}),35000);session.timer.unref?.();
   child.stdin.on('error',()=>{});
   const ready=await new Promise((resolve,reject)=>{
    let raw='';const timer=setTimeout(()=>reject(Error('Diagnostic relay did not start.')),3000);
    const aborted=()=>reject(Error('Diagnostic cancelled.'));signal?.addEventListener('abort',aborted,{once:true});
    const finish=value=>{clearTimeout(timer);signal?.removeEventListener('abort',aborted);value?.ready?resolve(value):reject(Error('Diagnostic relay did not start.'));};
    child.once('error',()=>finish(null));child.once('exit',()=>{finish(null);if(this.session===session)this.stop(request.lease).catch(()=>{});});
    child.stdout.on('data',chunk=>{raw+=chunk;if(raw.length>65536){child.kill('SIGKILL');finish(null);return;}let newline;while((newline=raw.indexOf('\n'))!==-1){const line=raw.slice(0,newline);raw=raw.slice(newline+1);try{const value=JSON.parse(line);if('ready' in value)finish(value);else {session.waiters.get(value.id)?.resolve(value);session.waiters.delete(value.id);}}catch{finish(null);}}});
    child.stdin.write(JSON.stringify({address:request.address,port:request.port,mark:strategyMark,interface:uplink,username,password,capture:request.capture===true})+'\n');
   });
   if(signal?.aborted)throw Error('Diagnostic cancelled.');
   return {ok:true,port:ready.port,username,password,expiresSeconds:35};
  }catch(error){await this.stop(request.lease).catch(()=>{});throw error;}finally{this.busy=false;}
 }
}
