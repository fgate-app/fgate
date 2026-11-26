import {chromium} from '@playwright/test';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import assert from 'node:assert/strict';
const folder=mkdtempSync(join(tmpdir(),'fg-mobile-')),child=spawn(process.execPath,['server/index.js'],{env:{...process.env,PORT:'18884',FREEDOMGATE_DB:join(folder,'db.sqlite')},stdio:['ignore','pipe','pipe']});let browser;
try{
 await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('exit',()=>reject(Error('Server failed')));});
 browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage({viewport:{width:390,height:844}}),base='http://127.0.0.1:18884',errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/api/dashboard',route=>route.fulfill({json:{cpu:{percent:30},memory:{percent:50},traffic:{uploadRate:120,downloadRate:220}}}));
 await page.route('**/api/clients',route=>route.fulfill({json:{clients:[{mac:'aa:bb:cc:dd:ee:ff',ip:'10.20.0.115',hostname:'Pixel 7',online:true,traffic:{upload:1024,download:4096},expiresAt:Date.now()+600000}]}}));
 await page.goto(base,{waitUntil:'networkidle'});await page.getByLabel('Username').fill('admin');await page.getByLabel('Password',{exact:true}).fill('test password 12345');await page.getByRole('button',{name:'Create administrator'}).click();await page.getByTestId('overview-dashboard').waitFor();
 const session=await(await page.request.get(base+'/api/auth/session')).json();
 await page.evaluate(({id})=>localStorage.setItem('fg.metric-history.v1:'+id,JSON.stringify([0,1,2].map(i=>({time:Date.now()-15000+i*5000,cpu:20+i,memory:40+i,upload:100+i,download:200+i})))),session.user);
 await page.reload({waitUntil:'networkidle'});
 const chart=page.locator('.overview-traffic .dashboard-line').first();
 await chart.waitFor();
 assert.ok((await chart.getAttribute('d')).includes('C'),'restored history renders a line immediately');
 await page.getByTestId('mobile-navigation-toggle').click();await page.getByRole('dialog',{name:'Navigation',exact:true}).getByRole('button',{name:'Gateways',exact:true}).click();
 const before=await page.evaluate(({id})=>JSON.parse(localStorage.getItem('fg.metric-history.v1:'+id)).length,session.user);
 await page.waitForTimeout(5500);
 const after=await page.evaluate(({id})=>JSON.parse(localStorage.getItem('fg.metric-history.v1:'+id)).length,session.user);
 assert.ok(after>before,'history keeps collecting outside overview');
 await page.getByTestId('mobile-navigation-toggle').click();await page.getByRole('dialog',{name:'Navigation',exact:true}).getByRole('button',{name:'Overview',exact:true}).click();
 assert.ok((await chart.getAttribute('d')).includes('C'),'return keeps chart history');
 await page.reload({waitUntil:'networkidle'});assert.ok((await chart.getAttribute('d')).includes('C'),'reload keeps chart history');
 const charts=page.locator('.dashboard-chart');
 for(let index=0;index<3;index++){
  const svg=charts.nth(index).locator('svg');await svg.scrollIntoViewIfNeeded();const rect=await svg.boundingBox();
  await page.mouse.move(rect.x+rect.width-14,rect.y+60);
  const tip=page.getByRole('tooltip');await tip.waitFor();assert.match(await tip.locator('time').textContent(),/\d{2}:\d{2}:\d{2}/);
  assert.match(await tip.textContent(),index===0?/B\/s/:/%/);
  assert.equal(await tip.locator('div').count(),index===0?2:1);
  const bounds=await tip.boundingBox();assert.ok(bounds.x>=0 && bounds.x+bounds.width<=390,'tooltip fits mobile viewport');
  await page.mouse.move(1,1);await tip.waitFor({state:'hidden'});
  await svg.focus();await page.keyboard.press('End');await tip.waitFor();await page.keyboard.press('Home');await tip.waitFor();await page.keyboard.press('Escape');await tip.waitFor({state:'hidden'});
 }
 const svg=charts.first().locator('svg');await svg.scrollIntoViewIfNeeded();const rect=await svg.boundingBox();
 await svg.dispatchEvent('pointerdown',{clientX:rect.x+rect.width-14,clientY:rect.y+60,pointerType:'touch'});await page.getByRole('tooltip').waitFor();
 await svg.dispatchEvent('pointerleave',{pointerType:'touch'});await page.getByRole('tooltip').waitFor();
 await svg.evaluate(el=>el.closest('.data-card').scrollIntoView({block:'center'}));
 await page.screenshot({path:'/tmp/fg-dashboard-tooltip-mobile.png',fullPage:false});
 await page.setViewportSize({width:1440,height:1000});await svg.hover({position:{x:300,y:60}});await page.getByRole('tooltip').waitFor();await page.screenshot({path:'/tmp/fg-dashboard-tooltip-desktop.png',fullPage:true});
 assert.deepEqual(errors,[]);console.log('Overview history restores on entry/reload and collects while another section is open.');
}finally{await browser?.close();child.kill();await new Promise(resolve=>child.once('exit',resolve));rmSync(folder,{recursive:true,force:true});}
