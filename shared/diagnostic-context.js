export const isLocalDiagnostic=profile=>['direct','zapret'].includes(profile?.engine);

// Local listeners select an egress; they are not an external proxy or VPN peer.
// Normalize the live API as well as its export, even for older report producers.
export function diagnosticContext(report,profile){
  report.gatewayKind=profile?.engine==='direct'?'direct':profile?.engine==='zapret'?'dpi-bypass':'proxy';
  report.gatewayEngine=profile?.engine || null;report.gatewayProtocol=profile?.protocol || null;
  if(!isLocalDiagnostic(profile))return report;
  const localPath=path=>{
    if(!path)return;
    path.mode=report.gatewayKind;path.enforcement='local-listener';
    path.verificationScope='selected-local-egress';
    delete path.externalConnection;delete path.observedRoute;delete path.routeVerified;
  };
  localPath(report.path);
  for(const attempt of report.attempts || [])attempt.stages=(attempt.stages || []).filter(stage=>!['proxy-connect','tunnel-protocol','bootstrap-dns'].includes(stage.id));
  delete report.endpointControl;delete report.uplinkControl;delete report.dnsMatrix;delete report.dnsPathComparisons;delete report.sniControl;
  if(report.gatewayDnsMatrix){report.localDns=report.gatewayDnsMatrix;delete report.gatewayDnsMatrix;}
  if(report.gatewaySniControl){report.localSni=report.gatewaySniControl;delete report.gatewaySniControl;}
  for(const section of [report.localDns,report.localSni,report.transfer,report.speedtest,report.protocols])if(section){
    localPath(section.path);section.mode=report.gatewayKind;
    for(const row of section.attempts || []){
      delete row.routeVerified;delete row.interface;delete row.mark;
      if(row.mode)row.mode=report.gatewayKind;
      if(row.failedStage==='proxy-connect')row.failedStage='local-listener';
      for(const stage of row.stages || [])if(stage.id==='proxy-connect')stage.id='local-listener';
    }
  }
  return report;
}
