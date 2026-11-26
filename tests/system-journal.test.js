import test from 'node:test';
import assert from 'node:assert/strict';
import {Auth} from '../server/auth.js';
import {Store} from '../server/store.js';
import {classifySystemEvent,startSystemJournal} from '../server/system-journal.js';

test('system journal recognises failures and disconnects without storing raw messages',()=>{
 assert.deepEqual(classifySystemEvent({SYSLOG_IDENTIFIER:'hostapd',MESSAGE:'wlan0: STA aa:bb:cc:dd:ee:ff IEEE 802.11: disassociated'}),['SYSTEM wifi-disconnected',299]);
 assert.deepEqual(classifySystemEvent({SYSLOG_IDENTIFIER:'dnsmasq',MESSAGE:'bad DHCP host name at line 5'}),['SYSTEM dhcp-failed',503]);
 assert.deepEqual(classifySystemEvent({_SYSTEMD_UNIT:'freedomgate.service',MESSAGE:'FreedomGate: runtime restore failed: restore'}),['SYSTEM restore-failed',503,{service:'freedomgate.service'}]);
 assert.deepEqual(classifySystemEvent({_SYSTEMD_UNIT:'freedomgate.service',MESSAGE:'FreedomGate startup: {"stage":"mihomo","state":"failed","code":"RESULT_FAILED"}'}),['SYSTEM restore-failed',503,{service:'freedomgate.service',stage:'mihomo'}]);
 assert.equal(classifySystemEvent({SYSLOG_IDENTIFIER:'hostapd',MESSAGE:'WPA: sending 1/4 secret'}),null);
 assert.equal(classifySystemEvent({SYSLOG_IDENTIFIER:'dnsmasq',MESSAGE:'DHCPACK(wlan0) 10.20.0.2 phone'}),null);
 assert.deepEqual(classifySystemEvent({SYSLOG_IDENTIFIER:'systemd',MESSAGE:'freedomgate-network.service: Failed with result exit-code'}),['SYSTEM service-failed',503,{service:'freedomgate-network.service'}]);
});

test('journal resumes from persistent cursor and retains original event time',async()=>{
 const store=new Store(':memory:');new Auth(store.db);let args,resolveRead;
 const entry={__CURSOR:'cursor1',__REALTIME_TIMESTAMP:'1794768780000000',SYSLOG_IDENTIFIER:'hostapd',MESSAGE:'IEEE 802.11: disassociated secret'};
 const monitor=startSystemJournal(store,{read:async(_,a)=>{args=a;return await new Promise(resolve=>{resolveRead=resolve;});}});
 resolveRead({stdout:JSON.stringify(entry)+'\n'});
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(store.events().length,1);assert.equal(store.events()[0].timestamp,'2026-11-15T18:53:00.000Z');
 assert.ok(!JSON.stringify(store.events()).includes('secret'));assert.equal(store.journalCursor(),'cursor1');
 store.recordJournalEntry({...entry,__CURSOR:'cursor2'},classifySystemEvent(entry));assert.equal(store.events().length,1,'repeated driver notifications are deduplicated');
 const pending=monitor.poll();assert.ok(args.includes('--after-cursor=cursor2'));
 resolveRead({stdout:''});await pending;assert.equal(store.events().length,1);
 monitor.stop();store.close();
});

test('journal reader failure is visible once and stopped monitor ignores late results',async()=>{
 const store=new Store(':memory:');new Auth(store.db);const monitor=startSystemJournal(store,{read:async()=>{throw new Error('permission denied');}});
 await new Promise(resolve=>setImmediate(resolve));await monitor.poll();
 assert.equal(store.events().length,1);assert.equal(store.events()[0].action,'SYSTEM journal-unavailable');
 monitor.stop();await monitor.poll();store.close();
});

test('journal retains only the recognised failed component and service, never raw failure text',()=>{
 const store=new Store(':memory:');new Auth(store.db);try{const entry={__CURSOR:'named',__REALTIME_TIMESTAMP:'1794768780000000',_SYSTEMD_UNIT:'freedomgate.service',MESSAGE:'FreedomGate startup: {"stage":"runtime","state":"failed","stageFailed":"adguard","secret":"private"}'};store.recordJournalEntry(entry,classifySystemEvent(entry));const event=store.events()[0];assert.deepEqual(JSON.parse(event.detail),{service:'freedomgate.service',stage:'adguard'});assert.ok(!JSON.stringify(event).includes('private'));}finally{store.close();}
});
