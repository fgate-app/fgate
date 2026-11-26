import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {normalizeSsProfile} from '../server/ss-profile.js';
import {SsRelaySupervisor} from '../server/ss-relay.js';
const link='ss://'+Buffer.from('chacha20-ietf-poly1305:test-password').toString('base64url')+'@127.0.0.1:9999/?prefix=%16%03%01';
test('SS Relay preserves prefix bytes, rejects unsupported options without exposing credentials',()=>{
 assert.equal(normalizeSsProfile(link).prefix_hex,'160301');
 assert.throws(()=>normalizeSsProfile(link+'&plugin=secret-password'),error=>!error.message.includes('secret-password'));
});
test('SS Relay prepare/commit reuse, rollback and stop manage private loopback processes',async()=>{
 const folder=mkdtempSync(join(tmpdir(),'fg-ss-')),relay=new SsRelaySupervisor({stateDir:folder});
 try{
  const row={profile_id:'fixture',engine:'outline',config:link};
  const initial=await relay.prepare([row]);await initial.commit();
  assert.equal(relay.status().state,'running');
  const entry=relay.entries.get('fixture');assert.equal(statSync(entry.path).mode&0o777,0o600);
  const reuse=await relay.prepare([row]);assert.equal(reuse.bridges.fixture.port,initial.bridges.fixture.port);await reuse.rollback();
  const oldPid=entry.process.pid;entry.process.kill('SIGKILL');
  for(let i=0;i<50 && (!entry.process || entry.process.pid===oldPid);i++)await new Promise(resolve=>setTimeout(resolve,100));
  assert.ok(entry.process && entry.process.pid!==oldPid,'watchdog restarts crashed child');
  await relay.ready(entry);
  const change=await relay.prepare([{...row,config:link.replace('9999','9998')}]);await change.rollback();
  assert.equal(relay.entries.get('fixture'),entry);
  const remove=await relay.prepare([]);await remove.commit();assert.equal(relay.status().state,'stopped');
 }finally{await relay.stop();rmSync(folder,{recursive:true,force:true});}
});
