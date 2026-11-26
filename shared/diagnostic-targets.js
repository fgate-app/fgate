export const defaultDiagnosticDomains=Object.freeze(['www.gstatic.com','cp.cloudflare.com','www.apple.com']);
export const diagnosticTargetLimits=Object.freeze({maxDomains:8,budgetSeconds:300,maxSampleBytes:1048576});
const paths={'www.gstatic.com':'/generate_204','cp.cloudflare.com':'/generate_204','www.apple.com':'/library/test/success.html'};
export function normalizeDiagnosticDomains(values=defaultDiagnosticDomains){
 if(!Array.isArray(values) || !values.length || values.length>diagnosticTargetLimits.maxDomains)throw Error('Choose between 1 and 8 test domains.');
 const domains=values.map(value=>{
  if(typeof value!=='string')throw Error('Enter domain names without a URL, path or port.');
  const name=value.trim().toLowerCase().replace(/\.$/,'');
  if(name.length>253 || name.split('.').length<2 || name.split('.').some(label=>!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) || /^\d+(?:\.\d+){3}$/.test(name))throw Error('Enter domain names without a URL, path or port.');
  return name;
 });
 return [...new Set(domains)];
}
export function diagnosticDomainUrl(domain){const [name]=normalizeDiagnosticDomains([domain]);return `https://${name}${paths[name] || '/'}`;}
export function validDiagnosticUrl(value){try{const url=new URL(value);return value===diagnosticDomainUrl(url.hostname);}catch{return false;}}
export function diagnosticSampleTargets(domains){return normalizeDiagnosticDomains(domains).map(domain=>({domain,url:diagnosticDomainUrl(domain),bytes:diagnosticTargetLimits.maxSampleBytes,mode:'site-response'}));}
