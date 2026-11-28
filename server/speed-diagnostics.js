import {runJsonWorker,gatewayCurlConfig} from './json-worker.js';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {allocateDiagnosticTcpPort} from './diagnostic-port.js';
import {diagnosticPath} from './gateway-diagnostics.js';
export const speedLimits=Object.freeze({budgetMs:45000,requestMs:12000,downloadBytes:8*1048576,uploadBytes:2*1048576,latencySamples:3});
export const speedSamples=Object.freeze([...Array.from({length:3},(_,index)=>Object.freeze({id:'latency-'+index,kind:'latency',bytes:0})),Object.freeze({id:'download',kind:'download',bytes:speedLimits.downloadBytes}),Object.freeze({id:'upload',kind:'upload',bytes:speedLimits.uploadBytes})]);
const sampleUrl=sample=>'https://speed.cloudflare.com/'+(sample.kind==='upload'?'__up':'__down?bytes='+sample.bytes);
export function requestSpeedSample(endpoint,sample,{signal,localPort,timeoutMs=speedLimits.requestMs,spawnProcess=spawn}={}){
 return (async()=>{
  if(!speedSamples.some(row=>row.id===sample?.id && row.kind===sample.kind && row.bytes===sample.bytes) || !Number.isInteger(localPort) || localPort<1024 || localPort>65535)throw Error('Invalid speedtest request.');
  if(signal?.aborted)throw Object.assign(Error('Diagnostic cancelled.'),{code:'ABORTED'});
  const budget=Math.max(1,Math.min(speedLimits.requestMs,timeoutMs));let folder,uploadFile;
  try{
   if(sample.kind==='upload'){folder=mkdtempSync(join(tmpdir(),'fg-speed-upload-'));uploadFile=join(folder,'payload');writeFileSync(uploadFile,randomBytes(sample.bytes),{mode:0o600});}
   const {value,exitCode}=await runJsonWorker('curl',['--disable','--config','-','--silent','--noproxy','','--proto','=https','--local-port',String(localPort),'--connect-timeout',String(Math.min(4,budget/1000)),'--max-time',String(budget/1000),'--max-filesize',String(sample.kind==='download'?sample.bytes:65536),'--header','Accept-Encoding: identity',...(sample.kind==='upload'?['--request','POST','--data-binary','@'+uploadFile,'--header','Content-Type: application/octet-stream','--header','Expect:']:[]),'--output','/dev/null','--write-out','%{json}'],{input:gatewayCurlConfig(endpoint,sampleUrl(sample)),signal,spawnProcess,timeoutMs:budget+500});return {...value,exitCode};
  }catch(error){if(error.code==='ABORTED')throw error;if(error.code==='TIMEOUT')return {exitCode:28};throw Error(error.code==='INVALID_RESPONSE'?'Invalid speedtest response.':'Speedtest transport is unavailable.');}
  finally{if(folder)rmSync(folder,{recursive:true,force:true});}
 })();
}
const verified=row=>row?.pathObservation?.state==='verified';
export function speedSampleResult(raw,sample){
 const status=Number(raw.response_code ?? raw.http_code),bytes=Number(sample.kind==='upload'?raw.size_upload:raw.size_download);
 const completed=raw.exitCode===0 && bytes===sample.bytes,partial=sample.kind==='download' && raw.exitCode===28 && bytes>=65536 && bytes<sample.bytes;
 const valid=(completed || partial) && Number(raw.http_connect)===200 && Number(raw.ssl_verify_result)===0 && Number(raw.time_appconnect)>0 && status>=200 && status<300;
 const responseSeconds=Number(raw.time_starttransfer)-Number(raw.time_pretransfer),transferSeconds=sample.kind==='download'?Number(raw.time_total)-Number(raw.time_starttransfer):responseSeconds;
 const timing=sample.kind==='latency'?Number.isFinite(responseSeconds) && responseSeconds>=0:Number.isFinite(transferSeconds) && transferSeconds>0;
 return {id:sample.id,kind:sample.kind,expectedBytes:sample.bytes,bytes:Number.isFinite(bytes)?bytes:0,httpStatus:status || null,outcome:valid && timing?'ok':'failed',observation:valid && timing?(partial?'measured-with-time-limit':'measured'):raw.exitCode===28?'timeout':raw.exitCode===60?'certificate-error':status>=300 && status<400?'unexpected-redirect':'measurement-incomplete',responseMs:valid && timing?Math.round(responseSeconds*1000):null,mbps:valid && timing && sample.kind!=='latency'?Number((bytes*8/transferSeconds/1e6).toFixed(2)):null,durationMs:Number.isFinite(raw.time_total)?Math.round(raw.time_total*1000):null};
}
export function speedMetrics(attempts){
 const eligible=attempts.filter(row=>row.outcome==='ok' && verified(row)),latency=eligible.filter(row=>row.kind==='latency').map(row=>row.responseMs).sort((a,b)=>a-b);
 return {downloadMbps:eligible.find(row=>row.kind==='download')?.mbps ?? null,uploadMbps:eligible.find(row=>row.kind==='upload')?.mbps ?? null,responseMs:latency.length?latency[Math.floor(latency.length/2)]:null};
}
export async function diagnoseSpeed({id,profiles,endpoint,signal,observe,isCurrent=()=>true,request=requestSpeedSample,allocatePort=allocateDiagnosticTcpPort,now=Date.now,onProgress=()=>{}}){
 const path=diagnosticPath(profiles,id);if(!endpoint)throw Error('The selected gateway listener is unavailable.');
 const expired=new AbortController(),changed=new AbortController(),combined=AbortSignal.any([expired.signal,changed.signal,...(signal?[signal]:[])]),deadline=now()+speedLimits.budgetMs;
 const timer=setTimeout(()=>expired.abort(),speedLimits.budgetMs);timer.unref();
 const check=()=>{try{if(!isCurrent())changed.abort();}catch{changed.abort();}};check();const watcher=setInterval(check,100);watcher.unref();
 const attempts=[],report={provider:'Cloudflare',state:'running',path,attempts,metrics:speedMetrics(attempts),limits:speedLimits,outcome:'unavailable'};
 const snapshot=()=>{report.metrics=speedMetrics(attempts);onProgress(structuredClone(report));};snapshot();
 try{for(const sample of speedSamples){
  if(signal?.aborted)throw Object.assign(Error('Diagnostic cancelled.'),{code:'ABORTED'});
  check();let row={id:sample.id,kind:sample.kind,outcome:'unavailable',observation:changed.signal.aborted?'configuration-changed':'budget-exhausted',mbps:null,responseMs:null},observer,raw;
  if(!combined.aborted && now()<deadline)try{
   const localPort=await allocatePort({signal:combined});observer=await observe?.({endpoint,url:sampleUrl(sample),localPort,signal:combined});
   raw=await request(endpoint,sample,{signal:combined,localPort,timeoutMs:Math.max(1,Math.min(speedLimits.requestMs,deadline-now()))});
   row=speedSampleResult(raw,sample);const pending=observer;observer=null;row.pathObservation=pending?await pending.finish(raw):{state:'unavailable'};
   if(!verified(row))Object.assign(row,{outcome:row.pathObservation.state==='mismatch'?'failed':'unavailable',observation:row.pathObservation.state==='mismatch'?'path-mismatch':'path-unverified',mbps:null,responseMs:null});
  }catch(error){if(signal?.aborted)throw error;row.observation=changed.signal.aborted?'configuration-changed':expired.signal.aborted?'budget-exhausted':'transport-unavailable';}
  finally{await observer?.finish(raw);}
  attempts.push(row);snapshot();
 }}finally{clearTimeout(timer);clearInterval(watcher);}
 check();if(changed.signal.aborted){path.configChanged=true;for(const row of attempts)Object.assign(row,{outcome:'unavailable',observation:'configuration-changed',mbps:null,responseMs:null,pathObservation:{state:'unavailable'}});}
 report.state='completed';report.metrics=speedMetrics(attempts);report.outcome=attempts.every(row=>row.outcome==='ok')?'ok':attempts.some(row=>row.outcome==='ok')?'partial':'unavailable';return report;
}
