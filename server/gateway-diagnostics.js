import {runJsonWorker,gatewayCurlConfig} from './json-worker.js';
import {followDiagnosticRedirects,validRedirectUrl,redirectLimits} from './diagnostic-redirects.js';
import {validDiagnosticUrl} from '../shared/diagnostic-targets.js';
import {spawn} from 'node:child_process';
import {httpHealthUrls} from './http-health.js';
import {gatewayChainAvailable} from '../shared/gateway-wrap.js';
import {allocateDiagnosticTcpPort} from './diagnostic-port.js';

export const httpsDiagnosticLimits=Object.freeze({portAllocationSeconds:2,attempts:httpHealthUrls.length,connectSeconds:4,attemptSeconds:8,workerSeconds:10,maxResponseBytes:1048576});
// Reuse the authenticated, outbound-pinned listeners used for gateway location.
// A curl failure never retries over the host's default route.
export function diagnosticPath(profiles, id) {
  if (!gatewayChainAvailable(profiles,id)) throw Error('The gateway or its chain is unavailable.');
  const chain=[];
  let profile=profiles.find(row=>row.id===id);
  while(profile){chain.push({id:profile.id,engine:profile.engine});profile=profiles.find(row=>row.id===profile.gatewayId);}
  if(chain.some(row=>row.engine==='block'))throw Error('A blocking route cannot be tested.');
  return {mode:chain[0].engine==='direct'?'direct':chain.length>1?'chain':'gateway',chain,
    enforcement:'authenticated-listener',observedRoute:null,routeVerified:false};
}

export function requestDiagnostic(endpoint,url,{signal,spawnProcess=spawn,localPort,redirectHop=false,timeoutMs=httpsDiagnosticLimits.attemptSeconds*1000}={}) {
  return (async()=>{
    if(!httpHealthUrls.includes(url) && !validDiagnosticUrl(url) && !(redirectHop && validRedirectUrl(url)))throw Error('Invalid diagnostic target.');
    if(localPort!==undefined && (!Number.isInteger(localPort) || localPort<1024 || localPort>65535))throw Error('Invalid local port.');
    try{const {value,exitCode}=await runJsonWorker('curl',['--disable','--config','-','--silent','--noproxy','','--proto','=https',
      ...(localPort?['--local-port',String(localPort)]:[]),
      '--connect-timeout',String(httpsDiagnosticLimits.connectSeconds),'--max-time',String(Math.min(httpsDiagnosticLimits.attemptSeconds,timeoutMs/1000)),'--max-filesize',String(httpsDiagnosticLimits.maxResponseBytes),'--output','/dev/null','--write-out','%{json}'],{input:gatewayCurlConfig(endpoint,url),signal,spawnProcess,timeoutMs:httpsDiagnosticLimits.workerSeconds*1000});return {...value,exitCode};}
    catch(error){if(error.code==='ABORTED')throw error;throw Object.assign(Error(error.code==='TIMEOUT'?'Diagnostic timed out.':error.code==='INVALID_RESPONSE'?'Invalid transport response.':'Diagnostic transport is unavailable.'),{code:error.code==='TIMEOUT'?'TIMEOUT':'UNAVAILABLE'});}
  })();
}

const milliseconds=value=>Number.isFinite(value) && value>=0?Math.round(value*1000):null;
export function diagnosticAttempt(raw,url,startedAt) {
  const code=Number.isInteger(raw.exitCode)?raw.exitCode:null;
  const connected=Number(raw.http_connect)===200;
  const tls=Number(raw.time_appconnect)>0;
  const status=Number(raw.response_code ?? raw.http_code) || null;
  const bytes=Number(raw.size_download) || 0;
  const stage=(id,state,extra={})=>({id,state,...extra});
  return {startedAt,url,exitCode:code,durationMs:milliseconds(raw.time_total),
    outcome:code===0 && status>=200 && status<300?'ok':'failed',
    observation:code===28?'timeout':code===60?'certificate-error':code===35?'tls-error':code===7?'connect-error':code===0?'http-response':'transport-error',
    stages:[
      stage('bootstrap-dns','unavailable',{reason:'Resolution is performed by the selected engine; not measured separately.'}),
      stage('proxy-connect',connected?'ok':'failed',{status:Number(raw.http_connect)||null,durationMs:milliseconds(raw.time_connect)}),
      stage('tunnel-protocol','unavailable',{reason:'An independent tunnel handshake is not observable through this listener.'}),
      stage('tls',tls?'ok':connected?'failed':'skipped',{durationMs:milliseconds(raw.time_appconnect)}),
      stage('http',status?'ok':tls?'failed':'skipped',{status}),
      stage('transfer',code===0 && status?'ok':status?'failed':'skipped',{bytes}),
    ]};
}

export async function diagnoseGateway({profiles,id,endpoint,signal,request=requestDiagnostic,now=Date.now,observe=null,allocatePort=allocateDiagnosticTcpPort,targets=httpHealthUrls}) {
  const path=diagnosticPath(profiles,id);
  if(!endpoint)throw Error('The selected gateway listener is unavailable.');
  const startedAt=new Date(now()).toISOString(),attempts=[];
  for(const url of targets){
    if(signal?.aborted)throw Object.assign(Error('Diagnostic cancelled.'),{code:'ABORTED'});
    const time=new Date(now()).toISOString();
    try{
      attempts.push(await followDiagnosticRedirects(url,async(current,options)=>{
        let observer,raw;
        try{
          const localPort=observe?await allocatePort({signal}):undefined;
          if(observe)observer=await observe({endpoint,url:current,localPort,signal});
          raw=await request(endpoint,current,{signal,localPort,...options});
          const row=diagnosticAttempt(raw,current,time);
          if(observer){const pending=observer;observer=null;row.pathObservation=await pending.finish(raw,{sampleFinal:true});}
          return {raw,row};
        }finally{await observer?.finish(raw);}
      },{signal,now}));
    }catch(error){
      if(error.code==='ABORTED')throw error;
      attempts.push({startedAt:time,url,outcome:'unavailable',observation:error.code==='TIMEOUT'?'timeout':'transport-unavailable',stages:[]});
    }
  }
  path.engineVerified=attempts.length>0 && attempts.every(attempt=>attempt.pathObservation?.state==='verified');
  path.verificationScope='selected-listener-outbound';
  return {version:1,limits:{...httpsDiagnosticLimits,maxRedirects:redirectLimits.maxRedirects,targetBudgetSeconds:redirectLimits.budgetMs/1000,attempts:targets.length},profileId:id,startedAt,finishedAt:new Date(now()).toISOString(),path,attempts,
    outcome:attempts.every(row=>row.outcome==='ok')?'ok':attempts.some(row=>row.outcome==='ok')?'partial':attempts.every(row=>row.outcome==='unavailable')?'unavailable':'failed',
    diagnosis:{cause:null,confidence:'undetermined'}};
}
