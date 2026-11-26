import {normalizeDiagnosticDomains} from '../shared/diagnostic-targets.js';
export const redirectLimits=Object.freeze({maxRedirects:5,budgetMs:24000});
export function validRedirectUrl(value){try{const url=new URL(value);normalizeDiagnosticDomains([url.hostname]);return url.protocol==='https:' && !url.username && !url.password && !url.port && value.length<=8192;}catch{return false;}}
const displayUrl=value=>{const url=new URL(value);return url.origin+url.pathname;};
// Each hop gets a fresh observed connection on the same authenticated listener.
// Never use curl --location: evidence for a single socket cannot verify a chain.
export async function followDiagnosticRedirects(url,probe,{signal,now=Date.now,budgetMs=redirectLimits.budgetMs}={}){
 const deadline=now()+budgetMs,seen=new Set([url]),redirects=[];let current=url,unverified=false,last;
 for(let index=0;;index++){
  if(signal?.aborted)throw Object.assign(Error('Diagnostic cancelled.'),{code:'ABORTED'});
  if(now()>=deadline)return {...last,outcome:'unavailable',complete:false,observation:'redirect-budget-exhausted',url,redirects};
  let result;try{result=await probe(current,{redirectHop:index>0,timeoutMs:Math.max(1,deadline-now())});}catch(error){if(signal?.aborted || error.code==='ABORTED')throw error;if(!redirects.length)throw error;return {...last,url,redirects,finalUrl:displayUrl(current),outcome:'unavailable',complete:false,observation:'redirect-check-unavailable'};}
  const {raw,row}=result;
  if(row.pathObservation?.state!=='verified')unverified=true;
  last={...row,url};
  if(redirects.length)Object.assign(last,{redirects:[...redirects],finalUrl:displayUrl(current)});
  if(row.pathObservation?.state==='mismatch')return {...last,outcome:'failed',complete:false,observation:'path-mismatch'};
  const status=Number(raw.response_code ?? raw.http_code);
  if(raw.exitCode!==0 || ![301,302,303,307,308].includes(status)){
   if(unverified && redirects.length)last.pathObservation={state:'unavailable',reason:'redirect-path-unverified'};
   return last;
  }
  let next;try{next=new URL(raw.redirect_url,current);next.hash='';}catch{}
  const valid=next && typeof raw.redirect_url==='string' && raw.redirect_url.length>0 && validRedirectUrl(next.href);
  const entry={url:displayUrl(current),status,...(valid?{nextUrl:displayUrl(next.href)}:{}),pathState:row.pathObservation?.state || 'unavailable'};
  redirects.push(entry);
  if(!valid || seen.has(next.href) || index>=redirectLimits.maxRedirects)return {...last,url,redirects,outcome:'unavailable',complete:false,observation:!valid?'redirect-target-unsupported':seen.has(next.href)?'redirect-loop':'redirect-limit'};
  seen.add(next.href);current=next.href;
 }
}
