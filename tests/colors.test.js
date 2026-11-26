import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
async function walk(path){const result=[];for(const entry of await readdir(path,{withFileTypes:true})){const file=join(path,entry.name);if(entry.isDirectory())result.push(...await walk(file));else if(/\.(css|vue|js)$/.test(file))result.push(file);}return result;}
test('interface colors resolve through semantic tokens and keep only required palette aliases',async()=>{
 const colors=await readFile('web/public/colors.css','utf8'),sources=await Promise.all((await walk('web/src')).map(async path=>({path,source:await readFile(path,'utf8')})));
 const definitions=new Set([...colors.matchAll(/(--(?:color|palette)-[\w-]+)\s*:/g)].map(match=>match[1]));
 for(const {path,source} of sources)for(const match of source.matchAll(/var\((--(?:color|palette)-[\w-]+)/g))assert.ok(definitions.has(match[1]),path+': undefined '+match[1]);
 assert.deepEqual([...definitions].filter(token=>token.startsWith('--palette-')).sort(),['--palette-30','--palette-39','--palette-9']);
 for(const block of colors.matchAll(/\{([^{}]+)\}/g)){
  const values=[...block[1].matchAll(/#[\da-fA-F]{6}\b/g)].map(match=>match[0].toLowerCase());assert.equal(new Set(values).size,values.length,'duplicate solid color in one theme');
 }
});
