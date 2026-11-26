import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/store.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('draft validation and controlled settings preserve failure policy', () => {
  const s = new Store(':memory:');
  try {
    assert.equal(s.profiles().filter(p => p.builtin).length, 4);
    assert.equal(s.profiles().find(p => p.engine === 'zapret').name, 'Обход DPI');
    assert.equal(s.profiles().find(p => p.engine === 'direct').name, 'Direct');
    assert.throws(() => s.removeProfile(s.profiles().find(p => p.engine === 'zapret').id), /cannot be deleted/);
    assert.throws(() => s.addProfile({ name: '', protocol: 'vless' }));
    assert.throws(() => s.addProfile({ name: 'a', protocol: 'unknown' }));
    const p = s.addProfile({ name: ' Test ', protocol: 'ss' });
    assert.equal(s.profiles().find(item => item.id === p.id).name, 'Test');
    s.updateSettings({ topology: 'router-uplink', failurePolicy: 'reject' });
    assert.equal(s.settings().failurePolicy, 'direct');
    assert.equal(s.removeProfile(p.id), true);
    assert.equal(s.profiles().length, 4);
    const sstp = s.addProfile({ name: 'SSTP draft', protocol: 'sstp' });
    assert.equal(sstp.protocol, 'sstp');
  } finally {
    s.close();
  }
});

test('imported Xray profile stores outbound privately and deletes it with metadata', () => {
  const s = new Store(':memory:');
  try {
    const config = { inbounds: [{ port: 1234 }], log: { access: 'provider.log' }, outbounds: [{ protocol: 'vless', settings: { vnext: [{ address: '192.0.2.1', port: 443, users: [{ id: 'private-test-credential' }] }] }, streamSettings: { network: 'tcp', security: 'reality' } }] };
    const p = s.importXrayProfile({ name: 'Test import' }, config);
    assert.equal(s.profiles().find(item => item.id === p.id).engine, 'xray');
    assert.ok(!JSON.stringify(s.profiles()).includes('private-test-credential'));
    const saved = JSON.parse(s.db.prepare('SELECT config FROM profile_configs WHERE profile_id=?').get(p.id).config);
    assert.deepEqual(Object.keys(saved), ['outbounds']);
    assert.equal(saved.outbounds[0].settings.vnext[0].users[0].id, 'private-test-credential');
    assert.throws(() => s.importXrayProfile({ name: 'bad' }, { outbounds: [] }));
    assert.equal(s.profiles().length, 5);
    s.removeProfile(p.id);
    assert.equal(s.db.prepare('SELECT count(*) AS n FROM profile_configs WHERE profile_id=?').get(p.id).n, 0);
  } finally {
    s.close();
  }
});

test('unified exit points: outline, socks5 and vless links are stored with their engine', () => {
  const s = new Store(':memory:');
  try {
    const outline = s.importProfile({ value: 'ss://YWVzLTI1Ni1nY206cGFzc0BleGFtcGxlLmNvbTo4Mzg4#outline-node' });
    assert.equal(outline.engine, 'outline');
    assert.equal(outline.protocol, 'ss');
    const socks = s.importProfile({ name: 'my socks', value: 'socks5://127.0.0.1:1080' });
    assert.equal(socks.engine, 'socks5');
    assert.equal(socks.protocol, 'socks5');
    const vless = s.importProfile({ value: 'vless://uuid@example.com:443?security=reality#node' });
    assert.equal(vless.engine, 'xray');
    assert.equal(vless.protocol, 'vless');
    assert.throws(() => s.importProfile({ value: 'not-a-config' }));
    assert.equal(s.removeProfile(outline.id), true);
    assert.equal(s.profiles().length, 6);
  } finally {
    s.close();
  }
});

test('zapret auto-detect strategy is stored and read back', () => {
  const s = new Store(':memory:');
  try {
    const defaults = s.zapretSettings();
    assert.equal(defaults.mode, 'auto');
    assert.equal(defaults.http, true);
    assert.equal(defaults.https, true);
    assert.equal(defaults.quic, true);
    const updated = s.updateZapretSettings({ mode: 'tpws', strategy: 'md5sum', quic: false, windowSize: 4, ttl: 64, hostlist: true, hostlistUrl: 'https://antizapret.prostovpn.org/domains-export.txt', autoUpdate: true, autoUpdateInterval: 'daily', tcpPorts: '80,443' });
    assert.equal(updated.mode, 'tpws');
    assert.equal(updated.strategy, 'md5sum');
    assert.equal(updated.quic, false);
    assert.equal(updated.windowSize, 4);
    assert.equal(updated.ttl, 64);
    assert.equal(updated.hostlist, true);
    assert.equal(updated.hostlistUrl, 'https://antizapret.prostovpn.org/domains-export.txt');
    assert.equal(updated.autoUpdate, true);
    assert.equal(updated.autoUpdateInterval, 'daily');
    assert.equal(updated.tcpPorts, '80,443');
    const saved = s.zapretSettings();
    assert.deepEqual(saved, updated);
  } finally { s.close(); }
});

test('built-in exits are restored when missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fg-builtins-'));
  const file = join(dir, 'db.sqlite');
  try {
    let store = new Store(file);
    store.db.prepare('DELETE FROM profiles WHERE builtin=1').run();
    store.close();
    store = new Store(file);
    assert.equal(store.profiles().filter(profile => profile.builtin).length, 4);
    assert.ok(store.profiles().some(profile => profile.engine === 'zapret'));
    assert.ok(store.profiles().some(profile => profile.engine === 'direct'));
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('route groups and device routes validate, update and delete', () => {
  const s = new Store(':memory:');
  try {
    const route = s.profiles()[0];
    const group = s.addRouteGroup({ name: 'youtube', entries: 'youtube.com\nyoutu.be\n142.250.0.0/16', routeId: route.id });
    assert.equal(group.name, 'youtube');
    assert.deepEqual(group.entries, ['youtube.com', 'youtu.be', '142.250.0.0/16']);
    assert.equal(group.routeId, route.id);
    assert.throws(() => s.addRouteGroup({ name: '', entries: 'example.com', routeId: route.id }), /name/);
    assert.throws(() => s.addRouteGroup({ name: 'bad', entries: 'https://example.com', routeId: route.id }), /Invalid/);
    assert.throws(() => s.addRouteGroup({ name: 'noroute', entries: 'example.com', routeId: 'missing' }), /route/);
    const blocked = s.updateRouteGroup(group.id, { routeId: 'block' });
    assert.equal(blocked.routeId, 'block');
    assert.throws(() => s.addDeviceRoute({ name: 'blocked', identifier: '192.168.1.51', routeId: 'block' }), /route/);
    const updated = s.updateRouteGroup(group.id, { name: 'google', routeId: route.id });
    assert.equal(updated.name, 'google');
    assert.deepEqual(updated.entries, group.entries);
    assert.equal(s.removeRouteGroup(group.id), true);
    assert.equal(s.removeRouteGroup(group.id), false);

    const device = s.addDeviceRoute({ name: 'TV', identifier: '192.168.1.50', routeId: route.id });
    assert.equal(device.identifier, '192.168.1.50');
    assert.throws(() => s.addDeviceRoute({ name: 'bad', identifier: 'not-a-device', routeId: route.id }), /IP or MAC/);
    const changed = s.updateDeviceRoute(device.id, { name: 'TV 2', identifier: 'aa:bb:cc:dd:ee:ff' });
    assert.equal(changed.name, 'TV 2');
    assert.equal(changed.identifier, 'aa:bb:cc:dd:ee:ff');
    assert.equal(s.removeDeviceRoute(device.id), true);
    assert.equal(s.removeDeviceRoute(device.id), false);
    const local = s.addLocalRoute({ alias: 'router.home', target: '192.168.1.1' });
    assert.equal(local.alias, 'router.home');
    assert.equal(local.target, '192.168.1.1');
    assert.throws(() => s.addLocalRoute({ alias: 'router.home', target: 'youtube.com' }), /already exists/);
    assert.throws(() => s.addLocalRoute({ alias: '', target: '192.168.1.1' }), /alias/);
    assert.throws(() => s.addLocalRoute({ alias: 'ytbe.lan', target: 'not-an-address' }), /address/);
    const changedLocal = s.updateLocalRoute(local.id, { target: 'youtube.com' });
    assert.equal(changedLocal.target, 'youtube.com');
    assert.equal(s.removeLocalRoute(local.id), true);
    assert.equal(s.removeLocalRoute(local.id), false);
  } finally {
    s.close();
  }
});
