import {dnsMatrixProviders} from './dns-matrix-catalog.js';
import {endpointDohResolution} from './endpoint-doh.js';
import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import {gatewayEditor} from './gateway-editor.js';

export function gatewayPeer(snapshot) {
  const editor=gatewayEditor(snapshot),type=editor.type.replace(/^mihomo:/,''),fields=editor.fields;
  if(!['ss','vless','socks5','http','vmess','trojan','ssh','mieru','naive'].includes(type) || ['quic','kcp','mkcp'].includes(fields.network))return null;
  const host=fields.server?.replace(/^\[|\]$/g,''),port=Number(fields.port);
  if(!host || !Number.isInteger(port) || port<1 || port>65535)throw Error('Invalid gateway endpoint.');
  return {host,port};
}

function containsV4(address,cidr) {
  const [network,bits]=String(cidr).split('/'),prefix=Number(bits);
  if(isIP(address)!==4 || isIP(network)!==4 || !Number.isInteger(prefix) || prefix<0 || prefix>32)return false;
  const integer=value=>value.split('.').reduce((result,octet)=>(result*256+Number(octet))>>>0,0);
  const mask=prefix===0?0:(0xffffffff << (32-prefix))>>>0;
  return (integer(address)&mask)===(integer(network)&mask);
}

// getaddrinfo itself cannot be cancelled; the deadline bounds caller wait and
// no TCP probe is started after cancellation or a resolution timeout. Cancellable
// resolvers also receive an abort signal so their helper worker can stop.
async function resolvePeer(host,{resolve,signal,timeout}) {
  if(signal?.aborted)throw Object.assign(Error('Diagnostic cancelled.'),{code:'ABORTED'});
  const inner=new AbortController();
  return new Promise((accept,reject)=>{
    let settled=false;
    const finish=(error,result)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);error?reject(error):accept(result);};
    const abort=()=>{finish(Object.assign(Error('Diagnostic cancelled.'),{code:'ABORTED'}));inner.abort();};
    const timer=setTimeout(()=>{finish(Object.assign(Error('Endpoint DNS timed out.'),{code:'DNS_TIMEOUT'}));inner.abort();},timeout);
    signal?.addEventListener('abort',abort,{once:true});
    Promise.resolve().then(()=>{if(inner.signal.aborted)throw Object.assign(Error('Diagnostic cancelled.'),{code:'ABORTED'});return resolve(host,{all:true,verbatim:true,signal:inner.signal});}).then(rows=>finish(null,rows),error=>finish(error));
  });
}

export async function diagnoseEndpoint(peer,{probe,signal,resolve=lookup,timeout=3000,now=Date.now,fakeIpRanges=[],dnsSource='system',dohProvider,dohProviders,resolveDoh,dohTimeout=14000,capture=false}={}) {
  if(!peer)return {state:'unavailable',reason:'unsupported-endpoint-transport'};
  if(!['system','doh'].includes(dnsSource))throw Error('Invalid endpoint DNS source.');
  const started=now();let addresses,bootstrap;let resolutionComplete=true;const excludedAddresses=[];let resolvedAddressCount;
  if(isIP(peer.host)){
    addresses=[peer.host];bootstrap={state:'skipped',method:'literal-address',pathVerified:null};
  }else{
    try{
      if(dnsSource==='doh'){
        const selectedProviders=dnsMatrixProviders(dohProviders || [dohProvider]).map(row=>row.id);
        const resolutions=[];
        for(const provider of selectedProviders){
          try{
            const response=await resolvePeer(peer.host,{resolve:(_host,{signal})=>resolveDoh({name:peer.host,provider},{signal}),signal,timeout:dohTimeout});
            resolutions.push({provider,...endpointDohResolution(peer.host,provider,response)});
          }catch(error){
            if(error.code==='ABORTED')throw error;
            resolutions.push({provider,addresses:[],bootstrap:{method:'doh',provider,state:'failed',complete:false,pathVerified:false,reason:error.code==='DNS_TIMEOUT'?'timeout':'dns-error',attempts:[]}});
          }
        }
        addresses=[...new Set(resolutions.flatMap(row=>row.addresses))];
        const first=resolutions[0].bootstrap;
        bootstrap={...first,providers:selectedProviders,resolvers:resolutions.map(row=>({provider:row.provider,...row.bootstrap,addresses:row.addresses})),
          addressSources:resolutions.flatMap(row=>row.bootstrap.addressSources || []),
          attempts:resolutions.flatMap(row=>(row.bootstrap.attempts || []).map(attempt=>({...attempt,provider:row.provider}))),
          complete:resolutions.every(row=>row.bootstrap.complete),
          state:resolutions.every(row=>row.bootstrap.state==='ok')?'ok':addresses.length?'partial':'failed'};
        resolutionComplete=bootstrap.complete;
        if(!addresses.length)return {host:peer.host,port:peer.port,state:'unavailable',bootstrap,addresses:[],complete:false,limits:{resolutionTimeoutMs:dohTimeout,dnsResolution:bootstrap.limits,maxSelectedAddresses:8},reason:bootstrap.reason || 'dns-error'};
      }else{
        const rows=await resolvePeer(peer.host,{resolve,signal,timeout});
        addresses=[...new Set(rows.map(row=>row.address).filter(address=>isIP(address)))];
      }
      if(!addresses.length)throw Error('No valid endpoint addresses.');
      resolvedAddressCount=addresses.length;
      for(const address of addresses)if(fakeIpRanges.some(range=>containsV4(address,range)))excludedAddresses.push({address,reason:'synthetic-dns-address'});
      addresses=addresses.filter(address=>!excludedAddresses.some(row=>row.address===address));
      bootstrap={...(bootstrap || {state:'ok',method:'system-resolver',pathVerified:false}),durationMs:now()-started};
      if(excludedAddresses.length){bootstrap.state=addresses.length?'partial':'failed';bootstrap.complete=false;}
      if(!addresses.length)return {host:peer.host,port:peer.port,bootstrap,state:'unavailable',reason:'synthetic-dns-address',addresses:[],excludedAddresses,complete:false};
    }catch(error){
      if(error.code==='ABORTED')throw error;
      return {host:peer.host,port:peer.port,state:'unavailable',complete:false,limits:{resolutionTimeoutMs:dnsSource==='doh'?dohTimeout:timeout,maxSelectedAddresses:8},bootstrap:{state:'failed',complete:false,method:dnsSource==='doh'?'doh':'system-resolver',...(dnsSource==='doh'?{provider:dohProvider}:{}),pathVerified:false,reason:error.code==='DNS_TIMEOUT'?'timeout':'dns-error',errorCode:typeof error.code==='string'?error.code:null,durationMs:now()-started},addresses:[]};
    }
  }
  if(signal?.aborted)throw Object.assign(Error('Diagnostic cancelled.'),{code:'ABORTED'});
  const selected=addresses.slice(0,8);
  let result;
  try{result=await probe({addresses:selected,port:peer.port,...(capture?{capture:true}:{})},{signal});}
  catch(error){if(signal?.aborted || error.code==='ABORTED')throw error;return {host:peer.host,port:peer.port,bootstrap,addresses:selected,excludedAddresses,resolvedAddressCount:resolvedAddressCount ?? addresses.length,complete:false,truncated:addresses.length>selected.length,state:'unavailable',reason:'endpoint-probe-unavailable'};}
  if(!result || !['ok','failed','partial','unavailable'].includes(result.state))result={state:'unavailable',reason:'endpoint-probe-unavailable'};
  return {host:peer.host,port:peer.port,bootstrap,addresses:selected,resolvedAddressCount:resolvedAddressCount ?? addresses.length,excludedAddresses,
    ...result,limits:{...(result.limits || {}),resolutionTimeoutMs:bootstrap.method==='literal-address'?0:dnsSource==='doh'?dohTimeout:timeout,dnsResolution:bootstrap.limits || null,maxSelectedAddresses:8},truncated:addresses.length>selected.length,complete:result?.complete===true && resolutionComplete && addresses.length===selected.length && !excludedAddresses.length};
}
