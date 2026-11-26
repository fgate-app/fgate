import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {DatabaseSync} from 'node:sqlite';
import {spawnSync} from 'node:child_process';
import {HttpError,readJsonBody} from '../server/http.js';
import {transaction} from '../server/database.js';
import {normalizeStaticLeases,dnsmasqConfig,nftConfig} from '../server/network-config.js';

test('JSON transport preserves a UTF-8 character split across incoming chunks and rejects non-objects',async()=>{
 const bytes=Buffer.from('{"name":"Телефон"}'),split=bytes.indexOf(0xd0)+1;
 const req=Object.assign(Readable.from([bytes.subarray(0,split),bytes.subarray(split)]),{method:'POST',url:'/api/users'});
 assert.equal((await readJsonBody(req)).name,'Телефон');
 for(const text of ['[]','null','invalid'])await assert.rejects(readJsonBody(Object.assign(Readable.from([text]),{method:'PUT',url:'/api/settings'})),e=>e instanceof HttpError && e.status===400);
 const payload=JSON.stringify({entries:'x'.repeat(300001)});
 await assert.rejects(readJsonBody(Object.assign(Readable.from([payload]),{method:'POST',url:'/api/users'})),e=>e.status===413);
 assert.ok(await readJsonBody(Object.assign(Readable.from([payload]),{method:'POST',url:'/api/routes/groups'})));
});

test('database transaction rolls back earlier writes when a later statement fails',()=>{
 const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE items (name TEXT UNIQUE)');
 try{
  assert.throws(()=>transaction(db,()=>{db.prepare('INSERT INTO items VALUES (?)').run('one');db.prepare('INSERT INTO items VALUES (?)').run('one');}));
  assert.equal(db.prepare('SELECT count(*) AS n FROM items').get().n,0);
  assert.equal(transaction(db,()=>{db.prepare('INSERT INTO items VALUES (?)').run('two');return 42;}),42);
  assert.equal(db.prepare('SELECT count(*) AS n FROM items').get().n,1);
 }finally{db.close();}
});

test('helper configuration can be checked without starting a daemon and keeps safe DHCP names',()=>{
 const leases=normalizeStaticLeases([{mac:'AA:BB:CC:DD:EE:FF',ip:'10.20.0.10',hostname:'Телефон дома'},{mac:'aa:bb:cc:dd:ee:ff',ip:'10.20.0.11'},{mac:'invalid',ip:'10.20.0.12'}]);
 assert.equal(leases.length,1);
 const config=dnsmasqConfig('wlan0','10.20.0.1','10.20.0.100','10.20.0.200',leases);
 assert.ok(config.includes('dhcp-host=aa:bb:cc:dd:ee:ff,10.20.0.10\n'));
 assert.ok(!config.includes('Телефон дома'));
 const nft=nftConfig('wlan0','eth0','10.20.0.0/24','192.168.1.0/24');
 assert.ok(nft.includes('table inet freedomgate_nat'));assert.ok(nft.includes('redirect to :53053'));assert.ok(nft.includes('tcp dport 853 drop'));
});

test('installation download failures remove partial archives and module links preserve independent updates',()=>{
 const script=`
import pathlib,tempfile,sys,hashlib,io
sys.path.insert(0,'scripts')
import install_support as support
with tempfile.TemporaryDirectory() as work:
 root=pathlib.Path(work);path=root/'archive'
 support.urllib.request.urlopen=lambda *a,**k:io.BytesIO(b'fixture')
 try:support.verified_download('https://example.test/archive',path,'0'*64)
 except ValueError:pass
 else:raise AssertionError('checksum must fail')
 assert not path.exists()
 support.verified_download('https://example.test/archive',path,hashlib.sha256(b'fixture').hexdigest())
 assert path.read_bytes()==b'fixture'
 (root/'updated').mkdir();(root/'pinned').mkdir();(root/'current').symlink_to('updated')
 support.initial_link(root/'current','pinned')
 assert (root/'current').resolve()==(root/'updated').resolve()
`;
 const result=spawnSync('python3',['-c',script],{encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);
});
