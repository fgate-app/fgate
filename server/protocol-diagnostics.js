export async function diagnoseProtocols({name,provider,tcpConfirmed=false,signal,request}){
 const matrix=await request({name,providers:[provider],transports:tcpConfirmed?['udp']:['tcp','udp'],signal});
 const protocols=Object.fromEntries(['tcp','udp'].map(transport=>{
  const rows=(matrix.attempts || []).filter(row=>row.transport===transport);
  const confirmed=!matrix.path?.configChanged && (transport==='tcp' && tcpConfirmed || rows.some(row=>row.state==='ok' && Number.isInteger(row.rcode) && !row.truncated && (row.routeVerified || row.pathObservation?.state==='verified')));
  return [transport,{state:confirmed?'available':'unconfirmed',evidence:confirmed?(transport==='tcp' && tcpConfirmed?'website-response':'dns-response'):null}];
 }));
 const count=Object.values(protocols).filter(row=>row.state==='available').length;
 return {state:'completed',outcome:count===2?'ok':count?'partial':'unavailable',testedDomain:name,provider:matrix.providers?.[0]?.name || provider,path:matrix.path,attempts:matrix.attempts || [],protocols,limits:matrix.limits};
}
