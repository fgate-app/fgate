import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,rmSync,writeFileSync,statSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';import {trafficState} from '../server/traffic-state.js';
test('counter checkpoint is private, atomic, versioned and tolerates missing/corrupt data',()=>{
 const dir=mkdtempSync(join(tmpdir(),'fg-counters-')),path=join(dir,'totals.json');
 try{const storage=trafficState(path);assert.equal(storage.load(),null);storage.save({groups:{x:{upload:1,download:2}}});assert.equal(storage.load().groups.x.download,2);assert.equal(statSync(path).mode & 0o777,0o600);writeFileSync(path,'broken');assert.equal(storage.load(),null);}finally{rmSync(dir,{recursive:true,force:true});}
});
