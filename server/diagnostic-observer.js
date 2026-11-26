import {isIP} from 'node:net';

const connections=snapshot=>{if(snapshot?.connections===null)return [];if(!Array.isArray(snapshot?.connections))throw Error('Invalid controller snapshot.');return snapshot.connections;};
const loopback=ip=>ip==='127.0.0.1' || ip==='::1' || ip==='::ffff:127.0.0.1';
// Correlate a fresh CONNECT by its exact loopback tuple. GeoIP/health requests
// use the same inbound, so matching by inbound name alone would be incorrect.
export async function observeDiagnostic(controller,{endpoint,url,localPort,signal,interval=50,network='tcp'}) {
  if(!['tcp','udp'].includes(network))throw Error('Invalid diagnostic network.');
  const abort=new AbortController(),combined=signal?AbortSignal.any([signal,abort.signal]):abort.signal;
  const target=new URL(url),hostname=target.hostname.replace(/^\[|\]$/g,''),port=Number(target.port || 443);
  const matchesTarget=m=>isIP(hostname)?m.destinationIP===hostname && (!m.host || m.host===hostname):m.host===hostname;
  let baseline;
  try{const snapshot=await controller('/connections',{signal:combined,timeout:1000});baseline=new Set(connections(snapshot).map(row=>row.id));}
  catch{return {finish:async()=>({state:'unavailable',reason:'controller-unavailable'})};}
  let stopped=false,timer,wake,seen=new Map(),failed=false;
  const sample=async()=>{
    const snapshot=await controller('/connections',{signal:combined,timeout:1000});
    for(const row of connections(snapshot)){
      const m=row.metadata || {};
      if(baseline.has(row.id) || !loopback(m.sourceIP) || Number(m.sourcePort)!==localPort ||
         Number(m.inboundPort)!==endpoint.port || m.inboundName!==`fg-geo-${endpoint.id}` ||
         !matchesTarget(m) || Number(m.destinationPort)!==port || m.network!==network)continue;
      if(typeof row.id!=='string' || !Array.isArray(row.chains))continue;
      const expected=[endpoint.tag,endpoint.tag?.replace(/-grp$/,'')];
      const chain=row.chains.filter(tag=>typeof tag==='string' && /^(DIRECT|REJECT|REJECT-DROP|p-[a-f\d]{8}(?:-grp)?|zapret-[\w-]+)$/.test(tag));
      seen.set(row.id,{connectionId:row.id,state:chain.some(tag=>expected.includes(tag))?'verified':chain.length?'mismatch':'unavailable',
        chain,target:{host:hostname,address:isIP(m.destinationIP || '')?m.destinationIP:null,port},
        sourcePort:localPort,inboundPort:endpoint.port});
    }
  };
  const running=(async()=>{
    const deadline=Date.now()+10000;
    while(!stopped && !combined.aborted && Date.now()<deadline){
      try{await sample();}catch{if(!combined.aborted)failed=true;}
      if(stopped || combined.aborted)break;
      await new Promise(resolve=>{wake=resolve;timer=setTimeout(resolve,interval);});
    }
  })();
  return {async finish(raw,{sampleFinal=false}={}){
    if(sampleFinal && !combined.aborted)try{await sample();}catch{if(!combined.aborted)failed=true;}
    stopped=true;clearTimeout(timer);wake?.();abort.abort();await running;
    // curl reports its actual local port; reject evidence if binding failed.
    if(Number(raw?.local_port)!==localPort || !loopback(raw?.local_ip))return {state:'unavailable',reason:'client-tuple-unconfirmed'};
    if(seen.size!==1)return {state:'unavailable',reason:seen.size?'ambiguous-flow':failed?'controller-unavailable':'flow-not-observed'};
    return {...[...seen.values()][0],evidence:'engine-connection-loopback-tuple'};
  }};
}
