import {runJsonWorker} from './json-worker.js';
import dgram from 'node:dgram';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {dnsMatrixProviders,normalizeDnsMatrixName} from './dns-matrix-catalog.js';
import {diagnosticPath} from './gateway-diagnostics.js';
import {allocateDiagnosticTcpPort} from './diagnostic-port.js';

export async function allocateSourcePort(network,options){
  if(network!=='udp')return allocateDiagnosticTcpPort(options);
  const socket=dgram.createSocket('udp4');
  try{return await new Promise((resolve,reject)=>{socket.once('error',reject);socket.bind(0,'127.0.0.1',()=>resolve(socket.address().port));});}
  finally{socket.close();}
}

// Credentials travel over stdin only; errors and stderr never enter the report.
export function requestGatewayDns(request,{signal,spawnProcess=spawn,worker='dns'}={}){
  return (async()=>{
    if(!['dns','sni','tls','h3'].includes(worker))throw Error('Invalid diagnostic worker.');
    try{const {value,exitCode}=await runJsonWorker('python3',[fileURLToPath(new URL(worker==='h3'?'./http3-probe.py':worker==='tls'?'./tls-versions.py':worker==='sni'?'./sni-probe.py':'./dns-matrix.py',import.meta.url)),worker==='sni'?'--gateway':'--gateway-attempt'],{input:JSON.stringify(request),signal,spawnProcess,timeoutMs:8000});if(exitCode!==0)throw Object.assign(Error(),{code:'INVALID_RESPONSE'});return value;}
    catch(error){if(error.code==='ABORTED')throw error;throw Error(error.code==='TIMEOUT'?'DNS gateway probe timed out.':error.code==='INVALID_RESPONSE'?'Invalid DNS gateway response.':'DNS gateway transport is unavailable.');}
  })();
}
const verified=row=>row.state==='ok' && !row.truncated && (row.routeVerified===true || row.pathObservation?.state==='verified');
const signature=row=>JSON.stringify([row.rcode,(row.answers || []).map(answer=>[answer.name,answer.type,answer.value]).map(JSON.stringify).sort()]);
export function compareDnsPaths(direct,gateway){
  if(!direct?.ok || !gateway?.ok || direct.name!==gateway.name || (direct.family || 4)!==(gateway.family || 4))return [];
  return (gateway.providers || []).flatMap(provider=>['A','AAAA'].flatMap(qtype=>['udp','tcp','dot','doh'].map(transport=>{
    const select=report=>(report.attempts || []).filter(row=>row.provider===provider.id && row.qtype===qtype && row.transport===transport);
    const left=select(direct),right=select(gateway),valid=[...left,...right].filter(verified);
    const complete=left.length===2 && right.length===2 && valid.length===4;
    return {provider:provider.id,qtype,transport,state:!complete?'incomplete':new Set(valid.map(signature)).size>1?'different':'matched',
      validResponses:valid.length,expectedResponses:4,cause:null};
  })));
}

export async function diagnoseGatewayDns({id,profiles,endpoint,name,providers,signal,observe,request=requestGatewayDns,allocatePort=allocateSourcePort,isCurrent=()=>true,now=Date.now,family=4,transports=['udp','tcp','dot','doh']}){
  if(!Array.isArray(transports) || !transports.length || new Set(transports).size!==transports.length || transports.some(value=>!['udp','tcp','dot','doh'].includes(value)))throw Error('Invalid DNS transports.');
  name=normalizeDnsMatrixName(name);const selected=dnsMatrixProviders(providers,family),path=diagnosticPath(profiles,id);
  if(!endpoint)throw Error('The selected gateway listener is unavailable.');
  const jobs=selected.flatMap(provider=>['A','AAAA'].flatMap(qtype=>transports.flatMap(transport=>[1,2].map(repeat=>({provider,qtype,transport,repeat})))));
  const attempts=new Array(jobs.length),deadline=now()+35000,invalidated=new AbortController();let next=0;
  const callerSignal=signal;signal=signal?AbortSignal.any([signal,invalidated.signal]):invalidated.signal;
  const check=()=>{try{if(!isCurrent())invalidated.abort();}catch{invalidated.abort();}};
  check();const watcher=setInterval(check,100);watcher.unref();
  try{
  await Promise.all(Array.from({length:4},async()=>{
    while(next<jobs.length){
      const index=next++,job=jobs[index],target=job.provider.endpoints[job.transport];
      const base={family,provider:job.provider.id,qtype:job.qtype,transport:job.transport,repeat:job.repeat,address:target.address,port:target.port,routeVerified:false,state:'unavailable'};
      if(callerSignal?.aborted)throw Object.assign(Error('Diagnostic cancelled.'),{code:'ABORTED'});
      check();
      if(invalidated.signal.aborted){attempts[index]={...base,reason:'configuration-changed'};continue;}
      if(now()>deadline){attempts[index]={...base,reason:'budget-exhausted'};continue;}
      if(!target.address){attempts[index]={...base,reason:'resolver-ipv6-unavailable'};continue;}
      let observer,raw;
      try{
        const network=job.transport==='udp'?'udp':'tcp',localPort=await allocatePort(network,{signal});
        observer=await observe?.({endpoint,url:`https://${family===6?'['+target.address+']':target.address}:${target.port}/`,localPort,network,signal});
        check();if(signal.aborted)throw Object.assign(Error('Diagnostic cancelled.'),{code:'ABORTED'});
        raw=await request({provider:job.provider,transport:job.transport,name,qtype:job.qtype==='A'?1:28,repeat:job.repeat,
          proxy:{port:endpoint.port,secret:endpoint.secret,localPort}},{signal});
        const pathObservation=observer?await observer.finish({local_ip:raw.localAddress,local_port:raw.localPort}):{state:'unavailable',reason:'observer-unavailable'};
        observer=null;
        attempts[index]={...raw,...base,state:raw.state,pathObservation};
        if(pathObservation.state==='mismatch')Object.assign(attempts[index],{state:'failed',reason:'path-mismatch'});
      }catch(error){if(callerSignal?.aborted || (!invalidated.signal.aborted && error.code==='ABORTED'))throw error;attempts[index]={...base,reason:invalidated.signal.aborted?'configuration-changed':'gateway-probe-unavailable'};}
      finally{await observer?.finish(raw?{local_ip:raw.localAddress,local_port:raw.localPort}:undefined);}
    }
  }));
  }finally{clearInterval(watcher);}
  check();
  if(invalidated.signal.aborted){
    path.configChanged=true;
    for(const attempt of attempts)attempt.pathObservation={state:'unavailable',reason:'configuration-changed'};
  }
  const comparisons=selected.flatMap(provider=>['A','AAAA'].map(qtype=>{
    const rows=attempts.filter(row=>row.provider===provider.id && row.qtype===qtype),valid=rows.filter(verified);
    return {provider:provider.id,qtype,state:valid.length!==8?'incomplete':new Set(valid.map(signature)).size>1?'different':'matched',
      responsesDiffer:new Set(valid.map(signature)).size>1,validResponses:valid.length,expectedResponses:8,cause:null};
  }));
  return {ok:true,version:1,family,mode:path.mode==='chain'?'chain':'gateway',name,path,providers:selected.map(({id,name,filtering})=>({id,name,filtering})),
    state:attempts.every(verified)?'ok':attempts.some(verified)?'partial':'unavailable',attempts,comparisons,
    diagnosis:{cause:null,confidence:'undetermined'},limits:{portAllocationSeconds:2,attempts:jobs.length,parallel:4,budgetSeconds:35,maxResponseBytes:4096}};
}
