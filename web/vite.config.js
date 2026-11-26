import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const pwa={name:'freedomgate-pwa',generateBundle(_,bundle){
 const id=createHash('sha256');
 for(const file of Object.values(bundle))id.update(file.type==='chunk'?file.code:String(file.source));
 const source=readFileSync(new URL('./pwa/sw.js',import.meta.url),'utf8');
 id.update(source);id.update(readFileSync(new URL('./public/offline.html',import.meta.url)));id.update(readFileSync(new URL('./public/typography.css',import.meta.url)));id.update(readFileSync(new URL('./public/colors.css',import.meta.url)));
 this.emitFile({type:'asset',fileName:'sw.js',source:source.replace('__BUILD_ID__',id.digest('hex').slice(0,16))});
}};
import { fileURLToPath } from 'node:url';
export default defineConfig({root:fileURLToPath(new URL('.',import.meta.url)),plugins:[vue(),pwa],server:{host:'127.0.0.1',proxy:{'/api':'http://127.0.0.1:8787'}}});
