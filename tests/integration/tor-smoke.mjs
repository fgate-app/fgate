import {TorGateway} from '../../server/tor/runtime.js';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
const run=promisify(execFile),dir=mkdtempSync(join(tmpdir(),'fg-tor-native-'));
const row=new TorGateway({id:'native',stateDir:dir,bundle:process.env.FREEDOMGATE_TOR_BUNDLE,spawnProcess:(binary,args,options)=>{const child=spawn(binary,args,options);child.stdout.on('data',chunk=>{for(const line of chunk.toString().split('\n'))if(/Bootstrapped|\[warn\]|\[err\]/.test(line))console.log(line.replace(/(?:\d{1,3}\.){3}\d{1,3}/g,'[address]'));});return child;},settings:{mode:process.env.TOR_MODE || 'auto',connectTimeout:Number(process.env.TOR_TIMEOUT || 60),retries:0}});
await row.start();let ready=false;
try{
 for(let n=0;n<140;n++){
  await new Promise(resolve=>setTimeout(resolve,1000));if(n%5===0)console.log(JSON.stringify(row.snapshot()));
  if(row.state==='ready'){ready=true;break;}
  if(['unavailable','failed'].includes(row.state))break;
 }
 if(ready){const result=await run('curl',['--silent','--show-error','--fail','--socks5-hostname',`127.0.0.1:${row.port}`,'--max-time','40','https://check.torproject.org/api/ip']);const data=JSON.parse(result.stdout);if(data.IsTor!==true)throw Error('The request did not use Tor.');console.log(JSON.stringify({native:'ok',mode:row.mode,torConfirmed:true}));}
 else{console.log(JSON.stringify({native:'unavailable',status:row.snapshot(),stateDir:dir}));process.exitCode=2;}
}finally{await row.stop();console.log(JSON.stringify({stopped:row.state,port:row.port}));}
