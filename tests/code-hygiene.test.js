import test from 'node:test';
import assert from 'node:assert/strict';
import {auditCode} from '../scripts/audit-code.mjs';

test('first-party sources contain no untranslated Cyrillic errors, unused imports or duplicate function bodies',()=>{
 const result=auditCode();assert.ok(result.files>250);
 assert.deepEqual(result.messages,[]);assert.deepEqual(result.unusedImports,[]);assert.deepEqual(result.unusedBindings,[]);assert.deepEqual(result.duplicates,[]);
});
