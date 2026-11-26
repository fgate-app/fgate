import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {diagnosticSummary,websiteFinding,captureFinding} from '../shared/diagnostic-summary.js';
const good={url:'https://www.gstatic.com/generate_204',outcome:'ok',pathObservation:{state:'verified'}};
const failed={url:'https://cp.cloudflare.com/generate_204',outcome:'failed',observation:'timeout',stages:[{id:'tls',state:'failed'}]};

test('plain findings locate failed stages, keep unavailable separate and never diagnose DPI from a timeout',()=>{
  const cases=[
    [good,'ok','website opened'],
    [{...good,pathObservation:{state:'unavailable'}},'unavailable','could not be confirmed'],
    [{...good,pathObservation:{state:'mismatch'}},'failed','different gateway'],
    [failed,'failed','secure connection'],
    [{...failed,stages:[]},'failed','did not respond'],
    [{...failed,observation:'certificate-error'},'failed','certificate'],
    [{...failed,stages:[{id:'proxy-connect',state:'failed'}]},'failed','local connection'],
    [{...failed,stages:[{id:'http',state:'ok',status:503}]},'failed','website returned an error'],
    [{outcome:'unavailable'},'unavailable','could not complete']
  ];
  for(const [row,state,substring] of cases){const result=websiteFinding(row);assert.equal(result.state,state);assert.ok(result.message.includes(substring),result.message);assert.doesNotMatch(result.message,/DPI|blocked by|provider blocking/);if(state!=='ok')assert.ok(result.next);}
});

test('a failed direct server control cannot turn working gateway websites into a gateway outage',()=>{
  const cards=diagnosticSummary({attempts:[good],endpointControl:{bootstrap:{method:'doh',state:'failed'},results:[{address:'203.0.113.7',state:'failed',attempts:[{reason:'refused'}]}]}});
  assert.equal(cards[0].state,'ok');assert.equal(cards.find(row=>row.id==='server').state,'failed');assert.equal(cards.find(row=>row.id==='server-dns').state,'unavailable');assert.match(cards.find(row=>row.id==='server').message,/reported separately/);
  const partial=diagnosticSummary({attempts:[good,failed]})[0];assert.equal(partial.state,'partial');assert.match(partial.message,/Some websites/);
  assert.equal(diagnosticSummary({attempts:[good],path:{configChanged:true}})[0].state,'unavailable');
  for(const gatewayKind of ['direct','dpi-bypass']){
    const cards=diagnosticSummary({gatewayKind,attempts:[good],endpointControl:{},uplinkControl:{}});
    assert.deepEqual(cards.map(row=>row.id),['websites']);
  }
});

test('DNS, name filtering and downloads preserve incomplete proof and do not claim blocking',()=>{
  const report={gatewayDnsMatrix:{attempts:[{state:'ok',rcode:0,pathObservation:{state:'verified'}},{state:'failed',reason:'timeout'}]},gatewaySniControl:{comparisons:[{state:'uninformative',experimentState:'failed'}]},transfer:{attempts:[{complete:true,outcome:'ok',expectedBytes:65536,pathObservation:{state:'verified'}},{complete:false,outcome:'failed',expectedBytes:1048576}]}};
  const cards=diagnosticSummary(report);assert.equal(cards.find(row=>row.id==='dns-gateway').state,'partial');assert.equal(cards.find(row=>row.id==='sni-gateway').state,'unavailable');assert.equal(cards.find(row=>row.id==='downloads').state,'partial');
  report.gatewayDnsMatrix.path={configChanged:true};report.transfer.path={configChanged:true};
  const changed=diagnosticSummary(report);assert.equal(changed.find(row=>row.id==='dns-gateway').state,'unavailable');assert.equal(changed.find(row=>row.id==='downloads').state,'unavailable');
  report.gatewaySniControl.comparisons=[{provider:'fixture',state:'observed',experimentState:'failed'}];
  report.gatewaySniControl.attempts=[{provider:'fixture',kind:'foreign-sni',pathObservation:{state:'unavailable'}}];assert.equal(diagnosticSummary(report).find(row=>row.id==='sni-gateway').state,'unavailable');
  report.gatewaySniControl.attempts[0].pathObservation.state='verified';assert.match(diagnosticSummary(report).find(row=>row.id==='sni-gateway').message,/does not establish/);
  report.gatewaySniControl.comparisons=[{state:'observed',experimentState:'unavailable'}];assert.equal(diagnosticSummary(report).find(row=>row.id==='sni-gateway').state,'unavailable');
});

test('packet findings distinguish an observed handshake, refusal, silence and missing correlation',()=>{
  const base={state:'observed',probeCorrelated:true,packets:[{direction:'outbound',flags:['SYN']}]};
  assert.match(captureFinding(base).message,/no reply/);
  assert.equal(captureFinding({...base,probeCorrelated:false}).state,'unavailable');
  assert.match(captureFinding({...base,packets:[{direction:'inbound',flags:['ACK','RST']}]}).message,/device on the route/);
  assert.equal(captureFinding({...base,packets:[{direction:'inbound',flags:['SYN','ACK']}]}).state,'ok');
});

test('every plain-language conclusion and action has translations in all supported languages',()=>{
  const source=readFileSync(new URL('../shared/diagnostic-summary.js',import.meta.url),'utf8');
  // Text keys are English sentences or titles; ids and protocol names are not UI text.
  const keys=[...source.matchAll(/'([^'\n]+)'/g)].map(match=>match[1]).filter(value=>/[A-Z]/.test(value[0]) && value.includes(' '));
  for(const locale of ['en','ru','zh-CN']){
    const dictionary=JSON.parse(readFileSync(new URL(`../web/src/locales/${locale}.json`,import.meta.url),'utf8'));
    for(const key of keys)assert.ok(dictionary[key],`${locale}: ${key}`);
  }
});

test('overall conclusion separates unfinished runs and optional failures from website success',async()=>{
 const {diagnosticOverview}=await import('../shared/diagnostic-summary.js');
 assert.equal(diagnosticOverview({attempts:[good]}).state,'ok');
 for(const state of ['running','cancelled','interrupted']){
  const result=diagnosticOverview({attempts:[good],progress:{state}});assert.equal(result.state,'unavailable');assert.match(result.message,/not a complete/);
 }
 const optional=diagnosticOverview({attempts:[good],transfer:{attempts:[{outcome:'failed'}]}});assert.equal(optional.state,'partial');assert.match(optional.title,/Websites opened/);
 const local=diagnosticOverview({gatewayKind:'direct',attempts:[failed]});assert.equal(local.state,'failed');
});
