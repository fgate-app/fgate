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
  import {updateDomainLists} from './server/domain-lists.js';
  const store=new Store(process.env.FREEDOMGATE_DB);
  let rules=['||metrika.yandex.ru^'];
  const filter={status:()=>({state:'running',filtering:true}),userRules:async()=>rules,reconcileUserRules:async(previous,desired)=>{
    rules=[...new Set([...rules.filter(rule=>!previous.includes(rule)),...desired])];return rules;
  }};
  const app=createServer(store,{filter,domainListUpdate:()=>updateDomainLists({sources:{youtube:'youtube.com'}})});
  app.listen(0,'127.0.0.1',()=>console.log('FreedomGate: http://127.0.0.1:'+app.address().port));
`], {
  env: { ...process.env, FREEDOMGATE_DB: database,FREEDOMGATE_STATE_DIR:folder, PORT: '0', HOST: '127.0.0.1' },
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
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, serviceWorkers:'block' });
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
  let routeVolume={upload:1024,download:2048};
  await page.route('**/api/routes/traffic',async route=>{const data=await (await page.request.get(base+'/api/routes')).json();await route.fulfill({json:{available:true,groups:Object.fromEntries(data.groups.map(group=>[group.id,routeVolume])),devices:Object.fromEntries(data.devices.map(device=>[device.id,{upload:512,download:4096}]))}});});
  await page.getByRole('button', { name: 'Rules', exact: true }).click();
  await page.getByRole('tab', { name: 'Domains and IPs', exact: true }).waitFor();

  const importedBlock=page.getByTestId('route-group-row').filter({hasText:'metrika.yandex.ru'});
  await importedBlock.waitFor();
  assert.equal(await importedBlock.getByTestId('route-label').textContent(),'Block');
  assert.equal(await importedBlock.getByTestId('group-zapret-strategy').count(),0);
  await importedBlock.locator('.name-cell').click();
  assert.equal(await page.getByRole('dialog').getByLabel('Group name').inputValue(),'metrika.yandex.ru');
  assert.equal(await page.getByRole('dialog').getByLabel('zapret strategy').count(),0,'block routes hide implementation settings');
  await page.getByRole('dialog').getByRole('button',{name:'Cancel',exact:true}).click();
  await page.screenshot({path:join(tmpdir(),'freedomgate-unified-block-route.png')});
  await page.getByTestId('add-route-group').click();
  const groupDialog = page.getByRole('dialog');
  // A drag that begins or ends in the panel must not dismiss it.
  const panel = await groupDialog.boundingBox();
  const inside = { x: panel.x + panel.width / 2, y: panel.y + 30 };
  const outside = { x: 8, y: 8 };
  for (const [start, end] of [[inside, outside], [outside, inside]]) {
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(end.x, end.y);
    await page.mouse.up();
    assert.equal(await groupDialog.isVisible(), true, 'crossing the modal boundary keeps it open');
  }
  await page.mouse.click(outside.x, outside.y, {button:'right'});
  assert.equal(await groupDialog.isVisible(), true, 'right click does not dismiss the dialog');
  await page.keyboard.press('Escape');
  await groupDialog.waitFor({state:'hidden'});
  await page.getByTestId('add-route-group').click();
  await page.mouse.click(outside.x, outside.y);
  await groupDialog.waitFor({state:'hidden'});
  await page.getByTestId('add-route-group').click();
  await groupDialog.getByLabel('Group name').fill('youtube');
  for(const value of ['youtube.com','youtu.be','142.250.0.0/16']){const entry=groupDialog.getByTestId('route-entry-tags').locator('input.tag-input');await entry.fill(value);await entry.press('Enter');}
  await groupDialog.getByLabel('Route',{exact:true}).click();
  await page.getByRole('option',{name:'DPI bypass',exact:true}).click();
  const strategySelect=groupDialog.getByLabel('zapret strategy',{exact:true});
  assert.equal(await strategySelect.inputValue(),'Inherit global');
  await strategySelect.click();
  await page.getByRole('option',{name:'Packet interception v2',exact:true}).click();
  const rejectSave = route => route.fulfill({status:400,contentType:'application/json',body:JSON.stringify({error:'Fixture: could not save group'})});
  await page.route('**/api/routes/groups', rejectSave);
  const failedSave = page.waitForResponse(response => response.url().endsWith('/api/routes/groups') && response.status() === 400);
  await groupDialog.getByTestId('dialog-save-group').click();
  await failedSave;
  await page.waitForFunction(() => !document.querySelector('[data-testid="dialog-save-group"]')?.disabled);
  await page.getByRole('alert').filter({hasText:'Fixture: could not save group'}).waitFor();
  assert.equal(await groupDialog.isVisible(), true, 'server errors keep the dialog open');
  assert.equal(await groupDialog.getByLabel('Group name').inputValue(), 'youtube', 'failed saves preserve input');
  await page.locator('.toast').filter({hasText:'Fixture: could not save group'}).evaluate(async element=>{
    await Promise.all(element.getAnimations().map(animation=>animation.finished));
  });
  assert.equal(await page.locator('.toast-stack').evaluate(element=>element.matches(':popover-open')),true,'error notification is in the top layer');
  assert.equal(await page.locator('.toast').filter({hasText:'Fixture: could not save group'}).evaluate(element=>{
    const rect=element.getBoundingClientRect();
    return Boolean(document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2)?.closest('.toast'));
  }),true,'notification is not covered by the modal backdrop');
  await page.screenshot({path:join(tmpdir(),'freedomgate-local-review-dialog.png')});
  await page.unroute('**/api/routes/groups', rejectSave);
  await groupDialog.getByTestId('dialog-save-group').click();
  await groupDialog.waitFor({ state: 'hidden' });
  const groupRows = page.locator('[data-testid="route-group-row"]').filter({hasText:'youtube'});
  await groupRows.first().waitFor();
  assert.match(await groupRows.first().textContent(), /youtube/);
  assert.equal((await (await page.request.get(base+'/api/routes')).json()).groups.find(group=>group.name==='youtube').entries.length,3);
  assert.equal(await groupRows.first().getByTestId('route-label').textContent(), 'DPI bypass', 'group uses the selected connection');
  assert.match(await groupRows.first().getByTestId('group-zapret-strategy').textContent(),/Packet interception v2/);
  await page.waitForFunction(()=>[...document.querySelectorAll('[data-testid="route-group-row"]')].find(row=>row.textContent.includes('youtube'))?.querySelector('[data-testid="route-traffic"]')?.textContent.includes('2.0 KB'));
  assert.equal(await groupRows.first().getByTestId('route-traffic').textContent(),'↓ 2.0 KB · ↑ 1.0 KB');
  const routeColumns=()=>page.getByTestId('route-group-list').locator('thead th').evaluateAll(nodes=>nodes.map(node=>({x:node.getBoundingClientRect().x,width:node.getBoundingClientRect().width})));
  const routeWidths=await routeColumns();routeVolume={upload:999.9*1024**4,download:999.9*1024**4};
  await page.waitForFunction(()=>document.querySelector('[data-testid="route-traffic"]')?.textContent.includes('999.9 TB'));
  assert.deepEqual(await routeColumns(),routeWidths,'route traffic updates cannot resize columns');

  const strategyCell=groupRows.first().getByTestId('group-zapret-strategy').locator('..');
  assert.match(await strategyCell.textContent(),/DPI bypass/);
  assert.notEqual(await strategyCell.getByTestId('route-label').evaluate(el=>getComputedStyle(el).color),await strategyCell.getByTestId('group-zapret-strategy').evaluate(el=>getComputedStyle(el).color));
  await page.screenshot({path:join(tmpdir(),'freedomgate-routes-traffic.png')});
  await groupRows.first().locator('.name-cell').click();
  assert.equal(await strategySelect.inputValue(),'Packet interception v2','saved preset reopens');
  await strategySelect.click();
  await page.getByRole('option',{name:'Inherit global',exact:true}).click();
  await groupDialog.getByTestId('dialog-save-group').click();
  await groupDialog.waitFor({state:'hidden'});
  await page.waitForFunction(()=>document.querySelector('[data-testid="group-zapret-strategy"]')?.textContent.includes('Standard'));

  await groupRows.first().getByTestId('route-label').click();
  await strategySelect.click();await page.getByRole('option',{name:'YouTube (TLS + QUIC)',exact:true}).click();
  await groupDialog.getByTestId('dialog-save-group').click();await groupDialog.waitFor({state:'hidden'});
  await page.waitForFunction(()=>document.querySelector('[data-testid="group-zapret-strategy"]')?.textContent.includes('YouTube (TLS + QUIC)'));

  assert.equal(await page.getByTestId('route-group-list').locator('input:not([type=checkbox])').count(),0,'route table has no quick selects');
  assert.equal(await page.getByTestId('route-group-list').getByRole('columnheader',{name:'zapret strategy',exact:true}).count(),0);
  await groupRows.first().getByTestId('route-label').click();
  await groupDialog.getByLabel('Route',{exact:true}).click();
  await page.getByRole('option',{name:'Block',exact:true}).click();
  await groupDialog.getByTestId('dialog-save-group').click();
  await groupDialog.waitFor({state:'hidden'});
  assert.equal(await groupRows.first().getByTestId('route-label').textContent(),'Block','full form changes the route');

  await page.getByRole('tab', { name: 'Devices', exact: true }).click();
  await page.route('**/api/clients',route=>route.fulfill({json:{clients:[{hostname:'Living TV',ip:'192.168.1.70',mac:'aa:bb:cc:dd:ee:70'},{hostname:'Phone',ip:'192.168.1.71',mac:'aa:bb:cc:dd:ee:71'}]}}));
  await page.getByTestId('add-device-route').click();
  const deviceDialog = page.getByRole('dialog');
  const address=deviceDialog.getByRole('combobox',{name:'IP or MAC address',exact:true});
  await address.click();await page.getByRole('option',{name:/Living TV/}).waitFor();
  assert.equal(await page.locator('.select-popup:popover-open').count(),1,'suggestions use top layer');
  await address.fill('living');await address.press('Enter');
  assert.equal(await address.inputValue(),'192.168.1.70');
  assert.equal(await deviceDialog.getByLabel('Device name').inputValue(),'Living TV');
  await deviceDialog.getByLabel('Device name').fill('TV');
  await address.fill('ee:71');await page.getByRole('option',{name:/Phone/}).click();
  assert.equal(await address.inputValue(),'192.168.1.71');
  assert.equal(await deviceDialog.getByLabel('Device name').inputValue(),'TV','preserve user name');
  await address.fill('192.168.1.70');await page.getByRole('option',{name:/Living TV/}).waitFor();
  await page.screenshot({path:'/tmp/freedomgate-device-suggest.png'});
  await address.press('Escape');assert.equal(await deviceDialog.isVisible(),true);

  await deviceDialog.getByRole('combobox',{name:'IP or MAC address',exact:true}).fill('192.168.1.50');
  await deviceDialog.getByLabel('Route',{exact:true}).click();
  await page.getByRole('option',{name:'DPI bypass',exact:true}).click();
  await deviceDialog.getByTestId('dialog-save-device').click();
  await deviceDialog.waitFor({ state: 'hidden' });
  const deviceRows = page.locator('[data-testid="route-device-row"]');
  await deviceRows.first().waitFor();
  assert.match(await deviceRows.first().textContent(), /TV/);
  assert.match(await deviceRows.first().textContent(), /192\.168\.1\.50/);
  assert.equal(await deviceRows.first().getByTestId('route-label').textContent(), 'DPI bypass');

  await page.getByRole('tab', { name: 'Local routes', exact: true }).click();
  await page.getByTestId('add-local-route').click();
  const localDialog = page.getByRole('dialog');
  await localDialog.getByLabel('Alias').fill('router.home');
  await localDialog.getByLabel('Address').fill('192.168.1.1');
  await localDialog.getByTestId('dialog-save-local-route').click();
  await localDialog.waitFor({ state: 'hidden' });
  const localRows = page.locator('[data-testid="route-local-row"]');
  await localRows.first().waitFor();
  assert.match(await localRows.first().textContent(), /router\.home/);
  assert.match(await localRows.first().textContent(), /192\.168\.1\.1/);
  await page.waitForFunction(() => !document.querySelector('[data-testid="add-local-route"]')?.disabled);
  await page.getByTestId('add-local-route').click();
  await localDialog.getByLabel('Alias').fill('ytbe.lan');
  await localDialog.getByLabel('Address').fill('youtube.com');
  await localDialog.getByTestId('dialog-save-local-route').click();
  await localDialog.waitFor({ state: 'hidden' });
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="route-local-row"]').length === 2);
  assert.equal(await localRows.count(), 2);
  await localRows.first().locator('.row-menu-trigger').click();
  await page.getByRole('menuitem', { name: 'Remove' }).click();
  await page.getByTestId('confirm-delete').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="route-local-row"]').length === 1);

  await page.getByRole('tab', { name: 'Domains and IPs', exact: true }).click();
  await groupRows.first().locator('.row-menu-trigger').click();
  await page.getByRole('menuitem', { name: 'Remove' }).click();
  await page.getByTestId('confirm-delete').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="route-group-row"]').length === 1);
  assert.equal(await importedBlock.count(),1,'removing a different group retains the imported block');

  // Remounting extracted pages must restore data and URL-driven tabs.
  await page.getByRole('button', { name: 'Overview', exact: true }).click();
  await page.getByRole('button', { name: 'Rules', exact: true }).click();
  await page.getByRole('tab', { name: 'Devices', exact: true }).click();
  await deviceRows.first().waitFor();
  assert.match(page.url(), /\/routes\/devices$/);
  await page.reload({waitUntil:'networkidle'});
  await page.getByRole('tab', {name:'Devices',exact:true}).waitFor();
  assert.equal(await page.getByRole('tab', {name:'Devices',exact:true}).getAttribute('aria-selected'),'true');
  await deviceRows.first().waitFor();

  const setup = {
    uplink:{interface:'eth0'},
    client:{interface:'wlan0',type:'ap',ssid:'FreedomGate',password:'testpass123',subnet:'10.20.0.1/24'},
    dhcp:{start:'10.20.0.100',end:'10.20.0.200'},
  };
  let networkSaves=0;
  await page.route('**/api/network',async route=>{
    if(route.request().method()==='PUT') { Object.assign(setup,route.request().postDataJSON());networkSaves++; }
    await route.fulfill({json:{setup,interfaces:[
      {name:'eth0',type:'ethernet',state:'up',carrier:true},
      {name:'wlan0',type:'wifi',state:'up',carrier:true},
    ],plan:[],warnings:[]}});
  });
  await page.getByRole('button',{name:'Settings',exact:true}).click();
  await page.getByRole('tab',{name:'Network',exact:true}).click();
  await page.getByLabel('Uplink', {exact:true}).waitFor();
  assert.equal(await page.locator('#settings-content').getAttribute('aria-labelledby'),'settings-tabs-tab-'+encodeURIComponent('Сеть'));
  await page.route('**/api/network/apply',async route=>{Object.assign(setup,route.request().postDataJSON());networkSaves++;await route.fulfill({json:{setup,plan:[],warnings:[]}});});
  await page.getByRole('button',{name:'Save and apply',exact:true}).click();
  await page.waitForFunction(()=>!document.querySelector('.dns-actions button')?.disabled);
  assert.equal(networkSaves,1);

  let clientReads=0, pinned=false;
  await page.route('**/api/clients',route=>{
    clientReads++;
    return route.fulfill({json:{clients:[{mac:'aa:bb:cc:dd:ee:ff',ip:'10.20.0.120',hostname:'Test phone',expiresAt:Date.now()+600000,staticIp:pinned?'10.20.0.150':null}]}});
  });
  await page.route('**/api/clients/static',route=>{
    assert.equal(route.request().postDataJSON().ip,'10.20.0.150');
    pinned=true;
    return route.fulfill({json:{ok:true}});
  });
  await page.clock.install();
  await page.getByRole('button',{name:'Clients',exact:true}).click();
  const client=page.getByTestId('client-row');
  await client.waitFor();
  await client.getByRole('button',{name:'Actions',exact:true}).click();
  await page.getByRole('menuitem',{name:'Pin address',exact:true}).click();
  const pin=page.getByRole('dialog');
  await pin.getByLabel('IP address',{exact:true}).fill('10.20.0.150');
  await pin.getByTestId('dialog-save-static').click();
  await pin.waitFor({state:'hidden'});
  await page.waitForFunction(()=>document.querySelector('[data-testid="client-row"]')?.textContent.includes('10.20.0.150'));
  await page.screenshot({path:join(tmpdir(),'freedomgate-refactor-clients.png')});
  await page.getByRole('button',{name:'Overview',exact:true}).click();
  const readsAfterLeaving=clientReads;
  // Advance browser timers past the poll interval without a real-time sleep.
  await page.clock.fastForward(6000);
  assert.equal(clientReads,readsAfterLeaving,'client polling stops after navigating away');

  assert.deepEqual(errors, []);
  console.log('Routes: domain/IP groups, device routes and local aliases passed.');
} finally {
  await browser.close();
  server.kill('SIGTERM');
  await new Promise(resolve => setTimeout(resolve, 300));
  rmSync(folder, { recursive: true, force: true });
}
