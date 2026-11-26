import {endpointStopsWebsites,websiteSteps,endpointOnlyReport} from './diagnostic-phases.js';
import {diagnosticDomainUrl,diagnosticSampleTargets,diagnosticTargetLimits} from '../shared/diagnostic-targets.js';
import {diagnosticSummary} from '../shared/diagnostic-summary.js';
import {diagnosticContext} from '../shared/diagnostic-context.js';

// One common target list. Infrastructure checks stay separate from website tests.
export async function diagnoseDomains({domains,local=false,checks,profile,signal,services,onProgress=()=>{},budgetMs=diagnosticTargetLimits.budgetSeconds*1000}){
 const expired=new AbortController(),combined=signal?AbortSignal.any([signal,expired.signal]):expired.signal;
 const timer=setTimeout(()=>expired.abort(),budgetMs);timer.unref?.();
 const startedAt=new Date().toISOString();
 const steps=[{id:'preparing',kind:'preparing'},...(checks.endpoint?[{id:'server',kind:'server'}]:[])].map(step=>({...step,state:'pending'}));
 const report={version:1,domains:[],attempts:[],targetReports:[],progress:{state:'running',startedAt,steps},diagnosis:{cause:null,confidence:'undetermined'}};
 diagnosticContext(report,profile);
 report.attempts=report.targetReports.flatMap(row=>row.attempts);
 const emit=()=>onProgress({type:'progress',progress:structuredClone(report.progress),report:structuredClone(report)});
 const run=async(step,work,save)=>{
  if(signal?.aborted)throw Object.assign(Error('Diagnostic cancelled.'),{code:'ABORTED'});
  if(expired.signal.aborted){step.state='skipped';step.reason='budget-exhausted';return;}
  step.state='running';emit();
  try{const value=await work(combined);save(value);step.state='finished';step.outcome=diagnosticStepOutcome(step.kind,value);}
  catch(error){if(signal?.aborted)throw error;save({ok:false,state:'unavailable',outcome:'unavailable',attempts:[],reason:expired.signal.aborted?'budget-exhausted':'probe-unavailable'});step.state=expired.signal.aborted?'skipped':'finished';step.outcome='unavailable';step.reason=expired.signal.aborted?'budget-exhausted':'unavailable';}
  emit();
 };
 try{
  await run(steps[0],services.prepare,()=>{});
  if(services.lantern){
   const step={id:'lantern',kind:'lantern',label:'Connecting to the Lantern proxy network',state:'pending'};steps.push(step);
   await run(step,signal=>services.lantern({signal,onProgress:value=>{report.lanternConnection=value;emit();}}),value=>{report.lanternConnection=value;});
   if(report.lanternConnection?.outcome!=='ok'){report.outcome='failed';report.progress.state=expired.signal.aborted?'budget-exhausted':'completed';report.finishedAt=new Date().toISOString();return report;}
  }
  if(services.tor){
   const torStep={id:'tor',kind:'tor',label:'Connecting to the Tor network',state:'pending'};steps.push(torStep);
   const observed=new Map();
   await run(torStep,signal=>services.tor({signal,onProgress:value=>{
    report.torConnection=value;
    for(const row of value.attempts || []){
     const id='tor-attempt-'+row.id;
     if(!observed.has(id)){const step={id,kind:'tor-attempt',label:row.mode==='snowflake'?'Connecting through Snowflake':'Connecting to Tor directly',state:'pending'};observed.set(id,step);steps.push(step);}
     Object.assign(observed.get(id),{state:row.state==='running'?'running':'finished',outcome:row.state==='ok'?'ok':row.state==='running'?undefined:'failed',percent:row.progress});
    }
    emit();
   }}),value=>{report.torConnection=value;});
   if(report.torConnection?.outcome!=='ok'){
    report.outcome='failed';report.progress.state=expired.signal.aborted?'budget-exhausted':'completed';report.finishedAt=new Date().toISOString();return report;
   }
  }

  if(checks.endpoint)await run(steps.find(step=>step.id==='server'),services.endpoint,value=>{report.endpointControl=value;});
  if(checks.mtu && services.mtu){const step={id:'mtu',kind:'mtu',state:'pending'};steps.push(step);await run(step,signal=>services.mtu({endpoint:report.endpointControl,signal}),value=>{report.mtu=value;});}
  let endpointFailure=false;
  const comparePaths=async()=>{
   if(!services.pathComparison)return;
   const anchor={id:'path-comparison',kind:'path-comparison',state:'pending'};steps.push(anchor);
   const stages=new Map();
   await run(anchor,signal=>services.pathComparison({signal,endpoint:report.endpointControl,onProgress:value=>{
    report.pathComparison=value;
    for(const row of [...(value.controls || []).map((row,index)=>({...row,id:'control-'+index,kind:'control-selection'})),...(value.results || []).map(row=>({...row,id:row.id+':'+row.address,kind:'path-comparison-attempt'}))]){
     if(!stages.has(row.id)){const stage={id:'compare:'+row.id,kind:row.kind,address:row.address,label:row.kind==='control-selection'?'Finding a working control gateway':({'direct-before':'Direct connection before the control','control':'Connection through the control gateway','direct-after':'Direct connection after the control'})[row.id.split(':')[0]],state:'pending'};stages.set(row.id,stage);steps.push(stage);}
     Object.assign(stages.get(row.id),{state:['pending','running'].includes(row.state)?row.state:'finished',outcome:row.state==='ok'?'ok':row.state==='failed'?'failed':'unavailable'});
    }
    emit();
   }}),value=>{report.pathComparison=value;});
  };

  const investigate=async()=>{
   report.failureInvestigation={state:'running',reason:'proxy-endpoint-unreachable',trigger:'endpoint-unreachable'};
   const deeper={id:'server-detail',kind:'server',label:'Repeated proxy IP checks',state:'pending'};steps.push(deeper);
   await run(deeper,signal=>services.endpointDetailed?services.endpointDetailed(signal):services.endpoint(signal),value=>{report.failureInvestigation={...report.failureInvestigation,state:'completed',endpointControl:value};});
   if(!endpointStopsWebsites(report.failureInvestigation.endpointControl,profile)){
    if(['ok','partial'].includes(report.failureInvestigation.endpointControl?.state)){report.endpointControl=report.failureInvestigation.endpointControl;delete report.failureInvestigation;return false;}
   }
   endpointOnlyReport(report);
   if(services.endpointRoute){const stage={id:'server-route',kind:'server-route',state:'pending'};report.progress.steps.push(stage);await run(stage,signal=>services.endpointRoute({endpoint:report.endpointControl,signal}),value=>{report.endpointRoute=value;});}
   await comparePaths();
   report.proxyStrategies={state:'unavailable',outcome:'unavailable',reason:'tcp-unreachable',results:[],recommendations:[]};
   return true;
  };
  if(checks.endpoint && endpointStopsWebsites(report.endpointControl,profile))endpointFailure=await investigate();
  if(!endpointFailure){
   steps.push(...websiteSteps(domains,checks,local),...(checks.protocols?[{id:'protocols',kind:'protocols',state:'pending'}]:[]),...(checks.speedtest?[{id:'speedtest',kind:'speedtest',state:'pending'}]:[]));
  for(const domain of domains){
   const target={domain,attempts:[]},url=diagnosticDomainUrl(domain);report.targetReports.push(target);report.domains.push(domain);
   if(services.blocklist){const step={id:'blocklist:'+domain,kind:'blocklist',domain,state:'pending'};steps.splice(steps.findIndex(row=>row.domain===domain),0,step);await run(step,()=>services.blocklist(domain),value=>{target.blocklist=value;});}
   for(const step of steps.filter(step=>step.domain===domain && step.kind!=='blocklist')){
    await run(step,async signal=>{
     switch(step.kind){
      case 'websites':return services.gateway({signal,targets:[url]});
      case 'internet':return services.direct({signal,targets:[url]});
      case 'dns-direct':return services.dnsDirect({name:domain},{signal});
      case 'dns-gateway':return services.dnsGateway({name:domain,signal});
      case 'sni-direct':return services.sniDirect({name:domain},{signal});
      case 'sni-gateway':return services.sniGateway({name:domain,signal});
      case 'http3':return services.http3({name:domain,signal});
      case 'tls-versions':return services.tlsVersions({name:domain,signal});
      case 'downloads':return services.transfer({signal,targets:diagnosticSampleTargets([domain])});
     }
    },value=>{
     if(step.kind==='websites'){
      target.path=value.path;target.limits=value.limits;if(value.xrayConnection)target.xrayConnection=value.xrayConnection;target.attempts=value.attempts?.length?value.attempts:[{url,outcome:'unavailable',observation:value.reason || 'probe-unavailable',stages:[]}];
      report.path ||= value.path;report.attempts=report.targetReports.flatMap(row=>row.attempts);
      if(value.path?.configChanged){report.path.configChanged=true;}
     }else if(step.kind==='internet')target.uplinkControl={...value,mode:'direct-listener',verificationScope:'selected-listener-outbound'};
     else target[{'dns-direct':'dnsMatrix','dns-gateway':'gatewayDnsMatrix','sni-direct':'sniControl','sni-gateway':'gatewaySniControl',downloads:'transfer','tls-versions':'tlsVersions',http3:'http3'}[step.kind]]=value;
     diagnosticContext(target,profile);
    });

   }
  }
  }
  const allFailed=!local && !['tor','lantern'].includes(profile?.engine) && !endpointFailure && report.attempts.length && report.attempts.every(row=>row.outcome==='failed');
  if(allFailed)await comparePaths();
  if(allFailed && report.pathComparison?.outcome!=='same-success' && services.strategies){
   const anchor={id:'strategies',kind:'strategies',state:'pending'};steps.push(anchor);const strategySteps=new Map();
   const update=value=>{
    report.proxyStrategies=value;
    if(value.results?.length && steps.includes(anchor))steps.splice(steps.indexOf(anchor),1);
    for(const result of value.results || []){
     const key=result.address+':'+result.id;
     if(!strategySteps.has(key)){const stage={id:'strategy:'+key,kind:'strategy',label:result.label,address:result.address,state:'pending'};strategySteps.set(key,stage);steps.push(stage);}
     Object.assign(strategySteps.get(key),{state:['pending','running'].includes(result.state)?result.state:'finished',outcome:['pending','running'].includes(result.state)?undefined:result.state});
    }
    emit();
   };
   await run(anchor,signal=>services.strategies({signal,endpoint:report.endpointControl,domain:domains[0],onProgress:update}),value=>{report.proxyStrategies=value.results?value:report.proxyStrategies?{...report.proxyStrategies,state:'completed',outcome:'unavailable',reason:value.reason}:value;});
  }
  if(checks.pairedTransfer && !endpointFailure && services.pairedTransfer){
   const anchor={id:'paired-transfer',kind:'paired-transfer',state:'pending'};steps.push(anchor);const phases=new Map();
   await run(anchor,signal=>services.pairedTransfer({signal,onProgress:value=>{report.pairedTransfer=value;
    for(const row of value.results || []){if(!phases.has(row.id)){const step={id:'paired-transfer:'+row.id,kind:'paired-transfer',label:row.id==='direct'?'Downloading the sample without the gateway':'Downloading the sample through the gateway',state:'pending'};phases.set(row.id,step);steps.push(step);}Object.assign(phases.get(row.id),{state:row.state==='running'?'running':'finished',outcome:row.state});}emit();
   }}),value=>{report.pairedTransfer=value;});
  }
  if(checks.protocols && !endpointFailure)await run(steps.find(step=>step.id==='protocols'),signal=>services.protocols({signal,name:domains[0],tcpConfirmed:!report.path?.configChanged && report.attempts.some(row=>row.outcome==='ok' && row.pathObservation?.state==='verified')}),value=>{report.protocols=value;});
  if(checks.speedtest && !endpointFailure)await run(steps.find(step=>step.id==='speedtest'),signal=>services.speedtest({signal,onProgress:value=>{report.speedtest=value;emit();}}),value=>{report.speedtest=value.attempts?.length?value:(report.speedtest || value);});
  report.egressIdentity=services.identity();
  report.progress.state=expired.signal.aborted?'budget-exhausted':'completed';
  report.outcome=endpointFailure?(report.pathComparison?.outcome==='same-success'?'partial':'failed'):!report.attempts.length?'unavailable':report.attempts.every(row=>row.outcome==='ok')?'ok':report.attempts.some(row=>row.outcome==='ok')?'partial':report.attempts.every(row=>row.outcome==='unavailable')?'unavailable':'failed';
  report.finishedAt=new Date().toISOString();
  report.limits={budgetSeconds:budgetMs/1000,...(endpointFailure?{}:{domains:report.domains.length,maxSampleBytes:diagnosticTargetLimits.maxSampleBytes})};
  diagnosticContext(report,profile);return report;
 }finally{clearTimeout(timer);}
}

// Use the same evidence rules as the final report, rather than probe completion.
export function diagnosticStepOutcome(kind,value){
 if(kind==='lantern')return value?.outcome || 'unavailable';
 if(kind==='tor')return value?.outcome || 'unavailable';
 if(kind==='preparing')return 'ok';
 if(kind==='blocklist')return ['listed','not-listed'].includes(value?.state)?'ok':'unavailable';
 if(kind==='path-comparison')return value?.outcome==='same-success'?'ok':value?.outcome==='path-dependent'?'partial':'unavailable';
 if(kind==='server-route')return value?.state==='completed'?'ok':'unavailable';
 if(kind==='strategies')return value?.outcome || 'unavailable';
 if(kind==='mtu')return value?.outcome || 'unavailable';
 if(kind==='http3')return value?.outcome || 'unavailable';
 if(kind==='tls-versions')return value?.outcome || 'unavailable';
 if(kind==='paired-transfer')return value?.outcome || 'unavailable';
 if(kind==='protocols')return value?.outcome || 'unavailable';
 if(kind==='speedtest')return value?.outcome || 'unavailable';
 const field={server:'endpointControl',internet:'uplinkControl','dns-direct':'dnsMatrix','dns-gateway':'gatewayDnsMatrix','sni-direct':'sniControl','sni-gateway':'gatewaySniControl',downloads:'transfer'}[kind];
 const report=kind==='websites'?value:{[field]:kind==='internet'?{...value,mode:'direct-listener'}:value};
 return diagnosticSummary(report).find(card=>card.id===kind)?.state || 'unavailable';
}
