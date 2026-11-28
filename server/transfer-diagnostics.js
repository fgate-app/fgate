import {runJsonWorker,gatewayCurlConfig} from './json-worker.js';
import {followDiagnosticRedirects,validRedirectUrl} from './diagnostic-redirects.js';
import {validDiagnosticUrl,diagnosticTargetLimits} from '../shared/diagnostic-targets.js';
import {spawn} from 'node:child_process';
import {diagnosticPath} from './gateway-diagnostics.js';
import {allocateDiagnosticTcpPort} from './diagnostic-port.js';

// The fixed-size download API is documented by cloudflare/speedtest. No user URL,
// redirects, retries, compression, or direct fallback are allowed for fixed files.
// Website samples follow bounded redirects with evidence from every hop.
export const transferTargets=Object.freeze([65536,1048576].map(bytes=>Object.freeze({bytes,url:`https://speed.cloudflare.com/__down?bytes=${bytes}`})));
export function requestTransfer(endpoint,target,{signal,localPort,timeoutMs=12000,spawnProcess=spawn,redirectHop=false}={}){
  return (async()=>{
    if(!transferTargets.some(row=>row.url===target?.url && row.bytes===target?.bytes) && !(target?.mode==='site-response' && target.bytes===diagnosticTargetLimits.maxSampleBytes && (validDiagnosticUrl(target.url) || (redirectHop && validRedirectUrl(target.url)))))throw Error('Invalid transfer target.');
    if(!Number.isInteger(localPort) || localPort<1024 || localPort>65535)throw Error('Invalid local port.');
    const budget=Math.max(1,Math.min(12000,timeoutMs));let receivedBytes=0,oversized=false;
    try{const {value,exitCode}=await runJsonWorker('curl',['--disable','--config','-','--silent','--noproxy','','--proto','=https','--local-port',String(localPort),
      '--connect-timeout',String(Math.min(4,budget/1000)),'--max-time',String(budget/1000),
      ...(target.mode==='site-response'?['--range',`0-${target.bytes-1}`]:[]),'--max-filesize',String(target.bytes),'--header','Accept-Encoding: identity','--output','-','--write-out','%{stderr}%{json}'],{input:gatewayCurlConfig(endpoint,target.url),signal,spawnProcess,timeoutMs:budget+500,jsonStream:'stderr',onBody:chunk=>{receivedBytes+=chunk.length;if(receivedBytes>target.bytes){oversized=true;return false;}}});return {...value,exitCode,receivedBytes,oversized};}
    catch(error){if(error.code==='ABORTED')throw error;if(error.code==='TIMEOUT')return {exitCode:28,receivedBytes,observation:'timeout'};if(error.code==='INVALID_RESPONSE' && !error.limitExceeded && oversized)return {exitCode:63,receivedBytes,oversized:true};throw Error(error.code==='INVALID_RESPONSE'?'Invalid transfer response.':'Transfer transport is unavailable.');}
  })();
}
const ms=value=>Number.isFinite(value) && value>=0?Math.round(value*1000):null;
export function transferAttempt(raw,target){
  const bytes=Number.isSafeInteger(raw.receivedBytes) && raw.receivedBytes>=0?raw.receivedBytes:0;
  const status=Number(raw.response_code ?? raw.http_code)||null,connected=Number(raw.http_connect)===200;
  const tls=Number(raw.time_appconnect)>0 && Number(raw.ssl_verify_result)===0;
  const type=typeof raw.content_type==='string'?raw.content_type.split(';')[0].trim().toLowerCase():null;
  const durationMs=ms(raw.time_total),ttfbMs=status?ms(raw.time_starttransfer):null;
  if(target.mode==='site-response'){
    const complete=raw.exitCode===0 && !raw.oversized && connected && tls && [200,204,206].includes(status);
    return {url:target.url,domain:target.domain,mode:target.mode,maxBytes:target.bytes,bytes,httpStatus:status,contentType:type,ttfbMs,durationMs,bytesPerSecond:null,certificateVerification:true,complete,outcome:complete?'ok':raw.exitCode===63 || raw.oversized || (status>=300 && status<400)?'unavailable':'failed',observation:complete?'site-response-received':status>=300 && status<400?'redirect-not-followed':raw.exitCode===63 || raw.oversized?'response-exceeds-sample-limit':raw.exitCode===28?'timeout':'site-response-incomplete'};
  }
  const observation=raw.oversized || raw.exitCode===63?'response-too-large':raw.exitCode===28?'timeout':raw.exitCode===60?'certificate-error':
    !connected?'connect-error':!tls?'tls-error':status!==200?'http-rejection':bytes!==target.bytes?'size-mismatch':type!=='application/octet-stream'?'unexpected-content-type':raw.exitCode!==0?'transport-error':'complete-transfer';
  const complete=observation==='complete-transfer';
  return {url:target.url,expectedBytes:target.bytes,bytes,httpStatus:status,contentType:type,ttfbMs,durationMs,
    // Average end-to-end throughput includes CONNECT, TLS and TTFB.
    bytesPerSecond:complete && raw.time_total>0?Math.round(bytes/raw.time_total):null,
    certificateVerification:true,complete,outcome:complete?'ok':'failed',observation};
}
export async function diagnoseTransfer({id,profiles,endpoint,signal,observe,isCurrent=()=>true,request=requestTransfer,allocatePort=allocateDiagnosticTcpPort,now=Date.now,targets=transferTargets}){
  const path=diagnosticPath(profiles,id);
  if(!endpoint)throw Error('The selected gateway listener is unavailable.');
  const invalidated=new AbortController(),budgetExpired=new AbortController(),combined=AbortSignal.any([invalidated.signal,budgetExpired.signal,...(signal?[signal]:[])]);
  const budgetTimer=setTimeout(()=>budgetExpired.abort(),26000);budgetTimer.unref();
  const check=()=>{try{if(!isCurrent())invalidated.abort();}catch{invalidated.abort();}};
  const deadline=now()+26000,attempts=[];check();const watcher=setInterval(check,100);watcher.unref();
  try{for(const target of targets){
    if(signal?.aborted)throw Object.assign(Error('Diagnostic cancelled.'),{code:'ABORTED'});
    check();let row={url:target.url,expectedBytes:target.bytes,outcome:'unavailable',complete:false,observation:invalidated.signal.aborted?'configuration-changed':'budget-exhausted'};
    if(!combined.aborted && now()<deadline){
      const probe=async(current,options={})=>{
        let observer,raw;
        try{
          const localPort=await allocatePort({signal:combined});observer=await observe?.({endpoint,url:current,localPort,signal:combined});
          check();if(combined.aborted)throw Error('Configuration changed.');
          const timeoutMs=Math.min(12000,Math.max(1,deadline-now()),options.timeoutMs || 12000);
          const destination={...target,url:current};raw=await request(endpoint,destination,{signal:combined,localPort,timeoutMs,redirectHop:options.redirectHop});
          const row=transferAttempt(raw,destination);row.limits={timeoutMs,maxResponseBytes:target.bytes};const pending=observer;observer=null;row.pathObservation=pending?await pending.finish(raw):{state:'unavailable'};
          if(row.pathObservation.state==='mismatch')Object.assign(row,{outcome:'failed',complete:false,observation:'path-mismatch',bytesPerSecond:null});
          return {raw,row};
        }finally{await observer?.finish(raw);}
      };
      try{row=target.mode==='site-response'?await followDiagnosticRedirects(target.url,probe,{signal:combined,now,budgetMs:Math.max(1,deadline-now())}):(await probe(target.url)).row;}
      catch(error){if(signal?.aborted)throw error;Object.assign(row,{outcome:'unavailable',complete:false,bytesPerSecond:null,observation:invalidated.signal.aborted?'configuration-changed':budgetExpired.signal.aborted?'budget-exhausted':'transport-unavailable'});}
    }
    attempts.push(row);
  }}finally{clearInterval(watcher);clearTimeout(budgetTimer);}
  check();if(invalidated.signal.aborted){path.configChanged=true;for(const row of attempts)Object.assign(row,{outcome:'unavailable',complete:false,bytesPerSecond:null,observation:'configuration-changed',pathObservation:{state:'unavailable',reason:'configuration-changed'}});}
  path.engineVerified=attempts.every(row=>row.pathObservation?.state==='verified');
  return {ok:true,path,attempts,outcome:attempts.every(row=>row.complete)?'ok':attempts.some(row=>row.complete)?'partial':attempts.every(row=>row.outcome==='unavailable')?'unavailable':'failed',
    limits:{portAllocationSeconds:2,attempts:targets.length,budgetSeconds:26,attemptSeconds:12,...(targets.some(row=>row.mode==='site-response')?{maxSampleBytes:1048576}:{expectedBodyBytes:1114112})},diagnosis:{cause:null,confidence:'undetermined'}};
}
