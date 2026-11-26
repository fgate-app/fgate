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
 let setup={uplink:{interface:'eth0'},client:{interface:'wlan0',type:'ap',ssid:'fgate',password:'testpass123',subnet:'10.20.0.1/24'}},saved=0,applied=0,fail=false;
 const interfaces=[{name:'eth0',type:'ethernet',state:'up',carrier:true},{name:'wlan0',type:'wifi',state:'up',carrier:true}];
 let trafficCalls=0;
 await page.route('**/api/network/traffic',route=>{trafficCalls++;return route.fulfill({json:{interfaces:{eth0:{receiveRate:2048*trafficCalls,transmitRate:1024},wlan0:{receiveRate:512,transmitRate:4096}}}});});
 await page.route('**/api/network',async route=>{
  if(route.request().method()==='PUT'){saved++;setup=route.request().postDataJSON();}
  await route.fulfill({json:{setup,interfaces,plan:[],warnings:[]}});
 });
 await page.route('**/api/network/apply',async route=>{
  applied++;assert.equal(route.request().method(),'POST');
  if(fail)return route.fulfill({status:502,json:{error:'Test helper unavailable'}});
  setup=route.request().postDataJSON();await route.fulfill({json:{setup,plan:[],warnings:['Test warning']}});
 });
 await page.goto(base,{waitUntil:'networkidle'});await page.getByLabel('Username').fill('admin');await page.getByLabel('Password',{exact:true}).fill('test password 12345');await page.getByRole('button',{name:'Create administrator'}).click();await page.getByTestId('overview-dashboard').waitFor();
 await page.goto(base+'/settings/network',{waitUntil:'networkidle'});
 await page.getByLabel('SSID',{exact:true}).waitFor();
 assert.equal(await page.getByLabel('DHCP from',{exact:true}).inputValue(),'10.10.0.100','old record has editable defaults');
 await page.getByLabel('SSID',{exact:true}).fill('fgate test');
 const password=page.getByLabel('Wi-Fi password',{exact:true});
 assert.equal(await password.getAttribute('type'),'password');
 const eyeBounds=await page.getByRole('button',{name:'Show password',exact:true}).boundingBox();assert.equal(eyeBounds.width,24);assert.equal(eyeBounds.height,24);
 await page.getByRole('button',{name:'Show password',exact:true}).click();assert.equal(await password.getAttribute('type'),'text');
 await page.getByRole('button',{name:'Hide password',exact:true}).click();assert.equal(await password.getAttribute('type'),'password');
 assert.equal(await page.getByTestId('network-summary').count(),0);
 assert.equal(await page.getByTestId('network-topology').count(),0);
 assert.equal(await page.locator('.dns-actions button').count(),1);
 await page.getByRole('switch',{name:'Enable wired network',exact:true}).check();
 await page.getByRole('combobox',{name:'Wired port',exact:true}).click();await page.getByRole('option',{name:/eth0/}).click();
 await page.getByLabel('VLAN ID (optional)',{exact:true}).fill('20');
 assert.equal(await page.getByLabel('Wired client subnet',{exact:true}).inputValue(),'10.30.0.1/24');
 assert.equal(applied,0);assert.equal(saved,0);
 await page.getByRole('button',{name:'Save and apply',exact:true}).click();
 assert.equal(setup.wired.enabled,true);assert.equal(setup.wired.vlanId,'20');assert.equal(setup.client.subnet,'10.20.0.1/24');

 await page.getByText('Test warning',{exact:true}).waitFor();assert.equal(applied,1);assert.equal(saved,0);
 await page.getByRole('combobox',{name:'Uplink',exact:true}).click();assert.ok(await page.getByRole('option',{name:/eth0/}).isVisible(),'apply retains interface inventory');await page.keyboard.press('Escape');
 await page.getByRole('combobox',{name:'Client type',exact:true}).click();await page.getByRole('option',{name:'Ethernet',exact:true}).click();assert.equal(await page.getByLabel('SSID',{exact:true}).count(),0);
 await page.getByRole('combobox',{name:'Client type',exact:true}).click();await page.getByRole('option',{name:'Access point',exact:true}).click();assert.equal(await page.getByLabel('SSID',{exact:true}).inputValue(),'fgate test');
 fail=true;await page.getByLabel('SSID',{exact:true}).fill('unsaved draft');await page.getByRole('button',{name:'Save and apply',exact:true}).click();await page.getByText('Test helper unavailable',{exact:true}).waitFor();assert.equal(await page.getByLabel('SSID',{exact:true}).inputValue(),'unsaved draft');assert.equal(await page.getByTestId('network-summary').count(),0);
 for(const width of [320,390,1440]){
  await page.setViewportSize({width,height:1000});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.waitForTimeout(80);
  assert.equal(await page.getByTestId('network-summary').count(),0);
  const form=await page.locator('.network-settings').boundingBox(),layout=await page.locator('.network-layout').boundingBox();
  assert.ok(Math.abs(form.width-layout.width)<1,'network form uses full available width');
 }

 const inputBounds=await password.boundingBox(),wrapperBounds=await page.locator('.password-input').boundingBox();assert.equal(wrapperBounds.height,inputBounds.height,'password has no inline baseline gap');assert.equal(await page.locator('.password-toggle').evaluate(el=>getComputedStyle(el).backgroundColor),'rgba(0, 0, 0, 0)');
 await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:'/tmp/fg-network-desktop.png',fullPage:true});await page.setViewportSize({width:390,height:844});await page.screenshot({path:'/tmp/fg-network-mobile.png',fullPage:true});
 const session=await(await page.request.get(base+'/api/auth/session')).json();
 await page.route('**/api/auth/session',route=>route.fulfill({json:{...session,user:{...session.user,role:'viewer'},permissions:[]}}));
 await page.reload({waitUntil:'networkidle'});await page.getByLabel('SSID',{exact:true}).waitFor();
 assert.equal(await page.locator('.network-settings input:not(:disabled)').count(),0);assert.equal(await page.locator('.network-settings button:not(:disabled)').count(),0);
 assert.equal(trafficCalls,0,'network settings no longer poll traffic for a removed diagram');
 assert.deepEqual(errors,[]);console.log('Network legacy settings, save/apply, inventory, conditional fields, failed apply draft and responsive form passed.');
}finally{await browser?.close();child.kill();await new Promise(resolve=>child.once('exit',resolve));rmSync(folder,{recursive:true,force:true});}
