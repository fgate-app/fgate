import {isIP} from 'node:net';
import {dnsMatrixProviders,normalizeDnsMatrixName} from './dns-matrix-catalog.js';

// Keep the original DNS failure classes, but never copy helper socket/route data.
export function endpointDohResolution(name,providerId,response){
  const provider=dnsMatrixProviders([providerId])[0],target=provider.endpoints.doh;
  name=normalizeDnsMatrixName(name);
  const attempts=['A','AAAA'].map(qtype=>{
    const rows=(response?.attempts || []).filter(row=>row.qtype===qtype);
    const row=rows.length===1?rows[0]:null;
    if(!response?.ok || response.mode!=='endpoint-doh' || response.name!==name || !row || row.provider!==providerId || row.transport!=='doh' || row.address!==target.address || row.port!==target.port)return {qtype,state:'unavailable',reason:'invalid-response'};
    return {qtype,state:row.state,rcode:row.rcode ?? null,reason:row.reason || null,failedStage:row.failedStage || null,truncated:row.truncated===true,
      httpStatus:Number.isInteger(row.httpStatus)?row.httpStatus:null,pathVerified:row.routeVerified===true,resolverAddress:target.address,durationMs:row.durationMs ?? null,answers:row.answers || []};
  });
  const valid=row=>row.state==='ok' && row.rcode===0 && !row.truncated && row.pathVerified;
  const addressSources=[];
  for(const row of attempts.filter(valid)){
    const names=new Set([name]);
    for(let i=0;i<16;i++){let changed=false;for(const answer of row.answers)if(answer.type==='CNAME' && names.has(answer.name) && typeof answer.value==='string' && !names.has(answer.value)){names.add(answer.value);changed=true;}if(!changed)break;}
    for(const answer of row.answers)if(names.has(answer.name) && answer.type===row.qtype && isIP(answer.value)===(row.qtype==='A'?4:6)){
      if(!addressSources.some(source=>source.address===answer.value))addressSources.push({address:answer.value,method:'doh',provider:providerId,resolverAddress:target.address,qtype:row.qtype});
    }
  }
  const failed=attempts.find(row=>!valid(row));
  const complete=attempts.every(valid),reason=attempts.some(row=>row.rcode===3)?'nxdomain':failed?.reason || (failed?.truncated?'truncated-response':failed && !failed.pathVerified?'dns-path-unverified':attempts.some(row=>row.rcode)?'dns-rcode-error':addressSources.length?null:'no-addresses');
  return {addresses:addressSources.map(row=>row.address),bootstrap:{method:'doh',provider:providerId,resolverAddress:target.address,state:complete && addressSources.length?'ok':addressSources.length?'partial':'failed',
    complete,pathVerified:attempts.every(row=>row.pathVerified===true),reason,addressSources,attempts,limits:response?.limits || null}};
}
