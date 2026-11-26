// IPC worker for the root-only isolated Lantern path experiment. Emits no raw logs.
import {createInterface} from 'node:readline';import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {readFileSync,existsSync} from 'node:fs';import {join} from 'node:path';
const {LanternGateway,waitForLantern}=await import(process.env.FG_CODE_ROOT+'/server/lantern/runtime.js');const run=promisify(execFile),gateway=new LanternGateway({id:'live-path-test',stateDir:process.env.FG_STATE,...(process.env.FG_LANTERN_BINARY?{binary:process.env.FG_LANTERN_BINARY}:{})});let offset=0;
function evidence(){let log='';try{log=readFileSync(join(gateway.dir,'lantern-headless.log'),'utf8');}catch{}const text=log.slice(offset);offset=log.length;const targets=[...text.matchAll(/->((?:\d{1,3}\.){3}\d{1,3}):(\d+)/g)].map(row=>({address:row[1],port:Number(row[2])}));return {resetErrors:(text.match(/connection reset by peer/gi)||[]).length,saltReadErrors:(text.match(/failed to read salt/gi)||[]).length,timeouts:(text.match(/i\/o timeout|context deadline exceeded/gi)||[]).length,configFetches:(text.match(/Fetched cloud config/g)||[]).length,failedTargets:targets.filter((row,index,all)=>all.findIndex(other=>other.address===row.address && other.port===row.port)===index).slice(0,12)};}
const send=value=>console.log(JSON.stringify(value));
try{
 await gateway.start();const ready=await waitForLantern(gateway,{timeoutMs:75000});send({type:'ready',clientState:ready.state,outcome:ready.outcome,pid:gateway.child.pid});
 const lines=createInterface({input:process.stdin});
 for await(const line of lines){const command=JSON.parse(line);if(command.op==='stop')break;const result={type:'probe',id:command.id,phase:command.phase,pid:gateway.child.pid,clientState:gateway.state,websites:[]};
  for(const url of ['https://www.gstatic.com/generate_204','https://api.ipify.org']){
   try{const {stdout}=await run('curl',['--silent','--show-error','--fail','--no-keepalive','--noproxy','','--max-time','18','--proxy','http://127.0.0.1:'+gateway.port,'--write-out','\n%{http_code}',url],{timeout:21000,maxBuffer:4096});const rows=stdout.trim().split('\n');result.websites.push({host:new URL(url).hostname,ok:true,httpStatus:Number(rows.pop()),...(url.includes('ipify')?{exitIP:rows.join('')}:{} )});}
   catch(error){result.websites.push({host:new URL(url).hostname,ok:false,curlCode:error.code,reason:error.code===35?'TLS connection failed':error.code===28?'Request timed out':'Request failed'});}
  }
  result.evidence=evidence();send(result);
 }
}finally{await gateway.stop();send({type:'stopped',openConnections:gateway.sockets.size,childExited:!existsSync('/proc/'+gateway.child?.pid)});}
