import {dnsEvidence,sniEvidence,probeMessage} from './diagnostic-evidence.js';
import {proxyFlowMessages} from './proxy-flow-evidence.js';
const flowDetails=attempt=>(attempt.flows || []).filter(row=>row.evidence).map(row=>({message:proxyFlowMessages[row.evidence.code] || proxyFlowMessages['capture-unavailable']}));
// User-facing conclusions use measured stages, never an inferred DPI diagnosis.
// Message keys are translated by the UI; raw evidence stays in the JSON report.
const verified=row=>row?.routeVerified===true || row?.pathObservation?.state==='verified';
const aggregate=rows=>!rows.length?'unavailable':rows.every(row=>row.state==='ok')?'ok':rows.some(row=>['ok','partial'].includes(row.state))?'partial':rows.every(row=>row.state==='failed')?'failed':'unavailable';
const stage=(row,id)=>row.stages?.find(item=>item.id===id);
const redirectLabel=value=>{try{const url=new URL(value);return url.host+(url.pathname==='/'?'':url.pathname.replace(/\/+$/,''));}catch{return value;}};
const redirectChain=row=>row.redirects?.length?[...row.redirects.map(hop=>hop.url),row.finalUrl || row.redirects.at(-1).nextUrl].filter(Boolean).map(redirectLabel).join(' → '):undefined;
const target=url=>{try{return new URL(url).hostname;}catch{return '';}};
const actions={repeat:'Repeat the check. If it fails again, download the JSON report for support.',
  gateway:'Try another gateway and check this gateway’s settings with its provider.',
  dns:'Try another DNS resolver, then repeat the check.',
  network:'Check the device’s Internet connection and router, then repeat the check.',
  server:'Check the server address and port with the proxy provider.',
  clock:'Check the device’s date and time. If they are correct, contact the gateway provider.'};

export function websiteFinding(row){
  if(row.redirects?.length && row.outcome==='unavailable')return {state:'unavailable',message:row.observation==='redirect-loop'?'The website redirects in a loop.':row.observation==='redirect-limit'?'The website exceeded the redirect limit.':row.observation==='redirect-target-unsupported'?'The redirect destination is not a supported HTTPS address.':'The redirect check could not be completed.',next:actions.repeat};
  if(row.pathObservation?.state==='mismatch')return {state:'failed',message:'The test used a different gateway. This result cannot describe the selected connection.',next:actions.repeat};
  if(row.outcome==='ok')return verified(row)?{state:'ok',message:'The website opened through the selected connection.'}:{state:'unavailable',message:'The website responded, but the selected connection could not be confirmed.',next:actions.repeat};
  if(row.observation==='certificate-error')return {state:'failed',message:'The secure connection failed because the website certificate could not be verified.',next:actions.clock};
  const failed=row.stages?.find(item=>item.state==='failed');
  if(failed?.id==='proxy-connect' || failed?.id==='local-listener')return {state:'failed',message:'FreedomGate could not open its local connection for this test.',next:actions.repeat};
  if(failed?.id==='tls' || ['tls-error','tls-alert'].includes(row.observation))return {state:'failed',message:'The connection opened, but the secure connection to the website did not complete.',next:actions.gateway};
  if(stage(row,'http')?.status>=300 && stage(row,'http')?.status<400)return {state:'unavailable',message:'The website returned a redirect. The destination was not checked.',next:'Add the final destination domain to the test list and repeat the check. A redirect alone does not indicate a gateway failure.'};
  if(stage(row,'http')?.status)return {state:'failed',message:'The website returned an error instead of a successful response.',next:actions.repeat};
  if(row.observation==='timeout')return {state:'failed',message:'The website did not respond within the time limit. These checks do not show where the reply was lost.',next:actions.gateway};
  if(['connect-error','connection-reset','unexpected-eof'].includes(row.observation))return {state:'failed',message:'The connection to the website could not be established or was interrupted.',next:actions.gateway};
  return {state:'unavailable',message:'The test could not complete. This does not establish a network failure.',next:actions.repeat};
}

export function captureFinding(capture){
  if(capture?.state!=='observed' || !capture.probeCorrelated)return {state:'unavailable',message:'The packet check could not observe this connection. It does not show whether the server is reachable.',next:actions.repeat};
  const incoming=(capture.packets || []).filter(row=>row.direction==='inbound');
  if(incoming.some(row=>row.flags?.includes('RST')))return {state:'failed',message:'A refusal or reset was received while connecting to the server. The server or a device on the route rejected the connection.',next:actions.server};
  if(incoming.some(row=>row.flags?.includes('SYN') && row.flags?.includes('ACK')))return {state:'ok',message:'The server answered the connection request.'};
  if(incoming.length)return {state:'unavailable',message:'Packets were received, but the connection handshake was not confirmed.',next:actions.repeat};
  return {state:'failed',message:'A connection request left the device, but no reply was observed. These checks cannot distinguish a server outage from filtering or a problem along the route.',next:actions.server};
}

export function diagnosticSummary(report,{providers=[]}={}){
  if(!report)return [];
  if(report.targetReports){
    const shared=diagnosticSummary({...report,targetReports:undefined},{providers});
    return [...shared.filter(card=>!['internet','downloads','dns-direct','dns-gateway','sni-direct','sni-gateway'].includes(card.id)),...report.targetReports.flatMap(target=>diagnosticSummary({...target,gatewayKind:report.gatewayKind,path:{...target.path,configChanged:report.path?.configChanged || target.path?.configChanged}},{providers}).filter(card=>card.id!=='websites').map(card=>({...card,id:card.id+':'+target.domain,target:target.domain})))];
  }
  const cards=[],add=card=>cards.push(card),local=['direct','dpi-bypass'].includes(report.gatewayKind);
  if(report.blocklist){const entry=report.blocklist,available=['listed','not-listed'].includes(entry.state);add({id:'blocklist',title:'Domain blocklist lookup',state:available?'ok':'unavailable',statusMessage:entry.state==='listed'?'Found in the list':entry.state==='not-listed'?'Not found in the list':'List unavailable',message:entry.state==='listed'?'The domain or its parent is in the diagnostic list. This is reference information; connection checks determine actual availability.':entry.state==='not-listed'?'No matching entry was found. A domain can still be blocked even when it is absent from this list.':'Download the diagnostic domain list in Modules, then run diagnostics again.',rows:available?[{label:'Source',message:'{source} · {revision}',params:{source:entry.source,revision:entry.ref?.slice(0,7) || '—'}},{label:'List downloaded',message:'{date}',params:{date:entry.updatedAt?.slice(0,10)}},...(entry.matchedDomain?[{label:'Matching domain',message:'{domain}',params:{domain:entry.matchedDomain}}]:[])]:[]});}
  const websites=(report.attempts || []).map(row=>({target:target(row.url),redirects:redirectChain(row),...(report.path?.configChanged?{state:'unavailable',message:'The settings changed during the test. Run diagnostics again before using these results.'}:websiteFinding(row))}));
  const webState=aggregate(websites);
  if((websites.length || !report.failureInvestigation) && !(report.torConnection && report.torConnection.outcome!=='ok' || report.lanternConnection && report.lanternConnection.outcome!=='ok'))add({id:'websites',title:'Opening websites',state:webState,
    message:webState==='ok'?'The checked websites opened through this connection.':webState==='partial'?(websites.some(row=>row.state==='failed')?'Some websites opened and others failed. The connection works for part of the checked traffic.':'Some websites opened. Other website checks could not be completed.'):webState==='failed'?'None of the checked websites opened. See the failed step below.':'There is not enough verified information to assess this connection.',
    rows:websites});
  if(report.path?.configChanged)add({id:'configuration',title:'Connection settings',state:'unavailable',message:'The settings changed during the test. Run diagnostics again before using these results.',next:actions.repeat});
  const endpoint=report.endpointControl;
  if(!local && endpoint){
    const bootstrap=endpoint.bootstrap;
    if(bootstrap && bootstrap.method!=='literal-address' && !(bootstrap.state==='ok' && bootstrap.resolvers?.length))add({id:'server-dns',title:'Finding the proxy server address',state:bootstrap?.state==='ok'?'ok':bootstrap?.state==='partial'?'partial':'unavailable',
      message:bootstrap?.state==='ok'?'The server name was resolved to an address.':bootstrap?.state==='partial'?'Only some server addresses could be checked. The name lookup is incomplete.':'The proxy server name could not be resolved to a usable address. The server connection was not tested.',next:bootstrap?.state==='ok'?undefined:actions.dns});
    if(bootstrap?.resolvers?.length){
      const evidence=dnsEvidence({attempts:bootstrap.resolvers.flatMap(resolver=>(resolver.attempts?.length?resolver.attempts:[{state:'unavailable',reason:resolver.reason}]).map(attempt=>({...attempt,provider:resolver.provider,transport:'doh',routeVerified:attempt.pathVerified===true})))},providers),rows=evidence.rows;
      add({id:'server-resolvers',title:'Proxy hostname DNS checks',state:aggregate(rows),message:'The proxy hostname is checked with the selected resolvers. Resolved IP addresses are tested on the configured proxy port.',rows});
    }
    const rows=(endpoint.results || []).map(row=>{
      const reasons=(row.attempts || []).map(item=>item.reason);
      return {target:(row.address?.includes(':')?'['+row.address+']':row.address)+(endpoint.port?':'+endpoint.port:''),state:row.state==='unstable'?'partial':row.state,
        message:row.state==='ok'?'A direct connection to this server address succeeded.':row.state==='unstable'?'The server address responded inconsistently across repeated checks.':reasons.includes('refused')?'The connection to this server address was rejected.':reasons.includes('timeout')?'No answer arrived from this server address before the time limit.':'A direct connection to this server address could not be checked.'};
    });
    const state=aggregate(rows);
    const unsupported=endpoint.reason==='unsupported-endpoint-transport';
    add({id:'server',title:'Reaching the proxy server',state,message:unsupported?'A separate direct server check is not available for this gateway type. Use the website results to assess the connection.':state==='ok'?'The server accepts direct connections on port {port}.':state==='partial'?'Some server addresses are reachable and others are not.':'The direct server check did not confirm reachability. Website checks through the gateway are reported separately.',params:{port:endpoint.port || '—'},rows,next:state==='ok' || unsupported?undefined:actions.server});
    for(const row of endpoint.results || [])for(const attempt of row.attempts || [])if(attempt.tcpCapture)add({id:'packets',title:'Server connection check',...captureFinding(attempt.tcpCapture)});
  }
  if(report.failureInvestigation && report.phase!=='endpoint-only'){
    add({id:'server-investigation',title:'Proxy connection failure investigation',state:'failed',message:'The proxy server and a request through the gateway both failed. Remaining website checks were skipped; repeated IP and packet checks are shown below.',rows:[]});
    for(const card of diagnosticSummary({endpointControl:report.failureInvestigation.endpointControl},{providers}).filter(card=>['server','packets'].includes(card.id)))add({...card,id:'investigation-'+card.id,title:card.id==='server'?'Repeated proxy IP checks':'Repeated server response check'});
  }
  if(report.endpointRoute){
    add({id:'server-route',title:'Route to the proxy server',state:report.endpointRoute.results?.some(row=>row.targetReached)?'ok':'unavailable',
      message:'TCP probes show which network hops answered. A silent hop does not identify a blocking device.',
      rows:(report.endpointRoute.results || []).map(row=>({target:row.address,state:row.targetReached?'ok':'unavailable',message:row.targetReached?'The node answered at hop {hops}.':row.lastReplyTtl?'The last reply was from hop {hops}; the node did not answer within the probe limits.':'No hop count could be established within the probe limits.',params:{hops:row.hopCount || row.lastReplyTtl}}))});
  }
  if(report.proxyStrategies){
    const sweep=report.proxyStrategies;
    add({id:'proxy-strategies',title:'DPI bypass strategy tests',state:sweep.outcome || 'unavailable',
      message:sweep.reason==='tcp-unreachable'?'The proxy TCP port is unreachable. Payload strategies require an established TCP connection.':sweep.reason==='unsupported-strategy-client'?'Isolated strategy testing is not available for this proxy type.':sweep.reason==='configuration-changed'?'The settings changed during the test. Run diagnostics again before using these results.':sweep.recommendations?.length?'A bypass strategy restored the proxy connection in repeated tests. The working proxy settings have not been changed.':'No reproducible improvement was confirmed. See the result of each strategy below.',
      rows:(sweep.results || []).map(row=>({label:row.label,target:row.address,operation:row.address,state:row.state==='running'?'unavailable':row.state,
        message:row.reason==='endpoint-tcp-unreachable'?'The proxy TCP port is unreachable. Payload strategies require an established TCP connection.':row.reason==='baseline-working'?'The proxy responded without bypass. Strategy testing for this IP was stopped.':row.reason==='baseline-inconclusive'?'The control test could not confirm a proxy failure. Strategy testing for this IP was stopped.':row.state==='ok'?'The proxy returned a secure website response in both attempts.':row.state==='partial'?'The strategy worked inconsistently across repeated requests.':row.state==='failed'?'Both requests through this proxy failed.':'The strategy test could not be completed.',
        details:[...flowDetails(row),...(row.attempts || []).flatMap(attempt=>[...(attempt.state!=='ok'?[{message:probeMessage(attempt)}]:[]),...flowDetails(attempt)])]}))});
  }
  if(report.pathComparison){
    const comparison=report.pathComparison;
    add({id:'path-comparison',title:'Connection path comparison',state:comparison.outcome==='same-success'?'ok':comparison.outcome==='path-dependent'?'partial':'unavailable',
      message:comparison.reason==='no-control-gateway'?'No other enabled proxy gateway is available. Path comparison requires a working gateway.':comparison.reason==='no-verified-control'?'No working control gateway was confirmed within the check limits. Path comparison could not run.':comparison.reason==='unsupported-comparison-client'?'Path comparison is not available for this proxy type or an already wrapped proxy.':comparison.reason==='endpoint-address-unavailable'?'The proxy server has no usable IP address for path comparison.':comparison.reason==='configuration-changed'?'The settings changed during the test. Run diagnostics again before using these results.':comparison.reason==='budget-exhausted'?'The comparison time limit was reached. No conclusion about the connection path was made.':comparison.outcome==='path-dependent'?'The same proxy endpoint worked through the control gateway while both sets of direct attempts failed. The failure depends on the connection path; its cause is not established.':comparison.outcome==='same-success'?'The proxy responded directly and through the control gateway in all repeated attempts.':comparison.outcome==='same-failure'?'The proxy did not respond successfully through either path. The comparison did not establish a path-specific failure.':'The path comparison was inconclusive.',
      rows:[...(comparison.controlGatewayId?[{target:comparison.controlName || '',state:'ok',message:'Automatically selected working control gateway.'}]:[]),...(comparison.results || []).map(row=>({target:row.address,label:({'direct-before':'Direct connection before the control',control:'Connection through the control gateway','direct-after':'Direct connection after the control'})[row.id],operation:row.address,state:row.state,
        message:row.reason==='endpoint-tcp-unreachable'?'The TCP connection to the proxy endpoint failed; no tunnel request was sent.':row.state==='ok'?'The proxy tunnel returned a verified secure response in both attempts.':row.state==='failed'?'Both proxy tunnel attempts failed.':'The connection check could not be completed.',
        details:[...flowDetails(row),...(row.attempts || []).flatMap(flowDetails)]}))]});
  }
  if(!local && report.uplinkControl){
    const rows=(report.uplinkControl.attempts || []).map(row=>({target:target(row.url),redirects:redirectChain(row),...websiteFinding(row),...(websiteFinding(row).state==='ok'?{message:'The tested domain opened without the gateway.'}:{})})),state=aggregate(rows);
    add({id:'internet',title:'Internet access without the gateway',state,
      message:state==='ok'?'The tested domain opened without the gateway.':state==='failed'?'The tested domain did not open without the gateway. See the request result below.':'The availability of this domain without the gateway could not be fully checked.'});
  }
  for(const [id,matrix] of [['dns-direct',report.dnsMatrix],['dns-gateway',report.gatewayDnsMatrix || report.localDns]])if(matrix){
    const evidence=dnsEvidence(matrix,providers),rows=evidence.rows,state=aggregate(rows);
    add({id,title:id==='dns-direct'?'Website address lookup without the gateway':'Website address lookup through this connection',state,
      description:'DNS translates the tested domain into IP addresses. These requests compare DNS resolvers and delivery methods for this one domain.',
      message:rows.length?'DNS requests: {ok} succeeded, {failed} failed, {unavailable} could not be completed.':'No DNS query results were returned.',params:evidence.params,rows,next:state==='ok'?undefined:actions.dns});
  }
  for(const [id,matrix] of [['sni-direct',report.sniControl],['sni-gateway',report.gatewaySniControl || report.localSni]])if(matrix){
    const informative=matrix.path?.configChanged?[]:(matrix.comparisons || []).filter(row=>row.state==='observed' && ['ok','failed'].includes(row.experimentState) && verified(matrix.attempts?.find(attempt=>attempt.provider===row.provider && attempt.kind==='foreign-sni')));
    const difference=informative.some(row=>row.experimentState==='failed');
    const evidenceRows=sniEvidence(matrix,providers);
    const incomplete=informative.length!==(matrix.comparisons || []).length || evidenceRows.some(row=>row.state!=='ok');
    add({id,title:id==='sni-direct'?'Website name check without the gateway':'Website name check through this connection',state:!informative.length?'unavailable':difference || incomplete?'partial':'ok',
      message:!informative.length?'The control checks were not sufficient to assess name-based filtering.':difference?'The connection behaved differently when the website name changed. This alone does not establish provider blocking.':incomplete?'Some website name checks could not be completed. The remaining checks did not show a failure when the name changed.':'No failure associated with changing the website name was observed in these checks.',description:'This compares secure connections to the same IP address with different site names, then connects to the website IP. Each request and its result are listed below.',rows:evidenceRows,next:!informative.length || difference || incomplete?actions.repeat:undefined});
  }
  if(report.transfer?.attempts?.some(row=>row.mode==='site-response')){
    const rows=report.transfer.attempts.map(row=>({target:row.domain || target(row.url),redirects:redirectChain(row),state:row.complete && verified(row) && !report.transfer.path?.configChanged?'ok':row.outcome==='failed'?'failed':'unavailable',message:row.observation==='response-exceeds-sample-limit'?'The response exceeded the sample limit. A bounded transfer could not be checked.':row.complete?'The website response was received within the sample limit. This is not a speed test.':'The website response could not be received in full within the limits.'}));
    add({id:'downloads',title:'Receiving website data',state:aggregate(rows),message:'Up to 1 MiB is requested from each website. Large responses or redirects may prevent this check.',rows});
  }else if(report.transfer){
    const rows=(report.transfer.attempts || []).map(row=>({target:row.expectedBytes===65536?'64 KiB':'1 MiB',state:report.transfer.path?.configChanged?'unavailable':row.complete && verified(row)?'ok':row.outcome==='failed'?'failed':'unavailable',message:row.complete && verified(row) && !report.transfer.path?.configChanged?'The entire test file was downloaded.':'The test file was not received in full through the selected connection.'})),state=aggregate(rows);
    add({id:'downloads',title:'Downloading files',state,message:state==='ok'?'Both test files downloaded completely.':state==='partial'?'Only part of the download checks succeeded. Short requests may work while larger transfers fail.':'A complete file download was not confirmed.',rows,next:state==='ok'?undefined:actions.gateway});
  }
  if(report.lanternConnection)add({id:'lantern',title:'Lantern proxy network',state:report.lanternConnection.outcome || 'unavailable',message:report.lanternConnection.outcome==='ok'?'The Lantern proxy client is running.':'Lantern could not connect. Website checks were not started.',next:report.lanternConnection.outcome==='ok'?undefined:'Try another network or gateway, or retry later.'});
  if(report.torConnection){const value=report.torConnection;add({id:'tor',title:'Tor connection',state:value.outcome || 'unavailable',message:value.outcome==='ok'?(value.mode==='snowflake'?'Connected to Tor through Snowflake.':'Connected to Tor directly.'):'Tor did not connect. Website checks were not started.',next:value.outcome==='ok'?undefined:'Check the Internet connection and Tor module, then retry. If direct Tor is blocked, try Snowflake only.',rows:(value.attempts || []).map(row=>({target:row.mode==='snowflake'?'Snowflake':'Direct Tor connection',state:row.state==='ok'?'ok':'failed',message:row.state==='ok'?'Tor is connected.':row.reason==='bootstrap-timeout'?'Tor did not finish connecting within the time limit.':'Tor connection attempt failed.'}))});}
  if(report.protocols){
    const result=report.protocols,rows=['tcp','udp'].map(protocol=>{
      const value=result.protocols?.[protocol],available=value?.state==='available' && !result.path?.configChanged;
      return {target:protocol.toUpperCase(),state:available?'ok':'unavailable',message:value?.state==='unsupported'?(value.reason==='lantern-tcp-only'?'Lantern does not support UDP traffic.':'Tor does not support UDP traffic.'):available?(value.evidence==='website-response'?'Confirmed by a website response through the gateway.':'Confirmed by a DNS response through the gateway.'):'Protocol availability was not confirmed.',details:available?[]:(result.attempts || []).filter(row=>row.transport===protocol).map(row=>({message:probeMessage(row,result.path?.configChanged)})).filter((row,index,all)=>all.findIndex(other=>other.message===row.message)===index)};
    });
    add({id:'protocols',title:'TCP and UDP through the gateway',state:result.outcome || 'unavailable',statusMessage:rows.every(row=>row.state==='ok')?'TCP and UDP confirmed':rows.some(row=>row.state==='ok')?'One protocol confirmed':'Protocols unconfirmed',message:'TCP and UDP are checked on the selected connection. A missing response is reported as unconfirmed.',rows});
  }
  if(report.mtu){const mtu=report.mtu;add({id:'mtu',title:'Route MTU to the proxy server',state:mtu.outcome || 'unavailable',statusMessage:mtu.outcome==='ok'?'Measurements collected':'Could not check',message:mtu.reason==='wrapped-route'?'This proxy uses another gateway; its direct uplink route is not the tunnel route.':mtu.reason==='endpoint-address-unavailable'?'No proxy server IP address was available for the MTU check.':mtu.reason==='route-unavailable'?'No direct uplink route to this proxy server was available.':mtu.reason==='route-changed'?'The route changed during the check. Repeat the measurement.':mtu.lowerBound?'The server answered with packets of at least {bytes} bytes on the direct uplink route.':mtu.reportedMtu?'A packet-size limit of {bytes} bytes was observed on the direct uplink route.': 'No ICMP echo reply was received. This does not establish an MTU problem.',params:{bytes:mtu.lowerBound || mtu.reportedMtu},rows:(mtu.attempts || []).map(row=>({target:String(row.packetBytes)+' B',state:row.state==='ok'?'ok':row.state==='limited'?'partial':'unavailable',message:row.state==='ok'?'The server replied.':row.reason==='local-size-limit'?'The local interface rejected this packet size.':row.reason==='icmp-size-limit'?'The route returned an ICMP packet-size limit.':row.reason==='ping-unavailable'?'The ping tool is unavailable.':row.reason==='permission-denied'?'The test process lacked permission to send the request.':'No ICMP reply within the time limit.',details:row.mtu?[{message:'Reported MTU: {bytes} bytes.',params:{bytes:row.mtu}}]:[]}))});}
  if(report.http3){const h3=report.http3;add({id:'http3',title:'HTTP/3 and QUIC',state:h3.outcome || 'unavailable',message:h3.outcome==='ok'?'The website responded over HTTP/3 through this gateway.':'HTTP/3 availability was not confirmed. The website or gateway may not support it; this alone does not prove filtering.',rows:(h3.attempts || []).map(row=>({target:'HTTP/3 · QUIC',state:row.state,message:row.state==='ok'?'The secure connection succeeded.':probeMessage(row)}))});}
  if(report.tlsVersions){const tls=report.tlsVersions;add({id:'tls-versions',title:'TLS 1.2 and TLS 1.3',state:tls.outcome || 'unavailable',message:tls.address?'Both TLS versions use the same server address and website name. A difference does not by itself prove filtering.':'No verified website address was available for the TLS comparison.',rows:(tls.attempts || []).map(row=>({target:`TLS ${row.version}`,state:row.state,message:row.state==='ok'?'The secure connection succeeded.':probeMessage(row)}))});}
  if(report.pairedTransfer){const pair=report.pairedTransfer;
    add({id:'paired-transfer',title:'Same download through both paths',state:pair.outcome || 'unavailable',message:pair.outcome==='ok'?'Both paths delivered the complete 64 KiB sample.':pair.outcome==='partial'?'Only one path delivered the complete sample. Compare the results below; this alone does not establish the cause.':'The paired download did not complete on both verified paths.',rows:(pair.results || []).map(row=>{const attempt=row.attempts?.[0];return {label:row.id==='direct'?'Without the gateway':'Through the gateway',message:row.state==='ok'?'Received {bytes} bytes in {duration} ms.':row.reason==='configuration-changed'?'The settings changed during this request.':row.reason==='path-unverified'?'The response arrived, but its route could not be confirmed.':'The request could not be completed.',params:{bytes:attempt?.bytes ?? 0,duration:attempt?.durationMs ?? 0}};})});
  }
  if(report.speedtest){
    const speed=report.speedtest,rows=[['download','Download speed','downloadMbps'],['upload','Upload speed','uploadMbps'],['latency','Response time','responseMs']].map(([kind,label,key])=>{
      const value=speed.path?.configChanged?null:speed.metrics?.[key],measured=Number.isFinite(value) && value>=0;
      return {label,state:measured?'ok':'unavailable',message:measured?(kind==='latency'?'{value} ms':'{value} Mbit/s'):'Could not measure.',params:{value},details:(speed.attempts || []).filter(row=>row.kind===kind && row.outcome!=='ok').map(row=>({message:probeMessage({...row,state:row.outcome})}))};
    });
    add({id:'speedtest',title:'Gateway speedtest',state:speed.state==='completed'?speed.outcome || 'unavailable':'unavailable',message:'Short download, upload and response-time measurement to Cloudflare through the selected connection.',rows});
  }
  if(local)for(const card of cards){
    if(card.next===actions.gateway)card.next=actions.network;
    for(const row of card.rows || [])if(row.next===actions.gateway)row.next=actions.network;
  }
  return cards;
}

// Overall status includes incomplete runs and optional checks; reachability alone
// can never override a failed end-to-end website check.
export function diagnosticOverview(report){
 const findings=diagnosticSummary(report),web=findings.find(row=>row.id==='websites');
 const state=report?.progress?.state;
 if(state==='budget-exhausted')return {state:'unavailable',title:'Diagnostic time limit reached',message:'The time limit was reached. Completed checks have been kept.',next:'Run fewer domains or enable fewer checks, then repeat diagnostics.'};
 if(state && state!=='completed')return {state:'unavailable',title:state==='cancelled'?'Diagnostics cancelled':state==='interrupted'?'Diagnostics interrupted':'Diagnostics in progress',message:'Only completed checks are shown. This is not a complete assessment of the gateway.',next:state==='running'?null:actions.repeat};
 // Direct controls and synthetic DNS/SNI comparisons do not assess website
 // access through the selected gateway. Only actual gateway traffic can qualify it.
 if(report?.lanternConnection && report.lanternConnection.outcome!=='ok')return {state:'failed',title:'Lantern could not connect.',message:'Lantern could not connect. Website checks were not started.',next:'Try another network or gateway, or retry later.'};
 if(report?.torConnection && report.torConnection.outcome!=='ok')return {state:'failed',title:'Tor could not connect.',message:'Tor did not connect. Website checks were not started.',next:'Check the Internet connection and Tor module, then retry. If direct Tor is blocked, try Snowflake only.'};
 const transferIssues=findings.filter(row=>row.id.split(':')[0]==='downloads' && row.state!=='ok');
 if(web?.state==='ok' && !transferIssues.length)return {state:'ok',title:'The connection works',message:'All tested websites opened through the selected connection.'};
 if(web?.state==='ok')return {state:'partial',title:'Websites opened; the data check did not fully pass',message:'Opening websites succeeded through this connection. See the data-reception results for the affected domains.',next:transferIssues.find(row=>row.next)?.next};
 if(report.pathComparison?.outcome==='path-dependent')return {state:'failed',title:'The proxy works through another gateway',message:'Direct attempts failed, while the same proxy endpoint responded through the automatically selected control gateway.',next:'Use a working outer gateway for this proxy, or share the JSON report with support to investigate the direct path.'};
 if(report.phase==='endpoint-only' && report.pathComparison?.outcome==='same-success')return {state:'partial',title:'The proxy responded in the repeated connection checks',message:'The initial server check failed, but repeated proxy connections worked directly and through the control gateway.',next:actions.repeat};
 if(report.proxyStrategies?.recommendations?.length)return {state:'partial',title:'A DPI bypass strategy was found',message:'The original proxy connection failed, but an isolated bypass test succeeded repeatedly. The working proxy settings have not been changed.',next:'See the successful strategy in the gateway checks.'};
 if(report.phase==='endpoint-only')return {state:'failed',title:'The proxy server is unavailable',message:'The proxy server could not be reached. See its DNS, IP, connection and route checks.',next:actions.server};
 if(report.failureInvestigation)return {state:'failed',title:'Proxy connection failure investigation',message:'The proxy server and a request through the gateway both failed. Remaining website checks were skipped; repeated IP and packet checks are shown below.',next:actions.server};
 const failedTargets=web?.rows.filter(row=>row.state==='failed').map(row=>row.target) || [],uncheckedTargets=web?.rows.filter(row=>row.state==='unavailable').map(row=>row.target) || [];
 if(web?.state==='partial' && !failedTargets.length)return {uncheckedTargets,state:'partial',title:'Some websites need another check',message:'Some websites opened successfully, confirming Internet access. Other checks were inconclusive; this does not establish a gateway failure.',next:web.rows.find(row=>row.state==='unavailable' && row.next)?.next || actions.repeat};
 if(web?.state==='partial')return {failedTargets,uncheckedTargets,state:'partial',title:'Some websites did not open',message:'Some websites opened successfully, confirming Internet access. Other websites did not open; this alone does not establish a connection outage.',next:'Open the failed websites through another gateway or network, then compare the results.'};
 const priority=findings.find(row=>row.id==='configuration') || web;
 return {state:web?.state || 'unavailable',title:web?.state==='partial'?'The connection works partially':web?.state==='failed'?'The checked websites did not open':'Not enough information',message:priority?.message || 'There is not enough verified information to assess this connection.',next:priority?.next || web?.rows?.find(row=>row.next)?.next || actions.repeat};
}

// Group presentation without changing the report schema or the overall assessment.
export function diagnosticGroups(report,options={}){
 if(!report)return [];
 if(!report.targetReports){const cards=diagnosticSummary(report,options);return cards.length?[{id:'gateway',title:'Gateway checks',cards}]:[];}
 const common=diagnosticSummary(report,options).filter(card=>!card.target && card.id!=='websites');
 return [...(common.length?[{id:'gateway',title:'Gateway checks',cards:common}]:[]),...report.targetReports.filter(target=>!(target.skippedReason==='proxy-endpoint-unreachable' && target.attempts?.every(row=>row.observation==='not-run'))).map(target=>({
  id:target.domain,title:target.domain,domain:true,
  cards:diagnosticSummary({...target,gatewayKind:report.gatewayKind,path:{...target.path,configChanged:report.path?.configChanged || target.path?.configChanged}},options)
   .filter(card=>card.id!=='configuration').map(card=>({...card,id:card.id+':'+target.domain}))
 }))];
}
