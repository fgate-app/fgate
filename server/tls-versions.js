import {selectSniAddress} from './sni-diagnostics.js';
import {normalizeDnsMatrixName} from './dns-matrix-catalog.js';
import {requestGatewayDns} from './gateway-dns-matrix.js';
import {allocateDiagnosticTcpPort} from './diagnostic-port.js';

export async function diagnoseTlsVersions(options){return diagnoseFixedPeer({...options,kind:'tls'});}
export async function diagnoseHttp3(options){return diagnoseFixedPeer({...options,kind:'h3'});}
async function diagnoseFixedPeer({kind,name,endpoint,resolve,observe,isCurrent=()=>true,signal,request=requestGatewayDns,allocatePort=allocateDiagnosticTcpPort}){
 name=normalizeDnsMatrixName(name);
 const variants=kind==='h3'?['3']:['1.2','1.3'];
 const report={state:'running',name,attempts:[],outcome:'unavailable',limits:{budgetSeconds:25,versions:variants,peerPort:443,...(kind==='h3'?{tcpFallback:false,maxDatagramBytes:2097152,maxPackets:128}:{maxResponseBytes:4096})}};
 const expired=new AbortController(),combined=signal?AbortSignal.any([signal,expired.signal]):expired.signal,timer=setTimeout(()=>expired.abort(),25000);timer.unref?.();
 try{
  const resolution=await resolve({name,signal:combined});
  report.address=(resolution.attempts || []).filter(row=>row.state==='ok' && row.pathObservation?.state==='verified').map(row=>selectSniAddress(row)).find(Boolean);
  if(!report.address){report.reason='dns-address-unavailable';return report;}
  for(const version of variants){
   signal?.throwIfAborted();if(combined.aborted || !isCurrent()){report.reason=combined.aborted?'budget-exhausted':'configuration-changed';break;}
   let observer;
   try{
    const localPort=await allocatePort({signal:combined});observer=await observe?.({endpoint,url:`https://${report.address}:443/`,network:kind==='h3'?'udp':'tcp',localPort,signal:combined});
    const row=await request({name,address:report.address,version,proxy:{port:endpoint.port,secret:endpoint.secret,localPort}},{signal:combined,worker:kind==='h3'?'h3':'tls'});
    const pathObservation=observer?await observer.finish({local_ip:row.localAddress,local_port:row.localPort}):{state:'unavailable'};observer=null;
    report.attempts.push({...row,version,pathObservation,...(pathObservation.state!=='verified'?{state:'unavailable',...(row.state==='ok'?{reason:'path-unverified'}:{})}:{})});
   }catch(error){if(signal?.aborted)throw error;report.attempts.push({version,state:'unavailable',reason:combined.aborted?'budget-exhausted':kind==='h3'?'http3-probe-unavailable':'tls-probe-unavailable'});}
   finally{await observer?.finish();}
  }
  if(!isCurrent()){report.reason='configuration-changed';for(const row of report.attempts)Object.assign(row,{state:'unavailable',reason:report.reason,pathObservation:{state:'unavailable'}});}
  report.outcome=report.reason?'unavailable':report.attempts.length===variants.length && report.attempts.every(row=>row.state==='ok')?'ok':report.attempts.some(row=>row.state==='ok')?'partial':report.attempts.length===variants.length && report.attempts.every(row=>row.state==='failed')?'failed':'unavailable';
  return report;
 }catch(error){if(signal?.aborted)throw error;report.reason=combined.aborted?'budget-exhausted':kind==='h3'?'http3-probe-unavailable':'tls-probe-unavailable';return report;}
 finally{report.state='completed';clearTimeout(timer);}
}
