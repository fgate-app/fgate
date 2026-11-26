// Direct endpoint controls cannot describe a proxy reached through another gateway.
export const isWrappedDiagnostic=profile=>!!(profile?.gatewayId || profile?.gateway_id);
export function endpointStopsWebsites(endpoint,profile){
 if(isWrappedDiagnostic(profile))return false;
 if(endpoint?.state==='failed' && endpoint.complete===true)return true;
 return endpoint?.bootstrap?.state==='failed' && endpoint.addresses?.length===0;
}
export function websiteSteps(domains,checks,local){
 return domains.flatMap((domain,index)=>['websites',...(checks.uplink?['internet']:[]),...(checks.dns?(local?['dns-gateway']:['dns-direct','dns-gateway']):[]),...(checks.sni?(local?['sni-gateway']:['sni-direct','sni-gateway']):[]),...(checks.transfer?['downloads']:[]),...(checks.tlsVersions?['tls-versions']:[]),...(checks.http3?['http3']:[])].map(kind=>({id:`${index}:${kind}`,kind,domain,state:'pending'})));
}
// A report records measurements, rather than the form's untouched target list.
export function endpointOnlyReport(report){
 report.phase='endpoint-only';delete report.domains;delete report.attempts;delete report.targetReports;
 const kept=report.progress.steps.filter(step=>!step.domain && !['protocols','speedtest'].includes(step.kind));
 report.progress.steps.splice(0,report.progress.steps.length,...kept);
 return report;
}
