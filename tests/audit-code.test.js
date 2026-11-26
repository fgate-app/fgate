import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {auditCode} from '../scripts/audit-code.mjs';

test('code audit detects raw form errors while allowing translated UI labels',()=>{
 const dir=mkdtempSync(join(tmpdir(),'fg-audit-'));
 try{
  for(const name of ['server','shared','scripts','web/src'])mkdirSync(join(dir,name),{recursive:true});
  writeFileSync(join(dir,'server/sample.js'),"throw new Error('Ошибка сервера');");
  writeFileSync(join(dir,'web/src/sample.vue'),`<script setup>
function failed(){reportError('Ошибка формы');}
function translated(){reportError(t('Переведённая ошибка'));}
function english(){reportError('Could not complete the action.');}
</script><template><button @click="failed();translated();english()">Кнопка</button></template>`);
  const result=auditCode(dir);
  assert.equal(result.messages.length,2);
  assert.deepEqual(result.messages.map(row=>row.file),['server/sample.js','web/src/sample.vue']);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
