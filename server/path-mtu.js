import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {isIP} from 'node:net';
const execute=promisify(execFile);
export const pathMtuLimits=Object.freeze({budgetSeconds:10,maxAttempts:4,packetBytes:[576,1280,1400,1500],waitSeconds:1});
export function mtuArguments(address,interfaceName,bytes){
 const family=isIP(address);if(!family || !/^[a-zA-Z0-9_.:-]{1,15}$/.test(interfaceName) || !pathMtuLimits.packetBytes.includes(bytes) || family===6 && bytes<1280)throw Error('Invalid MTU probe parameters.');
 return ['-'+family,'-n','-M','do','-c','1','-W','1','-I',interfaceName,'-m','1073741824','-s',String(bytes-(family===6?48:28)),address];
}
export function parseMtuProbe(text,bytes,code=0){
 const value=String(text),mtu=/\bmtu\s*[=:]?\s*(\d+)/i.exec(value),limit=mtu?Number(mtu[1]):null;
 if(/message too long/i.test(value))return {packetBytes:bytes,state:'limited',reason:'local-size-limit',...(limit?{mtu:limit}:{})};
 if(/frag needed|packet too big/i.test(value))return {packetBytes:bytes,state:'limited',reason:'icmp-size-limit',...(limit?{mtu:limit}:{})};
 if(code===0 && /\bbytes from\b/.test(value))return {packetBytes:bytes,state:'ok',reason:'echo-reply'};
 return {packetBytes:bytes,state:'unavailable',reason:code==='ENOENT'?'ping-unavailable':/not permitted|permission denied/i.test(value)?'permission-denied':'icmp-no-response'};
}
export async function probePathMtu({address,interfaceName,signal,run=execute}){
 const family=isIP(address);mtuArguments(address,interfaceName,1280);
 const report={state:'completed',outcome:'unavailable',address,family,mode:'direct-uplink-to-proxy',attempts:[],limits:pathMtuLimits,lowerBound:null,reportedMtu:null};
 const timeout=AbortSignal.timeout(10000),combined=signal?AbortSignal.any([signal,timeout]):timeout;
 const route=async()=>{const result=await run('ip',['-'+family,'-j','route','get',address,'mark','0x40000000','oif',interfaceName],{signal:combined,timeout:1000,maxBuffer:8192});const row=JSON.parse(result.stdout)?.[0];if(row?.dev!==interfaceName || (row.type || 'unicast')!=='unicast')throw Error('No usable uplink route.');const link=await run('ip',['-j','link','show','dev',interfaceName],{signal:combined,timeout:1000,maxBuffer:8192});const mtu=JSON.parse(link.stdout)?.[0]?.mtu;return {dev:row.dev,table:row.table,gateway:row.gateway,prefsrc:row.prefsrc,...(Number.isInteger(mtu)?{mtu}:{})};};
 try{
  report.route=await route();
  for(const bytes of pathMtuLimits.packetBytes.filter(size=>family===4 || size>=1280)){
   signal?.throwIfAborted();if(combined.aborted){report.reason='budget-exhausted';break;}
   try{const value=await run('ping',mtuArguments(address,interfaceName,bytes),{signal:combined,timeout:1500,maxBuffer:8192,env:{...process.env,LC_ALL:'C'}});report.attempts.push(parseMtuProbe(value.stdout+'\n'+value.stderr,bytes));}
   catch(error){signal?.throwIfAborted();report.attempts.push(parseMtuProbe((error.stdout || '')+'\n'+(error.stderr || ''),bytes,error.code));}
  }
  for(const row of report.attempts)if(row.reason==='local-size-limit' && !row.mtu && report.route.mtu){row.mtu=report.route.mtu;row.mtuSource='interface';}
  if(JSON.stringify(await route())!==JSON.stringify(report.route)){report.reason='route-changed';for(const row of report.attempts)Object.assign(row,{state:'unavailable',reason:'route-changed'});return report;}
  report.lowerBound=Math.max(0,...report.attempts.filter(row=>row.state==='ok').map(row=>row.packetBytes)) || null;
  report.reportedMtu=Math.min(Infinity,...report.attempts.filter(row=>row.state==='limited' && row.mtu).map(row=>row.mtu));if(!Number.isFinite(report.reportedMtu))report.reportedMtu=null;
  report.outcome=report.attempts.some(row=>row.state!=='unavailable')?'ok':'unavailable';
 }catch(error){signal?.throwIfAborted();report.reason=combined.aborted?'budget-exhausted':'route-unavailable';}
 return report;
}
