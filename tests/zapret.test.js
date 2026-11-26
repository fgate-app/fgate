import test from 'node:test';
import assert from 'node:assert/strict';
import { candidateStrategies, normalizeTarget, planStrategy, runAutotune, strategyArgs } from '../server/zapret.js';

test('autotune planner picks a strategy for the chosen protocols and mode', () => {
  const auto = planStrategy({ mode: 'auto', http: true, https: true, quic: true });
  assert.equal(auto.mode, 'tpws');
  assert.equal(auto.strategy, 'md5sum');
  assert.deepEqual(auto.protocols, ['http', 'https', 'quic']);

  const nfqws = planStrategy({ mode: 'nfqws', http: true, https: false, quic: true });
  assert.equal(nfqws.mode, 'nfqws');
  assert.equal(nfqws.strategy, 'nfqws2');

  const httpOnly = planStrategy({ mode: 'auto', http: true, https: false, quic: false });
  assert.deepEqual(httpOnly.protocols, ['http']);
  assert.equal(httpOnly.strategy, 'md5sum');

  const noProtocols = planStrategy({ mode: 'auto', http: false, https: false, quic: false });
  assert.deepEqual(noProtocols.protocols, []);
  assert.ok(noProtocols.strategy);
});

test('target validation accepts domains and rejects garbage', () => {
  assert.equal(normalizeTarget(' YouTube.com '), 'youtube.com');
  assert.equal(normalizeTarget('sub.example.co.uk'), 'sub.example.co.uk');
  assert.throws(() => normalizeTarget(''), /domain/);
  assert.throws(() => normalizeTarget('not a domain'), /domain/);
  assert.throws(() => normalizeTarget('http://youtube.com'), /domain/);
});

test('autotune without a probe reports unavailable instead of faking success', async () => {
  const plan = await runAutotune({ mode: 'auto', http: true, https: true, quic: true }, { target: 'youtube.com' });
  assert.equal(plan.ok, false);
  assert.equal(plan.state, 'unavailable');
  assert.equal(plan.strategy, null);
  assert.ok(plan.results.length >= 1);
  assert.ok(plan.results.every(result => result.state === 'unavailable'));
});

test('autotune runs candidates and picks the first working strategy', async () => {
  const seen = [];
  const probe = async (strategy, target) => {
    seen.push([strategy.id, target]);
    return strategy.id === 'autottl' ? { ok: true } : { ok: false, error: 'blocked' };
  };
  const plan = await runAutotune({ mode: 'tpws', http: true, https: true, quic: false }, { target: 'rutracker.org', probe });
  assert.equal(plan.ok, true);
  assert.equal(plan.strategy, 'autottl');
  assert.equal(plan.mode, 'tpws');
  assert.equal(plan.target, 'rutracker.org');
  assert.ok(seen.length >= 3);
  assert.ok(seen.every(([, target]) => target === 'rutracker.org'));
  assert.equal(candidateStrategies({ mode: 'tpws', http: true, https: true }).some(strategy => strategy.id === 'nfqws2'), false);
});

test('strategy arguments build nfqws2 profiles for each protocol', () => {
  const args = strategyArgs('nfqws2', { http: true, https: true, quic: true, tcpPorts: '80,443', udpPorts: '443' });
  assert.ok(args.includes('--filter-l7=http'));
  assert.ok(args.includes('--filter-l7=tls'));
  assert.ok(args.includes('--filter-l7=quic'));
  assert.ok(args.includes('--lua-desync=fake:blob=fake_default_http:tcp_md5'));
  assert.ok(args.includes('--lua-desync=fake:blob=fake_default_tls:tcp_md5:tcp_seq=-10000'));
  assert.ok(args.includes('--lua-desync=multisplit:pos=method+2'));
  assert.ok(args.includes('--lua-desync=multisplit:pos=1,midsld'));
  assert.equal(args.filter(value => value === '--new').length, 2);
});

test('strategy arguments honor protocol toggles and custom desync', () => {
  const tlsOnly = strategyArgs('md5sum', { http: false, https: true, quic: false });
  assert.equal(tlsOnly.includes('--filter-l7=http'), false);
  assert.equal(tlsOnly.includes('--filter-l7=tls'), true);
  assert.equal(tlsOnly.includes('--new'), false);

  const custom = strategyArgs('custom', { http: true, https: true, quic: false, customStrategy: 'fake:blob=fake_default_tls:tcp_md5:ip_ttl=5' });
  assert.ok(custom.includes('--lua-desync=fake:blob=fake_default_tls:tcp_md5:ip_ttl=5'));
});

test('port lists reject out-of-range ports and nftables syntax injection', () => {
  for(const ports of ['0','65536','443; drop','443,','80-1']) {
    assert.throws(()=>strategyArgs('nfqws2',{tcpPorts:ports}),/port list/);
  }
  assert.ok(strategyArgs('ipid',{http:false,https:true,quic:false,tcpPorts:'443,8443-8450'}).includes('--lua-desync=fake:blob=fake_default_tls:tcp_md5:ip_id=rnd'));
});

test('YouTube preset uses the independently tested TLS and QUIC strategies',async()=>{
 const {zapretBlobArgs}=await import('../server/zapret.js');
 const args=strategyArgs('youtube',{http:false,https:true,quic:true});
 assert.ok(!args.some(arg=>arg.startsWith('--lua-desync=fake:blob=fg_tls_google')));
 assert.ok(args.includes('--lua-desync=multidisorder:pos=1,midsld'));
 assert.ok(args.includes('--lua-desync=fake:blob=fg_quic_google:repeats=1'));
 assert.ok(!args.some(arg=>arg.includes('fake_default_quic')));
 assert.equal(zapretBlobArgs().length,2);
});
test('captured Google blobs match the pinned upstream release',async()=>{
 const {readFileSync}=await import('node:fs');const {createHash}=await import('node:crypto');
 for(const [file,size,sha] of [
  ['quic_initial_www_google_com.bin',1200,'f4589c57749f956bb30538197a521d7005f8b0a8723b4707e72405e51ddac50a'],
  ['tls_clienthello_www_google_com.bin',681,'936c2bee4cfb80aa3c426b2dcbcc834b3fbcd1adb17172959dc569c73a14275c'],
 ]){const data=readFileSync(new URL('../server/zapret-assets/'+file,import.meta.url));assert.equal(data.length,size);assert.equal(createHash('sha256').update(data).digest('hex'),sha);}
});
