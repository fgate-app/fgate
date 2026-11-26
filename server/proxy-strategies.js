import {probeGatewayTcp} from './gateway-tunnel.js';
import {safeProxyFlow} from '../shared/proxy-flow-evidence.js';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {isIP} from 'node:net';
import {SsRelaySupervisor} from './ss-relay.js';
import {XraySupervisor} from './xray.js';
import {gatewayPeer} from './endpoint-diagnostics.js';
import {sendCommand} from './network-helper.js';
import {proxyStrategies} from './proxy-strategy-helper.js';
import {diagnosticDomainUrl} from '../shared/diagnostic-targets.js';

export const strategyTestPlan=Object.freeze([{id:'baseline-before',strategy:'baseline',label:'Without DPI bypass'},...proxyStrategies.filter(row=>row.desync).map(row=>({id:row.id,strategy:row.id,label:row.label})),{id:'baseline-after',strategy:'baseline',label:'Control check after strategies'}]);
const fingerprint=snapshot=>createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
const abort=()=>Object.assign(Error('Diagnostic cancelled.'),{code:'ABORTED'});

export function strategyRequest(port,url,{signal,spawnProcess=spawn}={}){
 return new Promise((resolve,reject)=>{
  if(signal?.aborted)return reject(abort());
  const child=spawnProcess('curl',['--disable','--config','-','--silent','--noproxy','','--proto','=https','--connect-timeout','4','--max-time','8','--max-filesize','1048576','--output','/dev/null','--write-out','%{json}'],{stdio:['pipe','pipe','ignore']});
  let raw='',done=false;
  const finish=(error,result)=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',cancel);error?reject(error):resolve(result);};
  const cancel=()=>{child.kill('SIGKILL');finish(abort());};
  const timer=setTimeout(()=>{child.kill('SIGKILL');finish(null,{state:'unavailable',reason:'timeout'});},10000);
  signal?.addEventListener('abort',cancel,{once:true});
  child.stdout.on('data',chunk=>{raw+=chunk;if(raw.length>65536){child.kill('SIGKILL');finish(null,{state:'unavailable',reason:'invalid-response'});}});
  child.on('error',()=>finish(null,{state:'unavailable',reason:'transport-unavailable'}));
  child.on('close',code=>{try{
   const value=JSON.parse(raw),status=Number(value.response_code ?? value.http_code),ok=code===0 && status>=200 && status<400 && Number(value.ssl_verify_result)===0 && Number(value.time_appconnect)>0;
   finish(null,{state:ok?'ok':'failed',reason:ok?null:code===28?'timeout':code===60?'certificate-error':code===35?'tls-error':'proxy-request-failed',httpStatus:Number.isInteger(status)?status:null,bytes:Math.min(Number(value.size_download) || 0,1048576)});
  }catch{finish(null,{state:'unavailable',reason:'invalid-response'});}});
  child.stdin.on('error',()=>{});child.stdin.end(`proxy = "socks5h://127.0.0.1:${port}"\nurl = ${JSON.stringify(url)}\n`);
 });
}

export async function probeProxyStrategy({snapshot,address,strategy,domain,signal,helper=sendCommand,request=strategyRequest,makeClient,workDir,tcpProbe=probeGatewayTcp,gateRepeats=1}){
 const peer=gatewayPeer(snapshot),lease=randomBytes(16).toString('hex');let client,prepared;
 const directory=await mkdtemp(join(workDir || tmpdir(),'fg-strategy-'));
 try{
  const relay=await helper({action:'diagnostic-strategy',op:'start',lease,address,port:peer.port,strategy,capture:strategy==='baseline'},{signal,timeout:18000});
  if(!relay?.ok || !Number.isInteger(relay.port) || typeof relay.password!=='string')throw Error('Diagnostic relay unavailable.');
  if(signal?.aborted)throw abort();
  let tcpControl;const tcpAttempts=[];
  for(let repeat=1;repeat<=Math.min(2,Math.max(1,gateRepeats));repeat++){
   tcpControl=await tcpProbe(relay,{address,port:peer.port},{signal});tcpAttempts.push(tcpControl);if(tcpControl.state==='ok')break;
  }
  if(tcpControl.state!=='ok'){
   const stats=await helper({action:'diagnostic-strategy',op:'stats',lease},{signal,timeout:2000});
   const records=stats.records || [],confirmed=records.length>0 && records.every(row=>row.state==='failed' && row.routeVerified);
   return {state:confirmed?'failed':'unavailable',reason:confirmed?'endpoint-tcp-unreachable':'tcp-gate-unconfirmed',tcpControl:{...tcpControl,attempts:tcpAttempts},flows:records.map(safeProxyFlow),attempts:[]};
  }
  const resolve=async()=>[{address,family:isIP(address)}];
  client=makeClient?makeClient({snapshot,directory,resolve}):snapshot.config.engine==='outline'?new SsRelaySupervisor({stateDir:directory,resolve}):new XraySupervisor({stateDir:directory,resolve});
  const attempts=[];
  for(let repeat=1;repeat<=2;repeat++){
   const id='diagnostic-'+lease+'-'+repeat;
   prepared=await client.prepare([{...snapshot.config,profile_id:id,dpiBypass:false,wrapEndpoint:{port:relay.port,username:relay.username,password:relay.password}}]);
   if(signal?.aborted)throw abort();
   // Each repeat gets a fresh native client and upstream connection. Never commit.
   const port=prepared.bridges[id].port;
   const before=await helper({action:'diagnostic-strategy',op:'stats',lease},{signal,timeout:2000});
   const result=await request(port,diagnosticDomainUrl(domain),{signal});
   const after=await helper({action:'diagnostic-strategy',op:'stats',lease},{signal,timeout:2000});
   const records=(after.records || []).slice((before.records || []).length);
   const verified=records.length>0 && records.every(row=>row.routeVerified===true) && records.some(row=>row.sentBytes>0 && row.receivedBytes>0);
   await prepared.rollback();prepared=null;
   attempts.push({...result,repeat,flows:records.map(safeProxyFlow),pathObservation:{state:verified?'verified':'unavailable',scope:'isolated-client-fixed-endpoint-relay'},...(result.state==='ok' && !verified?{state:'unavailable',reason:'path-unverified'}:{})});
  }
  return {state:attempts.every(row=>row.state==='ok')?'ok':attempts.some(row=>row.state==='ok')?'partial':attempts.every(row=>row.state==='failed')?'failed':'unavailable',attempts};
 }catch(error){if(signal?.aborted || error.code==='ABORTED')throw abort();return {state:'unavailable',reason:'strategy-probe-unavailable',attempts:[]};}
 finally{
  await prepared?.rollback().catch(()=>{});await client?.stop().catch(()=>{});
  await helper({action:'diagnostic-strategy',op:'stop',lease},{timeout:5000}).catch(()=>{});
  await rm(directory,{recursive:true,force:true});
 }
}

export async function diagnoseProxyStrategies({snapshot,endpoint,domain,signal,onProgress=()=>{},isCurrent=()=>true,probe=probeProxyStrategy,budgetMs=120000}){
 const supported=['outline','xray'].includes(snapshot?.config?.engine) && !snapshot?.profile?.gateway_id;
 const addresses=[...new Set(endpoint?.addresses || [])].filter(address=>isIP(address));
 if(!supported || !addresses.length)return {state:'unavailable',outcome:'unavailable',reason:!supported?'unsupported-strategy-client':'endpoint-address-unavailable',results:[],limits:{budgetSeconds:budgetMs/1000}};
 const expired=new AbortController(),combined=signal?AbortSignal.any([signal,expired.signal]):expired.signal,timer=setTimeout(()=>expired.abort(),budgetMs);timer.unref?.();
 const initial=fingerprint(snapshot),report={state:'running',outcome:'unavailable',domain,addresses:addresses.slice(0,2),results:[],limits:{budgetSeconds:budgetMs/1000,maxAddresses:2,repeats:2,maxResponseBytes:1048576},recommendations:[]};
 report.results=report.addresses.flatMap(address=>strategyTestPlan.map(entry=>({...entry,address,state:'pending',attempts:[]})));
 onProgress(structuredClone(report));
 try{
  for(const address of report.addresses){
   for(const entry of strategyTestPlan){
    if(signal?.aborted)throw abort();
    if(combined.aborted)break;
    const result=report.results.find(row=>row.address===address && row.id===entry.id);result.state='running';onProgress(structuredClone(report));
    if(entry.strategy!=='baseline'){
     const baseline=report.results.find(row=>row.address===address && row.id==='baseline-before');
     if(baseline.state!=='failed' || baseline.reason==='endpoint-tcp-unreachable'){result.state='unavailable';result.reason=baseline.reason==='endpoint-tcp-unreachable'?'endpoint-tcp-unreachable':baseline.state==='ok' || baseline.state==='partial'?'baseline-working':'baseline-inconclusive';onProgress(structuredClone(report));continue;}
    }
    if(!isCurrent(initial)){report.reason='configuration-changed';break;}
    const started=Date.now();
    try{Object.assign(result,await probe({snapshot,address,strategy:entry.strategy,domain,signal:combined}));}
    catch(error){if(signal?.aborted)throw error;Object.assign(result,{state:'unavailable',reason:combined.aborted?'budget-exhausted':'strategy-probe-unavailable'});}
    result.durationMs=Date.now()-started;
    if(!isCurrent(initial)){report.reason='configuration-changed';result.state='unavailable';result.reason='configuration-changed';}
    onProgress(structuredClone(report));
    if(report.reason==='configuration-changed')break;
   }
   if(report.reason==='configuration-changed' || combined.aborted)break;
  }
  report.state='completed';if(expired.signal.aborted)report.reason='budget-exhausted';
  if(!report.reason)for(const address of report.addresses){
   const rows=report.results.filter(row=>row.address===address),before=rows.find(row=>row.id==='baseline-before'),after=rows.find(row=>row.id==='baseline-after');
   // Recommend only reproducible improvements against two failed baselines.
   if(before?.state==='failed' && after?.state==='failed' && before.reason!=='endpoint-tcp-unreachable' && after.reason!=='endpoint-tcp-unreachable')report.recommendations.push(...rows.filter(row=>row.strategy!=='baseline' && row.state==='ok').map(row=>({address,strategy:row.strategy})));
  }
  for(const result of report.results)if(result.state==='pending' || report.reason==='configuration-changed'){result.state='unavailable';result.reason=report.reason || 'not-run';}
  report.outcome=report.reason?'unavailable':report.recommendations.length?'ok':report.results.some(row=>row.state==='ok')?'partial':report.results.every(row=>row.state==='failed')?'failed':'unavailable';onProgress(structuredClone(report));return report;
 }finally{clearTimeout(timer);}
}
export const proxySnapshotFingerprint=fingerprint;
