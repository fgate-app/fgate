import {chromium} from '@playwright/test';
import {readFile,writeFile} from 'node:fs/promises';
const root=new URL('../web/public/',import.meta.url);
const logo=(await readFile(new URL('freedomgate.svg',root),'utf8')).replaceAll('currentColor','#0084ff');
const artwork=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${logo.replace('<svg ','<svg x="10" y="2" width="44" height="60" ')}</svg>`;
await writeFile(new URL('favicon.svg',root),artwork);
const browser=await chromium.launch({channel:'chrome',headless:true});
try{
 const pngs=[];
 for(const size of [16,32,180]){
  const page=await browser.newPage({viewport:{width:size,height:size},deviceScaleFactor:1});
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:100vw;height:100vh}</style>${artwork}`);
  const png=await page.screenshot({omitBackground:true});
  await writeFile(new URL(size===180?'icons/browser-touch-180.png':`favicon-${size}.png`,root),png);
  if(size!==180)pngs.push({size,png});await page.close();
 }
 const header=Buffer.alloc(6+16*pngs.length);header.writeUInt16LE(1,2);header.writeUInt16LE(pngs.length,4);let offset=header.length;
 pngs.forEach(({size,png},index)=>{const at=6+16*index;header[at]=size;header[at+1]=size;header.writeUInt16LE(1,at+4);header.writeUInt16LE(32,at+6);header.writeUInt32LE(png.length,at+8);header.writeUInt32LE(offset,at+12);offset+=png.length;});
 await writeFile(new URL('favicon.ico',root),Buffer.concat([header,...pngs.map(item=>item.png)]));
}finally{await browser.close();}
