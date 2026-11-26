import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {managedSocketIdentity} from '../server/managed-socket-identity.js';
test('service gathers only socket inodes of its own managed process and retains its start identity',async()=>{
 const root=await mkdtemp(join(tmpdir(),'fg-process-'));
 try{
  await mkdir(root+'/200/fd',{recursive:true});
  await writeFile(root+'/200/stat','200 (engine with spaces) '+['S',...Array(18).fill('0'),'12345'].join(' '));
  await symlink('socket:[123]',root+'/200/fd/1');await symlink('socket:[456]',root+'/200/fd/2');await symlink('/dev/null',root+'/200/fd/3');
  const result=await managedSocketIdentity(200,{root});assert.equal(result.processStartedAt,'12345');assert.deepEqual(result.inodes.sort(),['123','456']);
  await assert.rejects(managedSocketIdentity(200,{root,uid:process.getuid()+1}),/Foreign/);
  await assert.rejects(managedSocketIdentity(1,{root}),/Invalid/);
 }finally{await rm(root,{recursive:true,force:true});}
});
