import {isIP} from 'node:net';
import {dnsMatrixProviders,normalizeDnsMatrixName} from './dns-matrix-catalog.js';
import {diagnosticPath} from './gateway-diagnostics.js';
import {allocateDiagnosticTcpPort} from './diagnostic-port.js';
import {requestGatewayDns} from './gateway-dns-matrix.js';

export function sniTargets(){return dnsMatrixProviders().map(provider=>({provider:provider.id,address:provider.endpoints.doh.address,servername:provider.endpoints.doh.servername,dnsProvider:provider}));}
const blocked=['0.0.0.0/8','10.0.0.0/8','100.64.0.0/10','127.0.0.0/8','169.254.0.0/16','172.16.0.0/12','192.0.0.0/24','192.0.2.0/24','192.168.0.0/16','198.18.0.0/15','198.51.100.0/24','203.0.113.0/24','224.0.0.0/3'];
export function selectSniAddress(dns,fakeIpRanges=[]){
  if(!dns || dns.state!=='ok' || dns.rcode!==0 || dns.truncated)return null;
  const integer=value=>value.split('.').reduce((n,v)=>(n*256+Number(v))>>>0,0);
  return (dns.answers || []).filter(row=>row.type==='A').map(row=>row.value).find(address=>isIP(address)===4 && ![...blocked,...fakeIpRanges].some(cidr=>{
    const [ip,bits]=String(cidr).split('/'),prefix=Number(bits);if(isIP(ip)!==4 || !Number.isInteger(prefix) || prefix<0 || prefix>32)return false;
    const mask=prefix===0?0:(0xffffffff<<(32-prefix))>>>0;return (integer(address)&mask)===(integer(ip)&mask);
  })) || null;
}
const verified=row=>row?.state==='ok' && (row.routeVerified || row.pathObservation?.state==='verified');
export function summarizeSni(report){
  if(!report?.ok)return report;
  report.comparisons=sniTargets().map(target=>{
    const rows=report.attempts.filter(row=>row.provider===target.provider),before=rows.find(row=>row.kind==='baseline-before'),after=rows.find(row=>row.kind==='baseline-after'),experiment=rows.find(row=>row.kind==='foreign-sni');
    return {provider:target.provider,state:report.name!==target.servername && [before,after].every(row=>verified(row) && row.experimental===false && row.certificateVerification===true && row.servername===target.servername && row.address===target.address)?'observed':'uninformative',experimentState:experiment?.state || 'unavailable',cause:null,confidence:'undetermined'};
  });
  return report;
}
export async function diagnoseGatewaySni({id,profiles,endpoint,name,signal,observe,isCurrent=()=>true,request=requestGatewayDns,allocatePort=allocateDiagnosticTcpPort,fakeIpRanges=[]}){
  name=normalizeDnsMatrixName(name);const path=diagnosticPath(profiles,id);
  if(!endpoint)throw Error('The selected gateway listener is unavailable.');
  const invalidated=new AbortController(),caller=signal,combined=signal?AbortSignal.any([signal,invalidated.signal]):invalidated.signal;
  const check=()=>{try{if(!isCurrent())invalidated.abort();}catch{invalidated.abort();}};
  check();const watcher=setInterval(check,100);watcher.unref();
  let groups;
  try{groups=await Promise.all(sniTargets().map(async target=>{
    const rows=[];let dns=null,address=null;
    // Explicit DoH uses the same authenticated listener and flow observer as TLS.
    if(caller?.aborted)throw Object.assign(Error('Diagnostic cancelled.'),{code:'ABORTED'});
    if(!combined.aborted){let observer,raw;
      try{const localPort=await allocatePort({signal:combined});observer=await observe?.({endpoint,url:`https://${target.address}/`,localPort,signal:combined});
        check();if(combined.aborted)throw Object.assign(Error('Diagnostic cancelled.'),{code:'ABORTED'});
        raw=await request({provider:target.dnsProvider,transport:'doh',name,qtype:1,repeat:1,proxy:{port:endpoint.port,secret:endpoint.secret,localPort}},{signal:combined});
        const pathObservation=observer?await observer.finish({local_ip:raw.localAddress,local_port:raw.localPort}):{state:'unavailable'};observer=null;
        dns={...raw,pathObservation};if(verified(dns))address=selectSniAddress(dns,fakeIpRanges);
      }catch(error){if(caller?.aborted)throw error;dns={state:'unavailable',reason:'dns-unavailable'};}
      finally{await observer?.finish(raw?{local_ip:raw.localAddress,local_port:raw.localPort}:undefined);}
    }
    const resolution={method:'doh',provider:target.provider,address:target.address,name,state:address?'ok':'unavailable',reason:address?null:(dns?.reason || 'dns-address-unavailable'),rcode:dns?.rcode ?? null,pathVerified:verified(dns),selectedAddress:address};
    for(const [kind,servername,experimental] of [['baseline-before',target.servername,false],['foreign-sni',name,true],['baseline-after',target.servername,false],['target-own-ip',name,false],['control-on-target-ip',target.servername,true]]){
      if(caller?.aborted)throw Object.assign(Error('Diagnostic cancelled.'),{code:'ABORTED'});
      check();const own=kind==='target-own-ip' || kind==='control-on-target-ip',destination=own?address:target.address;let row={provider:target.provider,address:destination,resolution:own?resolution:undefined,port:443,kind,servername,experimental,certificateVerification:!experimental,state:'unavailable',routeVerified:false};
      if(own && !address){row.observation='dns-address-unavailable';rows.push(row);continue;}
      if(experimental && !verified(rows[0])){row.observation='baseline-unavailable';rows.push(row);continue;}
      if(!combined.aborted){
        let observer,raw;
        try{
          const localPort=await allocatePort({signal:combined});observer=await observe?.({endpoint,url:`https://${destination}/`,localPort,signal:combined});
          check();if(combined.aborted)throw Object.assign(Error('Diagnostic cancelled.'),{code:'ABORTED'});
          raw=await request({target:{provider:target.provider,address:destination},servername,experimental,proxy:{port:endpoint.port,secret:endpoint.secret,localPort}},{signal:combined,worker:'sni'});
          const pathObservation=observer?await observer.finish({local_ip:raw.localAddress,local_port:raw.localPort}):{state:'unavailable'};observer=null;
          row={...raw,...row,state:raw.state,pathObservation};
          if(pathObservation.state==='mismatch')Object.assign(row,{state:'failed',observation:'path-mismatch'});
        }catch(error){if(caller?.aborted)throw error;row.observation=invalidated.signal.aborted?'configuration-changed':'transport-unavailable';}
        finally{await observer?.finish(raw?{local_ip:raw.localAddress,local_port:raw.localPort}:undefined);}
      }else row.observation='configuration-changed';
      rows.push(row);
    }
    return rows;
  }));}finally{clearInterval(watcher);}
  check();const attempts=groups.flat();
  if(invalidated.signal.aborted){path.configChanged=true;for(const row of attempts){row.pathObservation={state:'unavailable',reason:'configuration-changed'};if(row.resolution)row.resolution.pathVerified=false;}}
  return summarizeSni({ok:true,limits:{portAllocationSeconds:2,attempts:attempts.length,dnsQueries:sniTargets().length,parallel:2,probeSeconds:7,workerSeconds:8},mode:path.mode==='chain'?'chain':'gateway',path,name,attempts,diagnosis:{cause:null,confidence:'undetermined'}});
}
