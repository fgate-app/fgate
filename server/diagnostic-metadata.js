import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFileSync} from 'node:fs';
const run=promisify(execFile);
export const diagnosticSchemaVersion=2;
const unavailable=()=>({state:'unavailable',version:null});
const valid=value=>typeof value==='string' && /^(?:v?\d[a-zA-Z0-9.+_-]{0,79}|[a-f0-9]{7,64})$/.test(value);
const commands={lantern:['--version'],mihomo:['-v'],xray:['version'],outline:['--version'],curl:['--version'],python:['--version']};
export async function diagnosticVersion(id,binary,{execute=run}={}){
  if(!commands[id] || !binary)return unavailable();
  try{
    const output=await execute(binary,commands[id],{timeout:1500,maxBuffer:8192,encoding:'utf8'});
    const text=String(output.stdout || '')+'\n'+String(output.stderr || '');
    if(id==='outline'){
      const value=JSON.parse(output.stdout);if(!valid(value.bridge) || !valid(value.sdk))return unavailable();
      return {state:'ok',version:value.bridge,sdkVersion:value.sdk,source:'runtime-version'};
    }
    const pattern={lantern:/^lantern-headless v(\d[\w.+-]*)/im,mihomo:/^(?:Mihomo(?: Meta)?|Clash Meta)\s+(v?\d[\w.+-]*)/im,xray:/^Xray\s+(v?\d[\w.+-]*)/im,curl:/^curl\s+(\d[\w.+-]*)/im,python:/^Python\s+(\d[\w.+-]*)/im}[id];
    const version=pattern?.exec(text)?.[1];return valid(version)?{state:'ok',version,source:'runtime-version'}:unavailable();
  }catch{return unavailable();}
}
export async function diagnosticEnvironment({engines=[],python=false,zapret=false,execute=run,read=readFileSync,moduleRoot=process.env.FREEDOMGATE_MODULES_DIR || '/opt/freedomgate/modules'}={}){
  const tools=await Promise.all([['curl','curl'],...(python?[['python','python3']]:[])].map(async([id,binary])=>[id,await diagnosticVersion(id,binary,{execute})]));
  const modules=await Promise.all(engines.map(async({id,binary})=>({id,...await diagnosticVersion(id,binary,{execute})})));
  if(!modules.some(row=>row.id==='mihomo'))modules.unshift({id:'mihomo',...unavailable()});
  if(zapret){let version=unavailable();try{const manifest=JSON.parse(read(`${moduleRoot}/zapret/current/manifest.json`,'utf8'));const value=manifest.version || manifest.commit;if(valid(value))version={state:'ok',version:value,source:'installed-manifest'};}catch{}modules.push({id:'zapret',...version});}
  let app=unavailable();try{const value=JSON.parse(read(new URL('../package.json',import.meta.url),'utf8')).version;if(valid(value))app={state:'ok',version:value,source:'runtime-package'};}catch{}
  return {observedAt:new Date().toISOString(),scope:'diagnostic-start',app,node:{state:'ok',version:process.version},nodeOpenSSL:{state:'ok',version:process.versions.openssl},platform:process.platform,architecture:process.arch,
    tools:Object.fromEntries(tools),engines:modules};
}
export function diagnosticMetadata(report,{environment,startedAt,finishedAt,checks,parameters}={}){
  const measured={};
  for(const key of ['endpointControl','uplinkControl','dnsMatrix','gatewayDnsMatrix','gatewaySniControl','sniControl','localDns','localSni','transfer','speedtest','protocols','proxyStrategies','endpointRoute','pathComparison','pairedTransfer','tlsVersions','http3','mtu'])if(report[key]){
    measured[key]={state:report[key].limits?'recorded':'unavailable',limits:report[key].limits || null,attemptLimits:(report[key].attempts || []).map(row=>row.limits || null)};
  }
  if(report.phase==='endpoint-only'){
    checks={endpoint:!!report.endpointControl,...(report.mtu?{mtu:true}:{}),endpointRoute:!!report.endpointRoute,pathComparison:!!report.pathComparison};parameters=parameters?.endpoint?{endpoint:parameters.endpoint}:{};
  }else if(parameters?.domains)parameters={...parameters,domains:report.domains || []};
  if(report.phase!=='endpoint-only')measured.https={state:report.limits?'recorded':'unavailable',limits:report.limits || null};
  report.schemaVersion=diagnosticSchemaVersion;report.startedAt=startedAt;report.finishedAt=finishedAt;
  if(report.targetReports)measured.targets=report.targetReports.map(target=>({domain:target.domain,limits:diagnosticMetadata({...target,targetReports:undefined},{checks}).measurement.limits}));
  report.measurement={environment,checks,parameters,limits:measured};
  return report;
}
