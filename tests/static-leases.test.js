import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/store.js';

test('static leases pin, replace, conflict and unpin', () => {
  const store = new Store(':memory:');
  const lease = store.pinStaticLease({ mac: 'AA:BB:CC:DD:EE:FF', ip: '10.20.0.150', hostname: 'pixel' });
  assert.equal(lease.mac, 'aa:bb:cc:dd:ee:ff');
  assert.equal(lease.ip, '10.20.0.150');
  assert.equal(lease.hostname, 'pixel');
  assert.deepEqual(store.staticLeases().map(item => item.mac), ['aa:bb:cc:dd:ee:ff']);

  const updated = store.pinStaticLease({ mac: 'aa:bb:cc:dd:ee:ff', ip: '10.20.0.151', hostname: 'pixel-2' });
  assert.equal(updated.ip, '10.20.0.151');
  assert.equal(store.staticLeases().length, 1);

  assert.throws(() => store.pinStaticLease({ mac: 'aa:bb:cc:dd:ee:00', ip: '10.20.0.151' }), /already assigned/);
  assert.throws(() => store.pinStaticLease({ mac: 'not-a-mac', ip: '10.20.0.150' }), /MAC/);
  assert.throws(() => store.pinStaticLease({ mac: 'aa:bb:cc:dd:ee:01', ip: 'not-an-ip' }), /IP/);

  assert.equal(store.unpinStaticLease('AA:BB:CC:DD:EE:FF'), true);
  assert.equal(store.staticLeases().length, 0);
  assert.equal(store.unpinStaticLease('aa:bb:cc:dd:ee:ff'), false);
  store.db.close();
});
