import {chromium} from '@playwright/test';
import {readFile,mkdir} from 'node:fs/promises';
const directory=new URL('../web/public/icons/',import.meta.url);
await mkdir(directory,{recursive:true});
const logo=await readFile(new URL('../web/public/freedomgate.svg',import.meta.url),'utf8');
const artwork=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" fill="#101318"/>${logo.replace('<svg ', '<svg x="148" y="112" width="216" height="288" ').replaceAll('currentColor','#93c5fd')}</svg>`;
const browser=await chromium.launch({channel:'chrome',headless:true});
try{
 for(const [name,size] of [['icon-192',192],['icon-512',512],['icon-maskable-512',512],['apple-touch-icon',180]]){
  const page=await browser.newPage({viewport:{width:size,height:size},deviceScaleFactor:1});
  await page.setContent(`<style>html,body{margin:0;width:100%;height:100%}body>svg{display:block;width:100%;height:100%}</style>${artwork}`);
  await page.screenshot({path:new URL(name+'.png',directory).pathname});await page.close();
 }
}finally{await browser.close();}
