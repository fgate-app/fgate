import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const dictionary=language=>JSON.parse(readFileSync(new URL(`../web/src/locales/${language}.json`,import.meta.url),'utf8'));
test('Simplified Chinese covers every English and Russian interface string',()=>{
 const zh=dictionary('zh-CN');
 for(const language of ['en','ru'])for(const key of Object.keys(dictionary(language)))assert.ok(typeof zh[key]==='string' && zh[key].trim(),`Missing Chinese translation: ${key}`);
 for(const [key,value] of Object.entries(zh))assert.ok(!/[А-Яа-яЁё]/.test(value),`Russian fallback in Chinese: ${key}`);
});
