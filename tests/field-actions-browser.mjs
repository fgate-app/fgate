import {chromium} from '@playwright/test';
import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
const server=spawn('python3',['-u','-m','http.server','18898','--bind','127.0.0.1','--directory','storybook-static'],{stdio:['ignore','pipe','pipe']});let browser;
try{
 await new Promise((resolve,reject)=>{server.stdout.once('data',resolve);server.once('exit',()=>reject(Error('Storybook server failed')));});
 browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage({viewport:{width:900,height:1100}});
 await page.goto('http://127.0.0.1:18898/iframe.html?id=components-field-actions--copy-contents&viewMode=story',{waitUntil:'networkidle'});
 const copies=page.getByRole('button',{name:'Copy contents',exact:true});await copies.first().waitFor();assert.equal(await copies.count(),5);
 await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.copied=text;}}}));
 for(const [index,value] of ['Copy this text','Small input','First line\nSecond line','Small textarea'].entries()){
  const button=copies.nth(index),bounds=await button.boundingBox();assert.equal(bounds.width,24);assert.equal(bounds.height,24);
  await button.click();assert.equal(await page.evaluate(()=>window.copied),value);
 }
 await page.getByLabel('Input m',{exact:true}).fill('Edited contents');await copies.first().click();assert.equal(await page.evaluate(()=>window.copied),'Edited contents');
 assert.equal(await copies.nth(4).isDisabled(),true);assert.equal(await page.getByLabel('Input s',{exact:true}).getAttribute('readonly'),'');
 await page.getByRole('button',{name:'Custom action',exact:true}).click();assert.equal(await page.locator('output').textContent(),'1');
 await page.screenshot({path:'/tmp/fg-field-actions.png',fullPage:true});
 await page.setViewportSize({width:320,height:900});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 console.log('Input and textarea: optional actions, copy current values, 24px buttons, read-only/disabled and narrow layout passed.');
}finally{await browser?.close();server.kill();if(server.exitCode===null)await new Promise(resolve=>server.once('exit',resolve));}
