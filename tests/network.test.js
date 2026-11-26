import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/store.js';
import { createServer } from '../server/index.js';
import { buildNetworkPlan, defaultNetworkSetup, validateNetworkSetup } from '../server/network.js';

const interfaces = [
  { name: 'eth0', type: 'ethernet', state: 'up', carrier: true, address: 'aa:bb:cc:dd:ee:01', addresses: ['192.168.1.50/24'] },
  { name: 'wlan0', type: 'wifi', state: 'up', carrier: false, address: 'aa:bb:cc:dd:ee:02', addresses: [] },
];

const valid = {
  uplink: { interface: 'eth0' },
  client: { interface: 'wlan0', type: 'ap', subnet: '10.10.0.1/24', ssid: 'FreedomGate', password: 'testpass123' },
  dhcp: { start: '10.10.0.100', end: '10.10.0.200' },
};

test('gateway setup validates interfaces, subnet and DHCP range', () => {
  const setup = validateNetworkSetup(valid, interfaces);
  assert.equal(setup.uplink.interface, 'eth0');
  assert.equal(setup.client.interface, 'wlan0');
  assert.equal(setup.client.subnet, '10.10.0.1/24');
  assert.deepEqual(setup.warnings, []);
  const plan = buildNetworkPlan(setup);
  assert.ok(plan.some(step => step.includes('10.10.0.1/24')));
  assert.ok(plan.some(step => step.includes('53053')));

  assert.throws(() => validateNetworkSetup({ ...valid, client: { ...valid.client, interface: 'eth0' } }, interfaces), /different interfaces/);
  assert.throws(() => validateNetworkSetup({ ...valid, client: { ...valid.client, interface: 'wlan0', type: 'ethernet' } }, interfaces), /Ethernet/);
  assert.throws(() => validateNetworkSetup({ ...valid, client: { ...valid.client, subnet: '10.10.0.1/33' } }, interfaces), /subnet/);
  assert.throws(() => validateNetworkSetup({ ...valid, dhcp: { start: '10.10.0.250', end: '10.10.0.100' } }, interfaces), /range start/);
  assert.throws(() => validateNetworkSetup({ ...valid, dhcp: { start: '10.10.0.1', end: '10.10.0.200' } }, interfaces), /gateway address/);
  assert.throws(() => validateNetworkSetup({ ...valid, client: { ...valid.client, password: 'short' } }, interfaces), /password/);
  assert.throws(() => validateNetworkSetup({ ...valid, client: { ...valid.client, ssid: '' } }, interfaces), /SSID/);
  assert.throws(() => validateNetworkSetup({ ...valid, uplink: { interface: 'ppp0' } }, interfaces), /existing interface/);
});

test('gateway setup warns about a missing uplink carrier', () => {
  const setup = validateNetworkSetup(
    {
      uplink: { interface: 'wlan0' },
      client: { interface: 'eth0', type: 'ethernet', subnet: '10.10.0.1/24', ssid: '', password: '' },
      dhcp: { start: '10.10.0.100', end: '10.10.0.200' },
    },
    interfaces,
  );
  assert.equal(setup.client.type, 'ethernet');
  assert.ok(setup.warnings.some(warning => warning.includes('has no link')));
});

test('default setup prefers wired uplink and Wi-Fi access point', () => {
  const setup = defaultNetworkSetup(interfaces);
  assert.equal(setup.uplink.interface, 'eth0');
  assert.equal(setup.client.interface, 'wlan0');
  assert.equal(setup.client.type, 'ap');
  assert.equal(setup.dhcp.start, '10.10.0.100');
});

test('gateway setup API stores the scheme and enforces roles', async () => {
  const store = new Store(':memory:');
  const server = createServer(store, { interfaces: () => interfaces, networkTraffic:async()=>({interfaces:{eth0:{receiveRate:12,transmitRate:34}}}) });
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
    assert.equal((await request('network')).status, 401);
    assert.equal((await request('network/traffic')).status, 401);
    const setup = await request('auth/setup', 'POST', { username: 'admin', password: 'test password 12345' });
    const admin = { cookie: setup.cookie, csrf: setup.data.csrf };
    const viewer = await request('users', 'POST', { username: 'viewer', password: 'test password 12345', role: 'viewer' }, admin);
    assert.equal(viewer.status, 201);
    const login = await request('auth/login', 'POST', { username: 'viewer', password: 'test password 12345' });
    const v = { cookie: login.cookie, csrf: login.data.csrf };

    const initial = await request('network', 'GET', undefined, v);
    assert.equal(initial.status, 200);
    const traffic=await request('network/traffic','GET',undefined,v);
    assert.equal(traffic.status,200);assert.equal(traffic.data.interfaces.eth0.transmitRate,34);
    assert.equal(initial.data.interfaces.length, 2);
    assert.equal(initial.data.setup.uplink.interface, 'eth0');

    assert.equal((await request('network', 'PUT', valid, v)).status, 403);
    assert.equal((await request('network', 'PUT', { ...valid, client: { ...valid.client, interface: 'eth0' } }, admin)).status, 400);
    const saved = await request('network', 'PUT', valid, admin);
    assert.equal(saved.status, 200);
    assert.equal(saved.data.setup.client.ssid, 'FreedomGate');
    assert.ok(saved.data.plan.length >= 5);

    const plan = await request('network/plan', 'POST', { ...valid, client: { ...valid.client, subnet: '10.20.0.1/24' }, dhcp: { start: '10.20.0.100', end: '10.20.0.200' } }, admin);
    assert.equal(plan.status, 200);
    assert.ok(plan.data.plan.some(step => step.includes('10.20.0.1/24')));

    const stored = await request('network', 'GET', undefined, admin);
    assert.equal(stored.data.setup.client.subnet, '10.10.0.1/24');
  } finally {
    await new Promise(resolve => server.close(resolve));
    store.close();
  }
});

test('wired-only defaults use detected interface names and do not invent a Wi-Fi AP',()=>{
 const wired=[{name:'enp1s0',type:'ethernet',carrier:true,addresses:['192.0.2.10/24']},{name:'enp2s0',type:'ethernet',carrier:false,addresses:[]}];
 const setup=defaultNetworkSetup(wired);assert.equal(setup.uplink.interface,'enp1s0');assert.equal(setup.client.interface,'enp2s0');assert.equal(setup.client.type,'ethernet');assert.equal(validateNetworkSetup(setup,wired).client.type,'ethernet');
 assert.equal(defaultNetworkSetup(interfaces).client.type,'ap');assert.equal(defaultNetworkSetup(wired.slice(0,1)).client.interface,'');
});
