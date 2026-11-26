import test from 'node:test';
import assert from 'node:assert/strict';
import {diagnosticGroups} from '../shared/diagnostic-summary.js';
test('domain groups contain only their website and optional checks; infrastructure stays separate',()=>{
 const target=domain=>({domain,attempts:[{url:'https://'+domain+'/',outcome:'ok',routeVerified:true}],uplinkControl:{attempts:[]},gatewayDnsMatrix:{attempts:[]},gatewaySniControl:{attempts:[],comparisons:[]},transfer:{attempts:[{domain,mode:'site-response'}]}});
 const report={gatewayKind:'proxy',endpointControl:{port:443,results:[]},targetReports:[target('example.com'),target('second.example')]};report.attempts=report.targetReports.flatMap(row=>row.attempts);
 const original=JSON.stringify(report),groups=diagnosticGroups(report);assert.deepEqual(groups.map(row=>row.id),['gateway','example.com','second.example']);assert.deepEqual(groups[0].cards.map(row=>row.id),['server']);
 assert.deepEqual(groups[1].cards.map(row=>row.id),['websites:example.com','internet:example.com','dns-gateway:example.com','sni-gateway:example.com','downloads:example.com']);assert.ok(groups[2].cards.every(row=>row.id.endsWith(':second.example')));assert.equal(JSON.stringify(report),original);
 const cancelled=structuredClone(report);cancelled.progress={state:'cancelled'};assert.equal(diagnosticGroups(cancelled).length,3);
 const local=diagnosticGroups({gatewayKind:'direct',targetReports:[{domain:'example.com',attempts:[]}]});assert.deepEqual(local.map(row=>row.id),['example.com']);
 assert.deepEqual(diagnosticGroups(null),[]);assert.equal(diagnosticGroups({attempts:[]})[0].id,'gateway');
});
