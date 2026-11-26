import test from 'node:test';
import assert from 'node:assert/strict';
import {diagnosticOverview,diagnosticSummary} from '../shared/diagnostic-summary.js';
const good={url:'https://example.com/',outcome:'ok',routeVerified:true};
const failed={url:'https://example.com/',outcome:'failed',observation:'timeout'};
test('direct controls and DNS/SNI experiments do not downgrade working gateway website traffic',()=>{
 const comparisons={uplinkControl:{attempts:[failed]},dnsMatrix:{attempts:[{state:'failed',reason:'timeout'}]},gatewayDnsMatrix:{attempts:[{state:'failed',reason:'timeout'}]},sniControl:{comparisons:[{state:'uninformative'}]},gatewaySniControl:{comparisons:[{state:'uninformative'}]}};
 const report={gatewayKind:'proxy',attempts:[good],endpointControl:{bootstrap:{method:'doh',state:'failed'},port:443,results:[{state:'failed',address:'192.0.2.1'}]},...comparisons};
 assert.equal(diagnosticOverview(report).state,'ok');assert.equal(diagnosticOverview(report).title,'The connection works');assert.ok(diagnosticSummary(report).filter(row=>row.state!=='ok').length>=6);
 const grouped={...report,targetReports:[{domain:'example.com',attempts:[good],...comparisons}]};assert.equal(diagnosticOverview(grouped).state,'ok');
 for(const gatewayKind of ['direct','dpi-bypass'])assert.equal(diagnosticOverview({...report,gatewayKind}).state,'ok');
 const dataFailure={...grouped,targetReports:[{...grouped.targetReports[0],transfer:{attempts:[{mode:'site-response',outcome:'failed',complete:false}]}}]};assert.equal(diagnosticOverview(dataFailure).state,'partial');assert.match(diagnosticOverview(dataFailure).title,/data check/);
 const websiteFailure={...report,attempts:[failed]};assert.equal(diagnosticOverview(websiteFailure).state,'failed');assert.match(diagnosticOverview(websiteFailure).message,/None of the checked websites/);
 assert.equal(diagnosticOverview({...grouped,progress:{state:'cancelled'}}).state,'unavailable');
 assert.equal(diagnosticOverview({...report,path:{configChanged:true}}).state,'unavailable');
});
