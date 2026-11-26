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
 await page.route('**/api/clients',route=>route.fulfill({json:{clients:[{mac:'aa:bb:cc:dd:ee:ff',ip:'10.20.0.115',hostname:'Pixel 7',online:true,traffic:{upload:1024,download:4096},expiresAt:Date.now()+600000}]}}));
 await page.goto(base,{waitUntil:'networkidle'});await page.getByLabel('Username').fill('admin');await page.getByLabel('Password',{exact:true}).fill('test password 12345');await page.getByRole('button',{name:'Create administrator'}).click();await page.getByTestId('overview-dashboard').waitFor();
 const fixtures=['ss','ssr','outline','vless','vmess','wireguard','openvpn','http','socks4','socks5','trojan','tuic','direct','zapret'];
 await page.route('**/api/profiles',route=>route.fulfill({json:fixtures.map((protocol,index)=>({id:'fixture-'+index,name:'Fixture '+protocol,protocol:protocol==='zapret'?'socks5':protocol,engine:protocol==='zapret'?'zapret':protocol==='direct'?'direct':null,builtin:protocol==='direct',enabled:true}))}));
 await page.setViewportSize({width:1440,height:1000});await page.goto(base+'/connections',{waitUntil:'networkidle'});
 const row=protocol=>page.getByTestId('exit-row').filter({hasText:'Fixture '+protocol}).first();
 assert.equal(await page.getByTestId('exit-list').locator('.protocol-icon').count(),0);
 assert.equal(await page.getByTestId('exit-list').getByRole('columnheader',{name:'Type',exact:true}).count(),0);
 const subtitle=row('vless').getByTestId('connection-type');assert.equal((await subtitle.textContent()).trim(),'VLESS');assert.equal(await subtitle.locator('xpath=ancestor::td').count(),1);assert.ok(await subtitle.evaluate(el=>el.getBoundingClientRect().top>=el.previousElementSibling.getBoundingClientRect().bottom));
 for(const theme of ['dark','light']){
  await page.evaluate(theme=>localStorage.setItem('fg.theme',theme),theme);await page.reload({waitUntil:'networkidle'});await row('vless').waitFor();
  assert.equal(await page.getByTestId('exit-list').locator('.protocol-icon').count(),0);
  assert.equal(await page.getByTestId('exit-row').count(),fixtures.length);
  await page.screenshot({path:'/tmp/fg-gateways-no-icons-'+theme+'.png',fullPage:true});
 }
 assert.deepEqual(errors,[]);console.log('Gateway names and type subtitles without protocol icons in both themes passed.');
}finally{await browser?.close();child.kill();await new Promise(resolve=>child.once('exit',resolve));rmSync(folder,{recursive:true,force:true});}
