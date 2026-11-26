import {deflateSync} from 'node:zlib';
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const folder = mkdtempSync(join(tmpdir(), 'fg-routes-browser-'));
const database = join(folder, 'test.sqlite');
const server = spawn(process.execPath, ['--input-type=module','-e', `
  import {Store} from './server/store.js';
  import {createServer} from './server/index.js';
  const store=new Store(process.env.FREEDOMGATE_DB);
  let rules=['||metrika.yandex.ru^'];
  const filter={status:()=>({state:'running',filtering:true}),userRules:async()=>rules,reconcileUserRules:async(previous,desired)=>{
    rules=[...new Set([...rules.filter(rule=>!previous.includes(rule)),...desired])];return rules;
  }};
  const app=createServer(store,{filter,resourceFetch:async()=>new Response('',{status:503})});
  app.listen(0,'127.0.0.1',()=>console.log('FreedomGate: http://127.0.0.1:'+app.address().port));
`], {
  env: { ...process.env, FREEDOMGATE_DB: database, PORT: '0', HOST: '127.0.0.1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const base = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Server did not start')), 10000);
  server.stdout.on('data', chunk => {
    const match = /http:\/\/127\.0\.0\.1:(\d+)/.exec(String(chunk));
    if (match) { clearTimeout(timer); resolve('http://127.0.0.1:' + match[1]); }
  });
});
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if(message.type()==='warning' && message.text().includes('[Vue warn]')) errors.push(message.text()); });
  await page.goto(base + '/', { waitUntil: 'networkidle' });
  await page.getByLabel('Username').fill('admin');
  await page.getByLabel('Password',{exact:true}).fill('test password 12345');
  if (await page.getByRole('button', { name: 'Create administrator' }).count()) {
    await page.getByRole('button', { name: 'Create administrator' }).click();
  } else {
    await page.getByRole('button', { name: 'Sign in' }).click();
  }

  let telemetry={available:true,profiles:{},groups:{}};
  await page.route('**/api/profiles/telemetry',route=>route.fulfill({json:telemetry}));
  await page.locator('aside nav').getByRole('button',{name:'Gateways',exact:true}).click();
  await page.goto(base+'/connections',{waitUntil:'networkidle'});
  await page.getByRole('tab',{name:'Gateways',exact:true}).waitFor();
  assert.equal(await page.getByTestId('connection-ping').count(),(await (await page.request.get(base+'/api/profiles')).json()).length);
  assert.equal(await page.getByTestId('connection-traffic').first().locator('.table-placeholder').count(),1);
  const columns=()=>page.getByTestId('exit-list').locator('thead th').evaluateAll(nodes=>nodes.map(node=>({x:node.getBoundingClientRect().x,width:node.getBoundingClientRect().width})));
  const beforeColumns=await columns();
  const savedProfiles=await (await page.request.get(base+'/api/profiles')).json();
  telemetry={available:true,profiles:Object.fromEntries(savedProfiles.map(profile=>[profile.id,{available:true,download:999.9*1024**3,upload:999.9*1024**3,ping:12345}])),groups:{}};
  await page.waitForFunction(()=>document.querySelector('[data-testid="connection-traffic"]')?.textContent.includes('999.9 GB/s'));
  assert.deepEqual(await columns(),beforeColumns,'traffic becoming available must not move table columns');
  await page.screenshot({path:'/tmp/freedomgate-stable-traffic.png'});
  telemetry={...telemetry,profiles:Object.fromEntries(savedProfiles.map(profile=>[profile.id,{available:true,download:1,upload:1,ping:1}]))};
  await page.waitForFunction(()=>document.querySelector('[data-testid="connection-traffic"]')?.textContent.includes('1 B/s'));
  assert.deepEqual(await columns(),beforeColumns,'changing traffic units and digit counts must not move columns');
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'wide metric columns scroll inside the table on mobile');
  await page.setViewportSize({width:1280,height:900});

  // Import a synthetic Amnezia link through the actual modal/API; no real credentials.
  const raw=Buffer.from(JSON.stringify({defaultContainer:'amnezia-xray',containers:[{container:'amnezia-xray',xray:{last_config:JSON.stringify({outbounds:[{protocol:'vless',settings:{vnext:[{address:'192.0.2.3',port:443,users:[{id:'c761077e-69c6-4f67-a18f-f94cc4b22426',encryption:'none'}]}]},streamSettings:{network:'tcp',security:'none'}}]})}}]}));
  const prefix=Buffer.alloc(4);prefix.writeUInt32BE(raw.length);
  await page.getByTestId('add-exit').click();await page.getByRole('menuitem',{name:/^(Add config|Добавить конфиг|添加配置)$/}).click();
  const importDialog=page.getByRole('dialog');
  await importDialog.getByLabel('Name',{exact:true}).fill('Amnezia fixture');
  await importDialog.getByLabel('Link or configuration').fill('vpn://'+Buffer.concat([prefix,deflateSync(raw)]).toString('base64url'));
  assert.match(await importDialog.getByTestId('exit-detected').textContent(),/Amnezia/);
  await importDialog.getByTestId('dialog-add-exit').click();await importDialog.waitFor({state:'hidden'});
  await page.getByTestId('exit-row').filter({hasText:'Amnezia fixture'}).waitFor();
  const imported=page.getByTestId('exit-row').filter({hasText:'Amnezia fixture'});
  await imported.locator('.name-cell').click();
  await importDialog.getByRole('heading',{name:'Edit connection'}).waitFor();
  await importDialog.getByRole('tab',{name:'Reload config',exact:true}).click();
  assert.equal(await importDialog.getByLabel('Link or configuration',{exact:true}).inputValue(),'','replacement starts empty');
  await importDialog.getByLabel('Name',{exact:true}).fill('Renamed fixture');
  await importDialog.getByRole('switch',{name:'Enabled',exact:true}).uncheck();
  await importDialog.getByTestId('dialog-add-exit').click();await importDialog.waitFor({state:'hidden'});
  const edited=page.getByTestId('exit-row').filter({hasText:'Renamed fixture'});
  await edited.getByRole('switch').waitFor();assert.equal(await edited.getByRole('switch').isChecked(),false);
  await edited.locator('label.app-switch').click();
  await page.waitForFunction(()=>document.querySelector('[data-testid="exit-row"]:has(.name-cell) input[aria-label="Enabled: Renamed fixture"]')?.checked);
  await page.getByRole('tab',{name:'Groups',exact:true}).click();
  assert.match(page.url(),/\/connections\/groups$/);
  await page.getByTestId('add-connection-group').click();
  const dialog=page.getByRole('dialog');
  await dialog.getByLabel('Group name').fill('Automatic');
  await dialog.getByRole('combobox',{name:'Add connection to group',exact:true}).click();
  await page.getByRole('option',{name:'DPI bypass',exact:true}).click();
  await dialog.getByRole('combobox',{name:'Add connection to group',exact:true}).click();
  await page.getByRole('option',{name:'Direct',exact:true}).click();
  await dialog.getByTestId('save-connection-group').click();
  await dialog.waitFor({state:'hidden'});
  const row=page.getByTestId('connection-group-row');
  await row.waitFor();assert.match(await row.textContent(),/Automatic/);assert.match(await row.textContent(),/DPI bypass, Direct/);
  await page.getByRole('tab',{name:'Gateways',exact:true}).click();
  const zapret=page.getByTestId('exit-row').filter({hasText:'DPI bypass'});
  await zapret.locator('label.app-switch').click();
  await page.waitForFunction(()=>document.querySelector('input[aria-label="Enabled: DPI bypass"]')?.checked===false);
  await page.getByRole('tab',{name:'Groups',exact:true}).click();
  assert.match(await row.textContent(),/DPI bypass, Direct/,'disabled member remains in its group');
  await page.reload({waitUntil:'networkidle'});
  assert.equal(await page.getByRole('tab',{name:'Groups',exact:true}).getAttribute('aria-selected'),'true');
  await row.locator('td').first().click();
  assert.equal(await dialog.getByLabel('Group name').inputValue(),'Automatic');
  await dialog.getByLabel('Group name').fill('Fast group');
  await dialog.locator('.app-tag').filter({hasText:'Direct'}).getByRole('button').click();
  await dialog.getByTestId('save-connection-group').click();await dialog.waitFor({state:'hidden'});
  await page.locator('aside nav').getByRole('button',{name:'Rules',exact:true}).click();
  const blocked=page.getByTestId('route-group-row').filter({hasText:'metrika.yandex.ru'});
  await blocked.getByTestId('route-label').click();
  await dialog.getByLabel('Route',{exact:true}).click();
  await page.getByRole('option',{name:'Fast group · Group',exact:true}).click();
  await dialog.getByTestId('dialog-save-group').click();await dialog.waitFor({state:'hidden'});
  assert.equal(await blocked.getByTestId('route-label').textContent(),'Fast group · Group');
  await blocked.getByTestId('route-label').click();
  await dialog.getByLabel('Route',{exact:true}).click();await page.getByRole('option',{name:'Block',exact:true}).click();
  await dialog.getByTestId('dialog-save-group').click();await dialog.waitFor({state:'hidden'});
  assert.equal(await blocked.getByTestId('route-label').textContent(),'Block');
  await page.locator('aside nav').getByRole('button',{name:'Gateways',exact:true}).click();
  await page.getByRole('tab',{name:'Groups',exact:true}).click();
  await page.setViewportSize({width:390,height:844});
  await row.waitFor();
  await page.screenshot({path:join(tmpdir(),'freedomgate-connection-groups-mobile.png'),fullPage:true});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'mobile page has no horizontal overflow');
  await row.locator('.row-menu-trigger').click();await page.getByRole('menuitem',{name:'Remove',exact:true}).click();
  await page.getByTestId('confirm-delete').waitFor();
  assert.equal(await row.count(),1,'delete requires confirmation');
  await page.getByTestId('confirm-delete').click();await row.waitFor({state:'hidden'});
  assert.deepEqual(errors,[]);
  console.log('Connection groups: tabs, URL restore, membership, route selection, confirmed deletion and mobile layout passed.');
} finally {
  await browser.close();server.kill('SIGTERM');
  await new Promise(resolve=>server.once('exit',resolve));rmSync(folder,{recursive:true,force:true});
}
