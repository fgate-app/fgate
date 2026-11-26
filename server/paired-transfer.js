import {transferTargets} from './transfer-diagnostics.js';

// Exactly the same fixed sample and limits on both independently pinned paths.
export async function compareTransfer({request,isCurrent=()=>true,signal,onProgress=()=>{}}){
 const report={state:'running',outcome:'unavailable',target:{...transferTargets[0]},results:[],limits:{paths:2,bytesPerPath:65536,requestSeconds:12,budgetSeconds:52}};
 const expired=new AbortController(),combined=signal?AbortSignal.any([signal,expired.signal]):expired.signal,timer=setTimeout(()=>expired.abort(),52000);timer.unref?.();
 const current=()=>{try{return isCurrent();}catch{return false;}};
 try{
  for(const mode of ['direct','gateway']){
   signal?.throwIfAborted();if(combined.aborted || !current()){report.reason=combined.aborted?'budget-exhausted':'configuration-changed';break;}
   const row={id:mode,state:'running'};report.results.push(row);onProgress(structuredClone(report));
   try{
    const value=await request(mode,{signal:combined,targets:[{...transferTargets[0]}]});
    const attempt=value.attempts?.[0],sameSample=attempt?.url===transferTargets[0].url && attempt?.expectedBytes===65536,verified=attempt?.pathObservation?.state==='verified' && !value.path?.configChanged;
    Object.assign(row,{...value,state:verified && sameSample && attempt.outcome==='ok' && attempt.complete && attempt.bytes===65536?'ok':verified && attempt.outcome==='failed'?'failed':'unavailable'});
    if(!verified)row.reason=attempt?.httpStatus || attempt?.complete?'path-unverified':'probe-unavailable';
    else if(!sameSample)row.reason='sample-mismatch';
    if(value.path?.configChanged)report.reason='configuration-changed';
   }catch(error){if(signal?.aborted)throw error;Object.assign(row,{state:'unavailable',reason:combined.aborted?'budget-exhausted':'probe-unavailable'});}
   if(report.reason==='configuration-changed' || !current()){report.reason='configuration-changed';for(const result of report.results)Object.assign(result,{state:'unavailable',reason:report.reason});break;}
   onProgress(structuredClone(report));
  }
  if(expired.signal.aborted)report.reason='budget-exhausted';
  report.state='completed';
  report.outcome=report.reason?'unavailable':report.results.length===2 && report.results.every(row=>row.state==='ok')?'ok':report.results.some(row=>row.state==='ok')?'partial':report.results.length===2 && report.results.every(row=>row.state==='failed')?'failed':'unavailable';
  onProgress(structuredClone(report));return report;
 }finally{clearTimeout(timer);}
}
