import test from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import net from 'node:net';
import { Store } from '../server/store.js';
import { createServer } from '../server/index.js';
import { bootstrapResolvers, buildMihomoDnsConfig, defaultDnsSettings, normalizeResolverUrl, resolvers, statusTargets, validateDnsSettings } from '../server/dns-resolvers.js';
import { clearProbeCache, parseRcode, probe } from '../server/dns-probe.js';
import { buildMihomoConfig, MihomoSupervisor } from '../server/mihomo.js';
import { AdGuardSupervisor, buildAdGuardConfig } from '../server/adguard.js';

function dnsResponse(query, rcode = 0) {
  let end = 12;
  while (end < query.length && query[end]) end += query[end] + 1;
  end += 1;
  const question = query.subarray(12, end + 4);
  const header = Buffer.concat([query.subarray(0, 2), Buffer.from([0x81, 0x80 | rcode, 0, 1, 0, rcode ? 0 : 1, 0, 0, 0, 0])]);
  const answer = Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 93, 184, 216, 34]);
  return Buffer.concat([header, question, ...(rcode ? [] : [answer])]);
}

async function localDns({ respond = true, rcode = 0 } = {}) {
  const socket = dgram.createSocket('udp4');
  socket.on('message', (message, info) => {
    if (respond) socket.send(dnsResponse(message, rcode), info.port, info.address);
  });
  await new Promise(resolve => socket.bind(0, '127.0.0.1', resolve));
  return { socket, url: `udp://127.0.0.1:${socket.address().port}` };
}

test('DNS resolver dictionary is complete and consistent', () => {
  const ids = new Set();
  for (const resolver of resolvers) {
    assert.ok(!ids.has(resolver.id), `duplicate id ${resolver.id}`);
    ids.add(resolver.id);
    assert.ok(resolver.name && resolver.vendor && /^[A-Z]{2}$/.test(resolver.country));
    assert.ok(resolver.region, `missing region for ${resolver.id}`);
    assert.ok(Object.keys(resolver.protocols).length > 0);
    for (const url of Object.values(resolver.protocols)) {
      assert.doesNotThrow(() => normalizeResolverUrl(url));
    }
    for (const ip of resolver.ips) assert.match(ip, /^\d{1,3}(\.\d{1,3}){3}$/);
  }
  assert.ok(resolvers.length >= 40);
  const regions = new Set(resolvers.map(resolver => resolver.region));
  for (const region of ['Россия', 'Европа', 'Япония', 'Китай', 'Глобальный']) assert.ok(regions.has(region), `missing region ${region}`);
});

test('DNS settings validation rejects unsafe input and normalises defaults', () => {
  const settings = validateDnsSettings(defaultDnsSettings);
  assert.deepEqual(settings.nameservers.map(entry => entry.url), [
    'https://cloudflare-dns.com/dns-query',
    'https://dns.google/dns-query',
  ]);
  assert.throws(() => validateDnsSettings({ ...defaultDnsSettings, nameservers: [] }), /Specify at least one/);
  assert.throws(() => validateDnsSettings({ ...defaultDnsSettings, nameservers: ['file:///etc/passwd'] }), /Specify a resolver address/);
  assert.throws(() => validateDnsSettings({ ...defaultDnsSettings, defaultNameservers: ['not-an-ip'] }), /IP addresses/);
  assert.throws(() => validateDnsSettings({ ...defaultDnsSettings, enhancedMode: 'other' }), /DNS mode/);
  assert.throws(() => validateDnsSettings({ ...defaultDnsSettings, fakeIpRange: '10.0.0.0/99' }), /fake-IP/);
  assert.throws(() => validateDnsSettings({ ...defaultDnsSettings, fallbackGeoipCode: 'RUS' }), /country code/);
  const normalised = validateDnsSettings({
    ...defaultDnsSettings,
    nameservers: [{ url: ' https://dns.quad9.net/dns-query ', via: 'RULES' }],
  });
  assert.deepEqual(normalised.nameservers, [{ url: 'https://dns.quad9.net/dns-query', via: 'RULES' }]);
});

test('status targets include bootstrap resolvers and stay unique', () => {
  const targets = statusTargets({
    ...defaultDnsSettings,
    nameservers: [{ url: 'https://cloudflare-dns.com/dns-query', via: '' }],
    fallback: [{ url: 'https://dns.quad9.net/dns-query', via: '' }],
    proxyServerNameservers: [{ url: 'https://dns.google/dns-query', via: '' }],
    defaultNameservers: ['1.1.1.1', '9.9.9.9'],
  });
  assert.deepEqual(targets, [
    'https://cloudflare-dns.com/dns-query',
    'https://dns.quad9.net/dns-query',
    'https://dns.google/dns-query',
    '1.1.1.1',
    '9.9.9.9',
  ]);
  assert.equal(new Set(targets).size, targets.length);
});

test('mihomo DNS block is generated for the future supervisor', () => {
  const base = validateDnsSettings({
    ...defaultDnsSettings,
    enhancedMode: 'redir-host',
    nameservers: [{ url: 'https://cloudflare-dns.com/dns-query', via: 'DIRECT' }],
  });
  const yaml = buildMihomoDnsConfig(base);
  assert.match(yaml, /^dns:\n  enable: true/);
  assert.match(yaml, /'https:\/\/cloudflare-dns\.com\/dns-query#DIRECT'/);
  assert.doesNotMatch(yaml, /fallback-filter/);
  assert.doesNotMatch(yaml, /fake-ip-range/);
  const withFallback = validateDnsSettings({
    ...base,
    fallback: [{ url: 'tls://9.9.9.9' }],
    fallbackGeoip: true,
    fallbackGeoipCode: 'ru',
  });
  const fallbackYaml = buildMihomoDnsConfig(withFallback);
  assert.match(fallbackYaml, /fallback:\n    - 'tls:\/\/9\.9\.9\.9'/);
  assert.match(fallbackYaml, /fallback-filter:\n    geoip: true\n    geoip-code: RU/);
  const fake = buildMihomoDnsConfig(validateDnsSettings({ ...base, enhancedMode: 'fake-ip', fakeIpRange: '198.19.0.1/16' }));
  assert.match(fake, /enhanced-mode: fake-ip/);
  assert.match(fake, /fake-ip-range: 198\.19\.0\.1\/16/);
});

test('resolver probe reports success, DNS errors and timeouts', async () => {
  clearProbeCache();
  const good = await localDns();
  const broken = await localDns({ rcode: 2 });
  const silent = await localDns({ respond: false });
  try {
    const plain = await probe(good.url.replace('udp://', ''), { timeout: 1500 });
    assert.equal(plain.state, 'ok', 'bare IP bootstrap entries are probed over UDP');
    const ok = await probe(good.url, { timeout: 1500 });
    assert.equal(ok.state, 'ok');
    assert.equal(ok.ok, true);
    assert.equal(ok.protocol, 'udp');
    assert.equal(parseRcode(Buffer.from([0, 0, 0x81, 0x82, 0, 0, 0, 0, 0, 0, 0, 0])), 2);
    const failed = await probe(broken.url, { timeout: 1500 });
    assert.equal(failed.state, 'fail');
    assert.match(failed.error, /rcode 2/);
    const timeout = await probe(silent.url, { timeout: 300 });
    assert.equal(timeout.state, 'fail');
    assert.equal(timeout.error, 'ETIMEDOUT');
    assert.equal((await probe('quic://dns.adguard.com:784')).state, 'unsupported');
    assert.equal((await probe('system')).state, 'unsupported');
  } finally {
    good.socket.close();
    broken.socket.close();
    silent.socket.close();
  }
});

test('DNS API stores settings, enforces roles and returns availability', async () => {
  clearProbeCache();
  const local = await localDns();
  const store = new Store(':memory:');
  const server = createServer(store);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const request = async (path, method = 'GET', body, session, csrf = true) => {
    const response = await fetch(base + '/api/' + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(session ? { Cookie: session.cookie, ...(csrf ? { 'X-CSRF-Token': session.csrf } : {}) } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await response.json();
    return { status: response.status, data, cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  try {
    assert.equal((await request('dns')).status, 401);
    const setup = await request('auth/setup', 'POST', { username: 'admin', password: 'test password 12345' });
    const admin = { cookie: setup.cookie, csrf: setup.data.csrf };
    const viewer = await request('users', 'POST', { username: 'viewer', password: 'test password 12345', role: 'viewer' }, admin);
    const viewerLogin = await request('auth/login', 'POST', { username: 'viewer', password: 'test password 12345' });
    const v = { cookie: viewerLogin.cookie, csrf: viewerLogin.data.csrf };
    assert.equal(viewer.status, 201);

    assert.equal((await request('dns/engine')).status, 401);
    const engineState = await request('dns/engine', 'GET', undefined, v);
    assert.equal(engineState.status, 200);
    assert.equal(engineState.data.engine.state, 'unavailable');
    assert.equal(engineState.data.filter.state, 'unavailable');
    const initial = await request('dns', 'GET', undefined, v);
    assert.equal(initial.status, 200);
    assert.ok(initial.data.resolvers.length >= 10);
      assert.equal((await request('dns', 'PUT', { ...defaultDnsSettings }, v)).status, 403);
    assert.equal((await request('dns', 'PUT', { ...defaultDnsSettings }, admin, false)).status, 403);
    assert.equal((await request('dns', 'PUT', { ...defaultDnsSettings, nameservers: [] }, admin)).status, 400);
    const invalid = await request('dns', 'PUT', { ...defaultDnsSettings, nameservers: [] }, admin);
    assert.match(invalid.data.error, /Specify at least one/);

    const saved = await request('dns', 'PUT', {
      ...defaultDnsSettings,
      nameservers: [{ url: local.url, via: '' }, { url: 'https://dns.google/dns-query', via: 'DIRECT' }],
      defaultNameservers: ['1.1.1.1'],
    }, admin);
    assert.equal(saved.status, 200);
    assert.equal(saved.data.settings.nameservers[0].url, local.url);
    assert.equal(saved.data.preview, undefined);
    assert.equal(saved.data.engine.state, 'unavailable');
    assert.equal((await request('dns', 'GET', undefined, admin)).data.settings.nameservers[1].via, 'DIRECT');

    const status = await request('dns/status', 'GET', undefined, v);
    assert.equal(status.status, 200);
    assert.equal(status.data.statuses[local.url].state, 'ok');
    assert.ok(Number.isInteger(status.data.statuses[local.url].ms));
    assert.ok('1.1.1.1' in status.data.statuses, 'bootstrap IP has a status entry');
    const events = await request('logs', 'GET', undefined, admin);
    assert.ok(events.data.some(event => event.action === 'PUT /api/dns'));
  } finally {
    local.socket.close();
    await new Promise(resolve => server.close(resolve));
    store.close();
  }
});

test('managed mihomo config adds a loopback DNS listener and direct rules', () => {
  const config = buildMihomoConfig(validateDnsSettings(defaultDnsSettings), { mixedPort: 17890, dnsPort: 15399 });
  assert.match(config, /^mixed-port: 17890\n/);
  assert.match(config, /dns:\n  enable: true\n  listen: 127\.0\.0\.1:15399\n/);
  assert.match(config, /nameserver:\n    - 'https:\/\/cloudflare-dns\.com\/dns-query'/);
  assert.match(config, /rules:\n  - MATCH,DIRECT\n$/);
  assert.match(config, /tun:\n  enable: true\n  stack: system\n  auto-route: true\n  auto-detect-interface: true\n  mtu: 1500\n  dns-hijack:\n    - any:53\n/);
  assert.match(config, /fake-ip-range: 10\.99\.0\.1\/16/);
});

test('supervisor reports unavailable when the binary is missing', async () => {
  const supervisor = new MihomoSupervisor({ binary: '/nonexistent/mihomo', stateDir: '/tmp/fg-supervisor-missing' });
  assert.equal(supervisor.status().state, 'unavailable');
  const result = await supervisor.apply(validateDnsSettings(defaultDnsSettings));
  assert.equal(result.ok, false);
  assert.equal(result.error, 'The mihomo engine was not found.');
  assert.equal(supervisor.status().state, 'unavailable');
});

test('DNS save applies through the supervisor and fails closed', async () => {
  const store = new Store(':memory:');
  let applied = 0;
  let fail = false;
  const supervisor = {
    status: () => ({ state: 'running', running: true, appliedAt: new Date().toISOString() }),
    apply: async () => {
      applied += 1;
      return fail ? { ok: false, error: 'engine rejected' } : { ok: true };
    },
  };
  const server = createServer(store, { supervisor });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const request = async (path, method = 'GET', body, session, csrf = true) => {
    const response = await fetch(base + '/api/' + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(session ? { Cookie: session.cookie, ...(csrf ? { 'X-CSRF-Token': session.csrf } : {}) } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  try {
    const setup = await request('auth/setup', 'POST', { username: 'admin', password: 'test password 12345' });
    const admin = { cookie: setup.cookie, csrf: setup.data.csrf };
    const ok = await request('dns', 'PUT', { ...defaultDnsSettings, enhancedMode: 'fake-ip' }, admin);
    assert.equal(ok.status, 200);
    assert.equal(applied, 1);
    assert.equal(ok.data.engine.state, 'running');
    assert.equal((await request('dns', 'GET', undefined, admin)).data.settings.enhancedMode, 'fake-ip');

    fail = true;
    const rejected = await request('dns', 'PUT', { ...defaultDnsSettings, enhancedMode: 'redir-host' }, admin);
    assert.equal(rejected.status, 502);
    assert.match(rejected.data.error, /engine rejected/);
    assert.equal((await request('dns', 'GET', undefined, admin)).data.settings.enhancedMode, 'fake-ip');

    const retry = await request('dns/apply', 'POST', {}, admin);
    assert.equal(retry.status, 502);

    const unavailable = { status: () => ({ state: 'unavailable' }), apply: async () => ({ ok: true }) };
    const server2 = createServer(store, { supervisor: unavailable });
    await new Promise(resolve => server2.listen(0, '127.0.0.1', resolve));
    const base2 = 'http://127.0.0.1:' + server2.address().port;
    const retryUnavailable = await fetch(base2 + '/api/dns/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: admin.cookie, 'X-CSRF-Token': admin.csrf },
      body: '{}',
    });
    assert.equal(retryUnavailable.status, 503);
    await new Promise(resolve => server2.close(resolve));
  } finally {
    await new Promise(resolve => server.close(resolve));
    store.close();
  }
});

test('AdGuard config points upstream to the mihomo DNS listener', () => {
  const config = buildAdGuardConfig({ listenPort: 53053, upstreamPort: 15353, webPort: 13000 });
  assert.match(config, /^schema_version: 34\n/);
  assert.match(config, /port: 53053\n/);
  assert.match(config, /upstream_dns:\n    - 127\.0\.0\.1:15353\n/);
  assert.match(config, /bind_hosts:\n    - 0\.0\.0\.0\n/);
  assert.match(config, /user_rules:\n  - "\|\|blocked\.example\^"\n/);
  assert.doesNotMatch(config, /upstream_dns:\n    - 127\.0\.0\.1:53053/);
});

test('AdGuard supervisor reports unavailable when the binary is missing', async () => {
  const supervisor = new AdGuardSupervisor({ binary: '/nonexistent/AdGuardHome', stateDir: '/tmp/fg-adguard-missing' });
  assert.equal(supervisor.status().state, 'unavailable');
  const result = await supervisor.apply();
  assert.equal(result.ok, false);
  assert.match(result.error, /not found/);
});

test('DNS save also ensures the filtering stage', async () => {
  const store = new Store(':memory:');
  let ensured = 0;
  const supervisor = { status: () => ({ state: 'running' }), apply: async () => ({ ok: true }) };
  const filter = { status: () => ({ state: 'error', error: 'filter down' }), ensure: async () => { ensured += 1; return { ok: false }; } };
  const server = createServer(store, { supervisor, filter });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    const setup = await fetch(base + '/api/auth/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'test password 12345' }) });
    const cookie = setup.headers.get('set-cookie')?.split(';')[0];
    const session = await (await fetch(base + '/api/auth/session', { headers: { Cookie: cookie } })).json();
    const saved = await fetch(base + '/api/dns', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': session.csrf },
      body: JSON.stringify(defaultDnsSettings),
    });
    assert.equal(saved.status, 200);
    const data = await saved.json();
    assert.equal(ensured, 1);
    assert.equal(data.filter.state, 'error');
  } finally {
    await new Promise(resolve => server.close(resolve));
    store.close();
  }
});

test('settings saved by an older release are normalised on read', () => {
  const store = new Store(':memory:');
  const older = { ...defaultDnsSettings };
  delete older.proxyServerNameservers;
  store.db.prepare('INSERT INTO dns_settings VALUES (1,?)').run(JSON.stringify(older));
  const settings = store.dnsSettings();
  assert.deepEqual(settings.proxyServerNameservers, []);
  assert.equal(settings.nameservers.length, defaultDnsSettings.nameservers.length);
  store.close();
});

test('bootstrap resolver catalog contains valid public IPs', () => {
  const ids = new Set();
  for (const item of bootstrapResolvers) {
    assert.ok(!ids.has(item.id), `duplicate bootstrap id ${item.id}`);
    ids.add(item.id);
    assert.ok(item.name && item.region, `missing metadata for ${item.id}`);
    assert.match(item.country, /^[A-Z]{2}$/);
    assert.ok(item.ips.length > 0, `no IPs for ${item.id}`);
    for (const ip of item.ips) assert.notEqual(net.isIP(ip), 0, `invalid IP ${ip}`);
  }
  assert.ok(bootstrapResolvers.length >= 20);
});

test('provider aliases make Russian search work in both catalogs', () => {
  for (const catalog of [resolvers, bootstrapResolvers]) {
    const yandex = catalog.find(entry => entry.id === 'yandex');
    assert.ok(yandex.aliases.includes('яндекс'), 'Yandex must be searchable as «яндекс»');
  }
  assert.ok(resolvers.every(entry => Array.isArray(entry.aliases)));
  assert.ok(bootstrapResolvers.every(entry => Array.isArray(entry.aliases)));
});

test('mihomo omits routes for proxies it did not generate and rejects blocked groups', () => {
  const config = buildMihomoConfig(validateDnsSettings(defaultDnsSettings), { mixedPort: 17890, dnsPort: 15399 }, {
    devices: [{ id: 'd1', identifier: '192.168.1.115', routeId: 'xray-1' }],
    groups: [{ id: 'g1', entries: ['example.com', '10.0.0.0/8'], routeId: 'block' }],
    profiles: [{ id: 'xray-1', engine: 'xray' }],
    configs: [],
  });
  assert.doesNotMatch(config, /p-xray-1-grp/);
  assert.match(config, /DOMAIN-SUFFIX,example\.com,REJECT/);
  assert.match(config, /IP-CIDR,10\.0\.0\.0\/8,REJECT/);
});


test('inactive Tor and Lantern chains preserve real-address DNS for remote clients',()=>{
 for(const engine of ['tor','lantern'])for(const childEnabled of [false,true]){
  const parent={id:'parent00-'+engine,engine,enabled:false};
  const child={id:'child000-proxy',engine:'socks5',enabled:childEnabled,gatewayId:parent.id};
  const profiles=[parent,child],configs=[{profile_id:parent.id,engine,config:'{}'},{profile_id:child.id,engine:'socks5',config:'socks5://198.51.100.10:443'}];
  const routes={profiles,configs,groups:[{id:'saved-rule',entries:['example.com'],routeId:parent.id}],devices:[]};
  const config=buildMihomoConfig({...defaultDnsSettings,enhancedMode:'redir-host'},{remoteAccessEnabled:true},routes);
  assert.match(config,/enhanced-mode: redir-host/);
  assert.doesNotMatch(config,/PROCESS-NAME,(tor|lantern-headless),DIRECT/);
  assert.match(config,/DOMAIN-SUFFIX,example.com,REJECT/);
  if(childEnabled)assert.ok(config.includes(JSON.stringify({name:'p-child000',type:'reject'})));
  const active=buildMihomoConfig({...defaultDnsSettings,enhancedMode:'redir-host'},{},{...routes,profiles:[{...parent,enabled:true},child]});
  assert.match(active,/enhanced-mode: fake-ip/);
 }
});
