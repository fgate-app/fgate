import test from 'node:test';
import assert from 'node:assert/strict';
import {proxyFlowEvidence,safeProxyFlow} from '../shared/proxy-flow-evidence.js';
const packet=(direction,flags,sequence,ack,timeMs,bytes=0)=>({direction,flags,sequence,ack,timeMs,ipBytes:40+bytes,headerBytes:40});
const syn=packet('outbound',['SYN'],10,0,1),synack=packet('inbound',['SYN','ACK'],30,11,2),data=packet('outbound',['ACK'],11,31,3,10);
const record=packets=>({state:'connected',routeVerified:true,tcpCapture:{state:'observed',probeCorrelated:true,routeVerified:true,packets,tuple:{localAddress:'192.168.1.2',localPort:49122,peerAddress:'203.0.113.1',peerPort:443}}});
test('real-flow evidence describes observed stages without inventing a blocking cause',()=>{
 for(const [packets,code] of [[[syn],'tcp-no-response'],[[syn,synack],'tcp-established'],[[syn,synack,data],'no-response-after-data'],[[syn,synack,data,packet('inbound',['ACK'],31,21,4)],'data-acknowledged-no-response'],[[syn,packet('inbound',['RST','ACK'],0,11,2)],'tcp-rejected'],[[syn,synack,data,packet('inbound',['RST'],31,21,4)],'reset-after-data'],[[syn,synack,data,packet('inbound',['ACK'],31,21,4,5)],'peer-data-received']])assert.equal(proxyFlowEvidence(record(packets)).code,code);
 const incomplete=record([syn,synack,data]);incomplete.tcpCapture.packetLimitReached=true;assert.equal(proxyFlowEvidence(incomplete).code,'capture-incomplete');
 incomplete.tcpCapture.packets.push(packet('inbound',['RST'],31,21,4));assert.equal(proxyFlowEvidence(incomplete).code,'reset-after-data');
 const denied=record([syn]);denied.tcpCapture.routeVerified=false;assert.equal(proxyFlowEvidence(denied).state,'unavailable');
 const uncorrelated=record([syn]);uncorrelated.tcpCapture.probeCorrelated=false;assert.equal(proxyFlowEvidence(uncorrelated).code,'capture-unavailable');
 assert.doesNotMatch(JSON.stringify(safeProxyFlow(record([syn]))),/192\.168|49122|localAddress|localPort/);
});
