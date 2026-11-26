import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {createServer} from '../server/index.js';
import {Store} from '../server/store.js';
const store=new Store(':memory:'),server=createServer(store);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`,browser=await chromium.launch({channel:'chrome',headless:true});
try{
 const page=await browser.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto(base);const links=await page.locator('link[rel="icon"],link[rel="apple-touch-icon"]').evaluateAll(nodes=>nodes.map(node=>node.getAttribute('href')));assert.ok(links.includes('/favicon.svg') && links.includes('/favicon-32.png') && links.includes('/favicon.ico') && links.includes('/icons/browser-touch-180.png'));assert.ok(links.every(url=>!url.startsWith('data:')));
 for(const path of links){const response=await fetch(base+path);assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/image\//);}
 for(const path of ['/favicon-16.png','/favicon-32.png','/icons/browser-touch-180.png']){const alpha=await page.evaluate(async path=>{const image=new Image();image.src=path;await image.decode();const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);return [...ctx.getImageData(0,0,1,1).data];},path);assert.equal(alpha[3],0);}
 for(const viewport of [{width:1280,height:900},{width:390,height:844}]){
  await page.setViewportSize(viewport);await page.goto('http://127.0.0.1:6006/iframe.html?id=components-micro-notifications--layout-regression&viewMode=story');
  await page.getByRole('button',{name:'Short notification',exact:true}).evaluate(button=>button.click());await page.getByRole('button',{name:'Long notification',exact:true}).evaluate(button=>button.click());await page.getByRole('button',{name:'Short notification',exact:true}).evaluate(button=>button.click());
  const check=async()=>{const layout=await page.locator('.toast-stack').evaluate(el=>{const r=el.getBoundingClientRect(),items=[...el.querySelectorAll('.toast')].map(item=>({height:item.getBoundingClientRect().height,text:item.textContent}));return {height:r.height,bottom:r.bottom,items};});assert.ok(layout.height<viewport.height-16);assert.ok(layout.items[0].height<90);assert.ok(layout.items[2].height<90);assert.ok(layout.items[1].height>layout.items[0].height);};
  await check();await page.getByRole('button',{name:'Open modal',exact:true}).evaluate(button=>button.click());await page.getByRole('dialog',{name:'Toast test'}).waitFor();await page.locator('dialog [data-popup-host] .toast-stack').waitFor();await check();
  await page.locator('.toast-close').first().click();assert.equal(await page.locator('.toast').count(),2);
  await page.screenshot({path:`/tmp/fg-toast-${viewport.width}.png`});await page.keyboard.press('Escape');await page.locator('body>.toast-stack').waitFor();await page.getByRole('button',{name:'Clear notifications',exact:true}).evaluate(button=>button.click());assert.equal(await page.locator('.toast').count(),0);
 }
 assert.deepEqual(errors,[]);console.log('Static transparent browser icons and content-sized desktop/mobile notification stacks with modal reparenting passed.');
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));store.close();}
