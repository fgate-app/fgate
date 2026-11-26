import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {isIP} from 'node:net';
const execute=promisify(execFile);
const canonicalAddress=address=>isIP(address)===6?new URL(`http://[${address}]/`).hostname:address;
export const endpointRouteLimits=Object.freeze({maxHops:16,queriesPerHop:1,waitSeconds:.4,maxAddresses:2,budgetSeconds:16});
export function traceArguments(address,port,interfaceName){
 if(!isIP(address) || !Number.isInteger(port) || port<1 || port>65535 || !/^[a-zA-Z0-9_.:-]{1,15}$/.test(interfaceName))throw Error('Invalid endpoint route parameters.');
 return [isIP(address)===6?'-6':'-4','-T','-n','-m','16','-q','1','-w','0.4','-N','1','-i',interfaceName,'--fwmark=0x40000000','-p',String(port),address];
}
export function parseEndpointRoute(text,address){
 const hops=[];
 for(const line of String(text).split('\n')){
  const match=/^\s*(\d+)\s+(.+)$/.exec(line);if(!match)continue;
  const ttl=Number(match[1]);if(ttl<1 || ttl>16 || hops.some(row=>row.ttl===ttl))continue;
  const tokens=match[2].trim().split(/\s+/),ip=tokens.find(token=>isIP(token)),rtt=/\b(\d+(?:\.\d+)?)\s+ms\b/.exec(match[2]),annotation=tokens.find(token=>/^![A-Z0-9<>-]+$/.test(token));
  hops.push({ttl,state:ip?'reply':'no-response',...(ip?{address:ip}:{}),...(rtt?{rttMs:Number(rtt[1])}:{}),...(annotation?{annotation}:{})});
 }
 const reached=hops.find(hop=>hop.address && canonicalAddress(hop.address)===canonicalAddress(address) && !hop.annotation),lastReply=[...hops].reverse().find(hop=>hop.state==='reply');
 return {address,state:hops.length?'completed':'unavailable',targetReached:!!reached,hopCount:reached?.ttl ?? null,lastReplyTtl:lastReply?.ttl ?? null,hops,reason:reached?null:hops.length?'target-not-reached':'trace-unavailable'};
}
export async function traceEndpointRoute({addresses,port,interfaceName,signal,run=execute}){
 if(!Array.isArray(addresses) || !addresses.length || addresses.length>2)throw Error('Invalid endpoint route targets.');
 const results=[];
 for(const address of addresses){
  const args=traceArguments(address,port,interfaceName);
  try{const result=await run('traceroute',args,{signal,timeout:7500,maxBuffer:16384,env:{...process.env,LC_ALL:'C'}});results.push(parseEndpointRoute(result.stdout,address));}
  catch(error){if(signal?.aborted)throw Object.assign(Error('Diagnostic cancelled.'),{code:'ABORTED'});const partial=parseEndpointRoute(error.stdout || '',address);results.push(partial.hops.length?{...partial,incomplete:true,reason:'trace-interrupted'}:{address,state:'unavailable',reason:error.code==='ENOENT'?'traceroute-unavailable':'trace-unavailable',targetReached:false,hopCount:null,hops:[]});}
 }
 return {state:results.some(row=>row.state==='completed')?'completed':'unavailable',mode:'tcp-syn-direct-uplink',port,results,limits:endpointRouteLimits};
}
