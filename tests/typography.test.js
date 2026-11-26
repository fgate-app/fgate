import test from 'node:test';
import assert from 'node:assert/strict';
import {readdir,readFile} from 'node:fs/promises';
import {join} from 'node:path';
async function sources(directory){
 const result=[];
 for(const entry of await readdir(directory,{withFileTypes:true})){
  const path=join(directory,entry.name);
  if(entry.isDirectory())result.push(...await sources(path));
  else if(/\.(css|vue|js)$/.test(path))result.push(path);
 }
 return result;
}
test('font sizes use defined typography tokens throughout the design system',async()=>{
 const tokens=await readFile('web/public/typography.css','utf8');
 const definitions=new Set([...tokens.matchAll(/(--font-size-[\w-]+)\s*:/g)].map(match=>match[1]));
 for(const path of [...await sources('web/src'),'web/public/offline.html']){
  const source=await readFile(path,'utf8');
  for(const match of source.matchAll(/(?<![-\w])font-size\s*:\s*([^;}]+)/g))assert.ok(match[1].startsWith('var(--font-size-') || match[1]==='inherit',path+': '+match[0]);
  for(const match of source.matchAll(/var\((--font-size-[\w-]+)\)/g))assert.ok(definitions.has(match[1]),path+': undefined '+match[1]);
 }
});
