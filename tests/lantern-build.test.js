import test from 'node:test';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';
test('Lantern source mismatch and unsafe module adoption are rejected',()=>{const result=spawnSync('python3',['tests/test_lantern_build.py'],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);assert.match(result.stderr,/OK/);});
