import {chromium} from '@playwright/test';import {spawn} from 'node:child_process';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import assert from 'node:assert/strict';
const folder=mkdtempSync(join(tmpdir(),'fg-dashboard-'));const child=spawn(process.execPath,['server/index.js'],{env:{...process.env,PORT:'18879',FREEDOMGATE_DB:join(folder,'db.sqlite')},stdio:['ignore','pipe','pipe']});let browser;
try{
 await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('exit',()=>reject(Error('Server failed')));});
 browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));let reads=0;
 await page.route('**/api/dashboard',async route=>{reads++;await route.fulfill({json:{timestamp:new Date().toISOString(),cpu:{percent:20+reads},memory:{percent:40+reads},traffic:{available:true,uploadRate:1024*reads,downloadRate:1024*1024*reads,uploadTotal:1024**3,downloadTotal:3*1024**3,connections:7,topProxies:Array.from({length:5},(_,i)=>({id:String(i),name:i?'Proxy '+i:'Test proxy',upload:1024,download:2048*(5-i)}))},adguard:{available:true,interval:3600000,queries:120,blocked:20,samples:[{time:Date.now()-3600000,queries:80,blocked:15},{time:Date.now(),queries:40,blocked:5}]},counts:{gateways:4,devices:2,accessPoints:0}}});});
 await page.goto('http://127.0.0.1:18879/',{waitUntil:'networkidle'});await page.getByLabel('Username').fill('admin');await page.getByLabel('Password',{exact:true}).fill('test password 12345');await page.getByRole('button',{name:'Create administrator'}).click();
 await page.getByTestId('overview-dashboard').waitFor();await page.getByTestId('top-proxy').getByText('Test proxy',{exact:true}).waitFor();assert.equal(await page.locator('aside nav').getByRole('button',{name:'System dashboard',exact:true}).count(),0);
 assert.equal(await page.locator('.overview-metrics').count(),0);assert.equal(await page.locator('.overview-dashboard > :first-child').evaluate(node=>node.classList.contains('architecture-card')),true);assert.equal(await page.locator('.overview-counts .stat-card').count(),3);assert.equal(await page.locator('.dashboard-chart svg').count(),4);
 assert.equal(await page.locator('.overview-charts .data-card-title>.app-icon').count(),5);assert.equal(new Set(await page.locator('.overview-chart-icon path').evaluateAll(nodes=>nodes.map(el=>el.getAttribute('d')))).size,5);
 async function alignedTitles(){
  const offsets=await page.locator('.overview-charts .data-card-title').evaluateAll(nodes=>nodes.map(el=>{const icon=el.querySelector('svg').getBoundingClientRect(),title=el.querySelector('h3').getBoundingClientRect();return Math.abs(icon.y+icon.height/2-title.y-title.height/2);}));
  assert.ok(offsets.every(offset=>offset<.5),'chart icons are vertically centered with their headings: '+offsets.join(', '));
 }
 await page.getByTestId('adguard-queries').getByRole('heading',{name:'DNS queries',exact:true}).waitFor();
 assert.match(await page.getByTestId('adguard-queries').innerText(),/120/);
 assert.match(await page.getByTestId('adguard-queries').innerText(),/20/);
 assert.doesNotMatch(await page.getByTestId('adguard-queries').innerText(),/B\/s/);
 assert.equal(await page.getByTestId('top-proxy').getByRole('meter').count(),5);
 await page.getByTestId('top-proxy').getByText('Test proxy',{exact:true}).waitFor();
 await alignedTitles();
 await page.clock.install();const next=page.waitForResponse(r=>r.url().endsWith('/api/dashboard')&&r.status()===200);await page.clock.fastForward(5100);await next;assert.equal(reads,2);
 for(const index of [1,2])assert.ok(!(await page.locator('.dashboard-chart').nth(index).locator('text').allTextContents()).includes('100%'),'CPU and memory use the observed range');
 assert.equal(await page.locator('.dashboard-line').count(),6);assert.ok((await page.locator('.dashboard-line').first().getAttribute('d'))?.includes('L'),'D3 draws multiple real sample points');
 await page.screenshot({path:'/tmp/freedomgate-dashboard-desktop.png',fullPage:true});
 await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await alignedTitles();await page.screenshot({path:'/tmp/freedomgate-dashboard-mobile.png',fullPage:true});
 await page.setViewportSize({width:1440,height:1000});await page.locator('aside nav').getByRole('button',{name:'Gateways',exact:true}).click();const stopped=reads;await page.clock.fastForward(600000);assert.equal(reads,stopped,'dashboard polling stops when hidden');
 const resumed=page.waitForResponse(r=>r.url().endsWith('/api/dashboard')&&r.status()===200);await page.locator('aside nav').getByRole('button',{name:'Overview',exact:true}).click();await resumed;assert.equal(reads,3);
 assert.ok(await page.locator('.dashboard-line').evaluateAll(paths=>paths.every(path=>path.getBBox().x>=0)),'returning after a long pause drops samples outside the chart window');
 await page.goto('http://127.0.0.1:18879/system',{waitUntil:'networkidle'});await page.getByTestId('overview-dashboard').waitFor();assert.equal(new URL(page.url()).pathname,'/overview');
 assert.deepEqual(errors,[]);console.log('Dashboard: map first, four charts and top proxy, counts, live samples, mobile, polling cleanup and legacy system redirect passed.');
}finally{await browser?.close();child.kill();await new Promise(r=>child.once('exit',r));rmSync(folder,{recursive:true,force:true});}
