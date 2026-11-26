// Keep measurements while removing local addressing and stored profile identities.
export function exportDiagnosticReport(report,context={ids:new Map()}) {
  const copy=JSON.parse(JSON.stringify(report)),ids=context.ids;
  const alias=id=>{if(!ids.has(id))ids.set(id,`gateway-${ids.size+1}`);return ids.get(id);};
  if(copy.profileId)copy.profileId=alias(copy.profileId);
  if(copy.route){delete copy.route.gateway;delete copy.route.prefsrc;}
  const tags=new Map((copy.path?.chain || []).map(profile=>[`p-${profile.id.slice(0,8)}`,alias(profile.id)]));
  for(const profile of copy.path?.chain || [])profile.id=alias(profile.id);
  for(const [index,attempt] of (copy.attempts || []).entries()){
    delete attempt.localAddress;delete attempt.localPort;
    if(attempt.route){delete attempt.route.prefsrc;delete attempt.route.gateway;}
    const observed=attempt.pathObservation;if(!observed)continue;
    if(observed.connectionId)observed.connectionId=`flow-${index+1}`;
    delete observed.sourcePort;delete observed.inboundPort;
    if(observed.chain)observed.chain=observed.chain.map(tag=>tag.startsWith('p-')?(tags.get(tag.replace(/-grp$/,'')) || 'other-gateway'):tag);
  }
  for(const socket of copy.path?.externalConnection?.sockets || []){
    delete socket.localAddress;delete socket.localPort;
    if(socket.route){delete socket.route.prefsrc;delete socket.route.gateway;}
  }
  for(const attempt of copy.uplinkControl?.attempts || []){
    delete attempt.localAddress;
    if(attempt.tcpCapture?.tuple){delete attempt.tcpCapture.tuple.localAddress;delete attempt.tcpCapture.tuple.localPort;}
    if(attempt.route){delete attempt.route.prefsrc;delete attempt.route.gateway;}
  }
  for(const row of copy.endpointControl?.results || [])for(const attempt of row.attempts || []){
    delete attempt.localAddress;
    if(attempt.tcpCapture?.tuple){delete attempt.tcpCapture.tuple.localAddress;delete attempt.tcpCapture.tuple.localPort;}
    if(attempt.route){delete attempt.route.prefsrc;delete attempt.route.gateway;}
  }
  if(copy.gatewayDnsMatrix?.path?.chain)for(const profile of copy.gatewayDnsMatrix.path.chain)profile.id=alias(profile.id);
  for(const [index,attempt] of [...(copy.gatewayDnsMatrix?.attempts || []),...(copy.localDns?.attempts || [])].entries()){
    delete attempt.localPort;
    const observed=attempt.pathObservation;
    if(observed){
      if(observed.connectionId)observed.connectionId=`dns-flow-${index+1}`;
      delete observed.sourcePort;delete observed.inboundPort;
      if(observed.chain)observed.chain=observed.chain.map(tag=>tag.startsWith('p-')?(tags.get(tag.replace(/-grp$/,'')) || 'other-gateway'):tag);
    }
  }
  for(const attempt of [...(copy.dnsMatrix?.attempts || []),...(copy.gatewayDnsMatrix?.attempts || []),...(copy.localDns?.attempts || [])]){
    delete attempt.localAddress;
    if(attempt.tcpCapture?.tuple){delete attempt.tcpCapture.tuple.localAddress;delete attempt.tcpCapture.tuple.localPort;}
    if(attempt.route){delete attempt.route.prefsrc;delete attempt.route.gateway;}
  }
  if(copy.gatewaySniControl?.path?.chain)for(const profile of copy.gatewaySniControl.path.chain)profile.id=alias(profile.id);
  for(const [index,attempt] of [...(copy.sniControl?.attempts || []),...(copy.gatewaySniControl?.attempts || []),...(copy.localSni?.attempts || [])].entries()){
    delete attempt.localAddress;delete attempt.localPort;
    if(attempt.route){delete attempt.route.prefsrc;delete attempt.route.gateway;}
    const observed=attempt.pathObservation;
    if(observed){
      if(observed.connectionId)observed.connectionId=`sni-flow-${index+1}`;
      delete observed.sourcePort;delete observed.inboundPort;
      if(observed.chain)observed.chain=observed.chain.map(tag=>tag.startsWith('p-')?(tags.get(tag.replace(/-grp$/,'')) || 'other-gateway'):tag);
    }
  }
  for(const section of [copy.localDns,copy.localSni])if(section?.path?.chain)for(const profile of section.path.chain)profile.id=alias(profile.id);
  if(copy.transfer?.path?.chain)for(const profile of copy.transfer.path.chain)profile.id=alias(profile.id);
  for(const [index,attempt] of (copy.transfer?.attempts || []).entries()){
    const observed=attempt.pathObservation;
    if(observed){
      if(observed.connectionId)observed.connectionId=`transfer-flow-${index+1}`;
      delete observed.sourcePort;delete observed.inboundPort;
      if(observed.chain)observed.chain=observed.chain.map(tag=>tag.startsWith('p-')?(tags.get(tag.replace(/-grp$/,'')) || 'other-gateway'):tag);
    }
  }
  for(const key of ['uplinkControl','dnsMatrix','sniControl','speedtest','mtu','tlsVersions','http3','pairedTransfer','proxyStrategies','pathComparison'])if(copy[key])copy[key]=exportDiagnosticReport(copy[key],context);
  if(copy.protocols?.attempts)copy.protocols=exportDiagnosticReport(copy.protocols,context);
  if(copy.failureInvestigation)copy.failureInvestigation=exportDiagnosticReport(copy.failureInvestigation,context);
  if(copy.targetReports)copy.targetReports=copy.targetReports.map(target=>exportDiagnosticReport(target,context));
  if(copy.endpointRoute)for(const result of copy.endpointRoute.results || [])for(const hop of result.hops || []){
    if(hop.address && (/^(?:10\.|127\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(hop.address) || /^(?:::1$|f[cd]|fe[89ab])/i.test(hop.address))){delete hop.address;hop.addressRedacted=true;}
  }
  if(copy.results)copy.results=copy.results.map(row=>exportDiagnosticReport(row,context));
  if(copy.controls)copy.controls=copy.controls.map(row=>exportDiagnosticReport(row,context));
  if(copy.controlGatewayId)copy.controlGatewayId=alias(copy.controlGatewayId);
  delete copy.controlName;
  for(const flow of copy.flows || [])if(flow.tcpCapture?.tuple){delete flow.tcpCapture.tuple.localAddress;delete flow.tcpCapture.tuple.localPort;}
  copy.anonymized=true;
  return copy;
}
