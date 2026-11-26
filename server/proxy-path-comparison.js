import {isIP} from 'node:net';
import {probeProxyStrategy} from './proxy-strategies.js';
import {diagnosticControlHelper} from './diagnostic-control-relay.js';

export const pathComparisonLimits=Object.freeze({maxCandidates:16,selectionSeconds:30,maxAddresses:2,budgetSeconds:120,repeats:2,controlSeconds:10});
export const proxyValidationDomain='example.com';
export async function compareProxyPaths({snapshot,endpoint,candidates=[],verifyControl,getControl,isCurrent=()=>true,signal,onProgress=()=>{},probe=probeProxyStrategy,budgetMs=120000}){
 const unavailable=reason=>({state:'completed',outcome:'unavailable',reason,results:[],controls:[],limits:pathComparisonLimits});
 if(!['outline','xray'].includes(snapshot?.config?.engine) || snapshot?.profile?.gateway_id || snapshot?.profile?.gatewayId)return unavailable('unsupported-comparison-client');
 const addresses=[...new Set(endpoint?.addresses || [])].filter(isIP).slice(0,2);
 if(!addresses.length)return unavailable('endpoint-address-unavailable');
 if(!candidates.length)return unavailable('no-control-gateway');
 const expired=new AbortController(),combined=signal?AbortSignal.any([signal,expired.signal]):expired.signal,timer=setTimeout(()=>expired.abort(),budgetMs);timer.unref?.();
 const selectionExpired=new AbortController(),selectionTimer=setTimeout(()=>selectionExpired.abort(),30000);selectionTimer.unref?.();
 const report={state:'running',outcome:'unavailable',controls:[],results:[],limits:{...pathComparisonLimits,budgetSeconds:budgetMs/1000},controlCandidates:candidates.length,validationDomain:proxyValidationDomain};
 const emit=()=>onProgress(structuredClone(report));
 let control,selected;
 try{
  for(const candidate of candidates.slice(0,pathComparisonLimits.maxCandidates)){
   if(combined.aborted || selectionExpired.signal.aborted)break;
   if(!isCurrent()){report.reason='configuration-changed';break;}
   const row={profileId:candidate.id,state:'running'};report.controls.push(row);emit();
   const timeout=new AbortController(),controlSignal=AbortSignal.any([combined,selectionExpired.signal,timeout.signal]),controlTimer=setTimeout(()=>timeout.abort(),10000);
   try{
    const handle=await getControl(candidate.id);
    if(!handle || !handle.isCurrent()){row.state='unavailable';row.reason='control-listener-unavailable';continue;}
    const check=await verifyControl(candidate.id,{signal:controlSignal,targets:[`https://${proxyValidationDomain}/`]});
    const works=!check.path?.configChanged && check.attempts?.length && check.attempts.every(attempt=>attempt.outcome==='ok' && attempt.pathObservation?.state==='verified');
    if(works && handle.isCurrent()){control=handle;row.state='ok';selected=candidate;report.controlGatewayId=candidate.id;report.controlName=candidate.name;}
    if(!selected){row.state='unavailable';row.reason=check.attempts?.[0]?.observation || 'control-unverified';row.pathConfirmed=check.attempts?.[0]?.pathObservation?.state==='verified';}
   }catch{row.state='unavailable';}finally{clearTimeout(controlTimer);}
   emit();if(selected)break;
  }
  clearTimeout(selectionTimer);
  if(!selected){report.reason ||= expired.signal.aborted?'budget-exhausted':'no-verified-control';return report;}
  report.results=addresses.flatMap(address=>['direct-before','control','direct-after'].map(id=>({id,address,state:'pending',attempts:[]})));emit();
  for(const result of report.results){
   if(combined.aborted)break;
   if(!isCurrent() || !control.isCurrent()){report.reason='configuration-changed';break;}
   result.state='running';emit();
   try{Object.assign(result,await probe({snapshot,address:result.address,strategy:'baseline',domain:proxyValidationDomain,signal:combined,gateRepeats:2,
    ...(result.id==='control'?{helper:diagnosticControlHelper({...control,target:{address:result.address,port:endpoint.port},signal:combined})}:{})}));}
   catch(error){if(signal?.aborted)throw error;Object.assign(result,{state:'unavailable',reason:expired.signal.aborted?'budget-exhausted':'probe-unavailable'});}
   emit();
  }
  if(!isCurrent() || !control.isCurrent())report.reason='configuration-changed';
  if(!report.reason && !expired.signal.aborted){
   const groups=addresses.map(address=>report.results.filter(row=>row.address===address));
   const all=state=>groups.every(rows=>rows.every(row=>row.state===state));
   report.outcome=all('ok')?'same-success':groups.some(rows=>rows.find(row=>row.id==='control')?.state==='ok' && rows.filter(row=>row.id!=='control').every(row=>row.state==='failed'))?'path-dependent':all('failed')?'same-failure':'inconclusive';
  }
  return report;
 }finally{
  clearTimeout(timer);clearTimeout(selectionTimer);if(signal?.aborted)throw Object.assign(Error('Diagnostic cancelled.'),{code:'ABORTED'});
  if(expired.signal.aborted)report.reason='budget-exhausted';
  if(report.reason)report.outcome='unavailable';report.state='completed';
  for(const row of report.results)if(['pending','running'].includes(row.state)){row.state='unavailable';row.reason=report.reason || 'not-run';}
  emit();
 }
}
