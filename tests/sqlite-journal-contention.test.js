import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {Store} from '../server/store.js';
import {startSystemJournal} from '../server/system-journal.js';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const entry={__CURSOR:'fixture-cursor',__REALTIME_TIMESTAMP:'1794768780000000',SYSLOG_IDENTIFIER:'hostapd',MESSAGE:'AP-ENABLED'};
async function writer(path){
 const child=spawn(process.execPath,['--input-type=module','-e',`import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(process.argv[1]);db.exec('BEGIN IMMEDIATE');process.stdout.write('locked\\n');process.stdin.once('data',()=>{db.exec('COMMIT');db.close();process.exit(0);});`,path],{stdio:['pipe','pipe','pipe']});
 let stderr='';child.stderr.on('data',chunk=>stderr+=chunk);const exited=new Promise(resolve=>child.once('exit',code=>resolve(code)));
 await new Promise((resolve,reject)=>{child.once('error',reject);child.stdout.once('data',()=>resolve());child.once('exit',()=>reject(Error('Writer exited before lock: '+stderr)));});
 return {async release(){child.stdin.end('release');assert.equal(await exited,0,stderr);}};
}
async function fixture(run){const dir=await mkdtemp(join(tmpdir(),'fg-journal-busy-')),path=join(dir,'state.sqlite'),store=new Store(path);let lock,monitor;try{await run({store,path,setLock:value=>lock=value,setMonitor:value=>monitor=value});}finally{monitor?.stop();await lock?.release();store.close();await rm(dir,{recursive:true,force:true});}}
for(const duration of [250,1500])test(`journal survives ${duration}ms real SQLite writer contention without advancing its cursor`,t=>fixture(async({store,path,setLock,setMonitor})=>{
 const settings=store.settings();let hasEntries=false,reads=0,attempts=0,maxWriteMs=0;
 const original=store.recordJournalEntry.bind(store);
 store.recordJournalEntry=(...args)=>{const start=performance.now();try{attempts++;return original(...args);}finally{maxWriteMs=Math.max(maxWriteMs,performance.now()-start);}};
 const read=async()=>{reads++;return {stdout:hasEntries?JSON.stringify(entry)+'\n':''};};
 const monitor=startSystemJournal(store,{interval:25,read});setMonitor(monitor);await tick();
 const lock=await writer(path);setLock(lock);hasEntries=true;
 const start=performance.now();assert.throws(()=>store.recordEvent('system','fixture',200),error=>{assert.equal(error.errcode&255,5);return true;});assert.ok(performance.now()-start<500);
 let beats=0;const timer=setInterval(()=>beats++,20);try{await new Promise(resolve=>setTimeout(resolve,duration));}finally{clearInterval(timer);}
 assert.equal(store.journalCursor(),'');assert.equal(store.db.prepare('SELECT count(*) AS n FROM events').get().n,0);assert.deepEqual(store.settings(),settings);assert.ok(attempts>=2);assert.ok(beats>=2);assert.ok(maxWriteMs<500,'Logging does not block the event loop waiting for a writer');
 const blockedAttempts=attempts,observedLockMs=performance.now()-start;await lock.release();setLock(null);await monitor.poll();
 assert.equal(store.journalCursor(),entry.__CURSOR);assert.equal(store.db.prepare('SELECT count(*) AS n FROM events').get().n,1);assert.deepEqual(store.settings(),settings);
 await monitor.poll();assert.equal(store.db.prepare('SELECT count(*) AS n FROM events').get().n,1,'Replay must not duplicate an event');assert.ok(reads>=3);t.diagnostic(JSON.stringify({requestedLockMs:duration,observedLockMs:Math.round(observedLockMs),blockedAttempts,heartbeatTicks:beats,maxWriteMs:Math.round(maxWriteMs*100)/100}));
}));

test('journal cursor reset and failure reporting survive a locked database and recover',()=>fixture(async({store,path,setLock,setMonitor})=>{
 store.db.prepare('INSERT INTO system_journal_state VALUES (1,?)').run('old-cursor');
 let mode='empty';const read=async()=>{if(mode==='failed')throw Object.assign(Error('private reader failure'),{stderr:'Failed to seek to cursor'});return {stdout:mode==='entry'?JSON.stringify(entry)+'\n':''};};
 const monitor=startSystemJournal(store,{interval:2147483647,read});setMonitor(monitor);await tick();
 const lock=await writer(path);setLock(lock);mode='failed';await assert.doesNotReject(monitor.poll());await assert.doesNotReject(monitor.poll());
 assert.equal(store.journalCursor(),'old-cursor');assert.equal(store.db.prepare('SELECT count(*) AS n FROM events').get().n,0);
 await lock.release();setLock(null);await monitor.poll();assert.equal(store.journalCursor(),'');assert.equal(store.db.prepare('SELECT count(*) AS n FROM events').get().n,1);
 await monitor.poll();assert.equal(store.db.prepare('SELECT count(*) AS n FROM events').get().n,1);
 mode='entry';await monitor.poll();assert.equal(store.journalCursor(),entry.__CURSOR);const rows=store.db.prepare('SELECT action,detail FROM events').all();assert.equal(rows.length,2);assert.ok(!JSON.stringify(rows).includes('private'));
}));
