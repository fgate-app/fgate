import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {createServer} from '../server/index.js';
import {Store} from '../server/store.js';
const store=new Store(':memory:'),server=createServer(store);let browser;
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base='http://127.0.0.1:'+server.address().port;
try{
 const manifestResponse=await fetch(base+'/manifest.webmanifest');assert.match(manifestResponse.headers.get('content-type'),/application\/manifest\+json/);
 const manifest=await manifestResponse.json();assert.equal(manifest.display,'standalone');assert.equal(manifest.start_url,'/');
 for(const icon of manifest.icons){const response=await fetch(base+icon.src);assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'image/png');assert.deepEqual([...new Uint8Array(await response.arrayBuffer()).slice(0,8)],[137,80,78,71,13,10,26,10]);}
 const workerResponse=await fetch(base+'/sw.js');assert.match(workerResponse.headers.get('content-type'),/javascript/);assert.equal(workerResponse.headers.get('cache-control'),'no-cache');assert.ok(!(await workerResponse.text()).includes('__BUILD_ID__'));
 browser=await chromium.launch({channel:'chrome',headless:true});
 const context=await browser.newContext({viewport:{width:390,height:844}}),page=await context.newPage();
 await page.goto(base);await page.getByLabel('Username').fill('admin');await page.getByLabel('Password',{exact:true}).fill('test password 12345');await page.getByRole('button',{name:'Create administrator'}).click();await page.getByTestId('overview-dashboard').waitFor();
 await page.evaluate(()=>navigator.serviceWorker.ready);await page.waitForFunction(()=>!!navigator.serviceWorker.controller);
 const cdp=await context.newCDPSession(page),appManifest=await cdp.send('Page.getAppManifest');assert.deepEqual(appManifest.errors,[]);
 await page.evaluate(()=>{const event=new Event('beforeinstallprompt');event.prompt=async()=>{window.installRequested=true;};event.userChoice=Promise.resolve({outcome:'accepted'});window.dispatchEvent(event);});
 await page.getByTestId('mobile-profile').click();await page.getByTestId('install-app').click();assert.equal(await page.evaluate(()=>window.installRequested),true);
 await page.evaluate(()=>localStorage.setItem('fg.locale','ru'));
 await context.setOffline(true);await page.goto(base+'/settings/network');await page.getByRole('heading',{name:'Нет соединения с FreedomGate',exact:true}).waitFor();
 await page.waitForFunction(()=>document.querySelector('img').naturalWidth===192);
 assert.equal(await page.evaluate(()=>fetch('/api/network').then(()=>false,()=>true)),true,'API is not served from cache');
 const cached=await page.evaluate(async()=>{const urls=[];for(const name of await caches.keys())for(const request of await (await caches.open(name)).keys())urls.push(new URL(request.url).pathname);return urls;});
 assert.ok(cached.includes('/offline.html'));assert.ok(cached.every(path=>path==='/offline.html' || path==='/typography.css' || path==='/colors.css' || path.startsWith('/icons/')),'only public offline assets are cached');
 await page.screenshot({path:'/tmp/fg-pwa-offline.png'});
 await context.setOffline(false);await page.goto(base);await page.getByTestId('overview-dashboard').waitFor();
 console.log('PWA manifest, PNG icons, service worker, installation action, localized offline screen, uncached API and reconnect passed.');
}finally{
 await browser?.close();await new Promise(resolve=>server.close(resolve));await server.cleanup;store.close();
}
