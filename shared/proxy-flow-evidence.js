// Only observable stages. These codes never identify a censor or server process.
export function proxyFlowEvidence(record){
 const capture=record?.tcpCapture,packets=capture?.packets || [];
 if(capture?.state!=='observed' || !capture.probeCorrelated || !capture.routeVerified)return {state:'unavailable',code:'capture-unavailable'};
 const outbound=packets.filter(row=>row.direction==='outbound'),incoming=packets.filter(row=>row.direction==='inbound');
 const syn=outbound.find(row=>row.flags.includes('SYN') && !row.flags.includes('ACK'));
 const synack=syn && incoming.find(row=>row.flags.includes('SYN') && row.flags.includes('ACK') && row.ack===((syn.sequence+1)>>>0));
 const data=outbound.filter(row=>row.ipBytes>row.headerBytes),reply=incoming.some(row=>row.ipBytes>row.headerBytes);
 const reset=incoming.find(row=>row.flags.includes('RST'));
 if(reset && data.some(row=>row.timeMs<=reset.timeMs))return {state:'observed',code:'reset-after-data'};
 if(reset)return {state:'observed',code:'tcp-rejected'};
 if(reply)return {state:'observed',code:'peer-data-received'};
 if(capture.packetLimitReached || capture.timeLimitReached)return {state:'unavailable',code:'capture-incomplete'};
 if(synack && data.length){
  const acknowledged=data.some(row=>incoming.some(ack=>ack.timeMs>=row.timeMs && ack.flags.includes('ACK') && ack.ack===((row.sequence+row.ipBytes-row.headerBytes)>>>0)));
  return {state:'observed',code:acknowledged?'data-acknowledged-no-response':'no-response-after-data'};
 }
 return {state:'observed',code:synack?'tcp-established':syn?'tcp-no-response':'capture-unavailable'};
}
export function safeProxyFlow(record){
 const capture=record.tcpCapture?structuredClone(record.tcpCapture):undefined;
 if(capture?.tuple){delete capture.tuple.localAddress;delete capture.tuple.localPort;}
 return {state:record.state,sentBytes:record.sentBytes,receivedBytes:record.receivedBytes,routeVerified:record.routeVerified,
  ...(record.pathObservation?{pathObservation:{state:record.pathObservation.state,reason:record.pathObservation.reason,evidence:record.pathObservation.evidence}}:{}),
  ...(capture?{tcpCapture:capture,evidence:proxyFlowEvidence(record)}:{})};
}
export const proxyFlowMessages={
 'reset-after-data':'The connection was reset after the proxy client sent its first data.',
 'tcp-rejected':'The TCP connection was actively rejected.',
 'peer-data-received':'Data arrived from the proxy endpoint; the request result is shown separately.',
 'data-acknowledged-no-response':'The sent data was acknowledged, but no response data was observed in the captured interval.',
 'no-response-after-data':'The client sent data, but no response data was observed in the captured interval.',
 'tcp-established':'TCP connected; no application exchange was observed in the captured interval.',
 'tcp-no-response':'A connection request was sent, but no TCP handshake response was observed.',
 'capture-incomplete':'The packet observation reached its limit; the failure stage could not be established.',
 'capture-unavailable':'Packet observation was unavailable for this connection.'
};
