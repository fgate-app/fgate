import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { Store } from '../server/store.js';
import { createServer } from '../server/index.js';
import { defaultDnsSettings } from '../server/dns-resolvers.js';

const folder = mkdtempSync(join(tmpdir(), 'fg-dns-browser-'));

async function selectValue(target,testId,value){
 const control=target.getByTestId(testId);
 const interactive=await control.isVisible() && await control.evaluate(element=>!element.closest('[inert]'));
 if(!interactive && await target.getByTestId('user-menu').count()){
  if(await target.getByTestId('mobile-navigation-toggle').isVisible() && await target.getByTestId('mobile-navigation-toggle').getAttribute('aria-expanded')==='false')await target.locator('dialog.is-drawer[open]').waitFor({state:'hidden'});
  if(await target.getByTestId('mobile-navigation-toggle').isVisible() && !await target.locator('dialog.is-drawer[open]').isVisible())await target.getByTestId('mobile-navigation-toggle').click();
  await target.locator('[data-testid="user-menu"]:visible').click();
 }
 await target.getByTestId(testId).click();
 const label={en:'English',ru:'Русский',light:(await target.locator('html').getAttribute('lang'))==='ru'?'Светлая':'Light',dark:(await target.locator('html').getAttribute('lang'))==='ru'?'Тёмная':'Dark'}[value];
 await target.getByRole('option',{name:label,exact:true}).click();
}

const database = join(folder, 'test.sqlite');
// Simulate a database written by an older release (no proxyServerNameservers field).
const seed = new Store(database);
const { proxyServerNameservers, ...olderSettings } = defaultDnsSettings;
seed.db.prepare('INSERT INTO dns_settings VALUES (1,?)').run(JSON.stringify(olderSettings));
seed.close();
const server = spawn(process.execPath, ['server/index.js'], {
  env: { ...process.env, FREEDOMGATE_DB: database, PORT: '0', HOST: '127.0.0.1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const base = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Server did not start')), 10000);
  server.stdout.on('data', chunk => {
    const match = /http:\/\/127\.0\.0\.1:(\d+)/.exec(String(chunk));
    if (match) {
      clearTimeout(timer);
      resolve('http://127.0.0.1:' + match[1]);
    }
  });
});
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  async function navigate(name,target=page){
    if(await target.getByTestId('mobile-navigation-toggle').isVisible() && await target.getByTestId('mobile-navigation-toggle').getAttribute('aria-expanded')==='false')await target.locator('dialog.is-drawer[open]').waitFor({state:'hidden'});
    if(await target.locator('.user-popup').isVisible())await target.keyboard.press('Escape');
    if(await target.getByTestId('mobile-navigation-toggle').isVisible()){
      if(!await target.locator('dialog.is-drawer[open]').isVisible())await target.getByTestId('mobile-navigation-toggle').click();
      await target.locator('dialog.is-drawer nav').getByRole('button',{name,exact:true}).click();
    }else await target.locator('aside nav').getByRole('button',{name,exact:true}).click();
  }
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base + '/', { waitUntil: 'networkidle' });
  await page.getByLabel('Username').fill('admin');
  await page.getByLabel('Password',{exact:true}).fill('test password 12345');
  const setupResponse = page.waitForResponse(response => response.url().includes('/api/auth/setup') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Create administrator' }).click();
  await setupResponse;
  await page.getByRole('heading', { name: 'Overview' }).waitFor();

  await page.goto(base + '/settings/network', { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Uplink', exact: true }).waitFor();
  assert.equal(await page.getByRole('heading', { name: 'Device network topology' }).count(), 0);
  assert.equal(await page.getByRole('heading', { name: 'System policies' }).count(), 0);

  // Direct deep link must open the DNS settings page without clicks.
  await page.goto(base + '/settings/dns', { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: /Resolver pool/ }).waitFor();
  assert.equal(new URL(page.url()).pathname, '/settings/dns');
  await navigate('Gateways');
  await page.getByRole('heading', { name: 'Internet access methods' }).waitFor();
  assert.equal(await page.getByTestId('inbound-card').count(),0,'incoming connections have a separate page');
  assert.equal(await page.locator('aside nav').getByRole('button',{name:'Access points',exact:true,includeHidden:true}).count(),1);
  await navigate('Clients');
  assert.equal(await page.getByRole('tab',{name:'Access points',exact:true}).count(),0);
  await navigate('Access points');
  const inboundCard=page.getByTestId('inbound-card');await inboundCard.waitFor();await inboundCard.getByText('Cloud access',{exact:true}).waitFor();
  assert.equal(new URL(page.url()).pathname,'/access-points');
  assert.equal(await inboundCard.locator('.app-count').textContent(),'1');
  assert.match(await inboundCard.textContent(),/Cloud access/);
  await inboundCard.getByRole('button',{name:'Add access point',exact:true}).waitFor();
  await page.reload({waitUntil:'networkidle'});
  assert.equal(await page.locator('aside nav').getByRole('button',{name:'Access points',exact:true,includeHidden:true}).getAttribute('aria-current'),'page');
  await navigate('Clients');
  assert.equal(new URL(page.url()).pathname,'/clients');
  await page.goBack();await page.getByTestId('inbound-card').waitFor();
  await page.goto(base+'/incoming',{waitUntil:'networkidle'});
  assert.equal(new URL(page.url()).pathname,'/access-points','legacy incoming URL resolves to the standalone page');
  await navigate('Gateways');
  const firstExitRow = page.locator('[data-testid="exit-row"]').first();
  await firstExitRow.hover();
  await page.waitForTimeout(200);
  assert.equal(await firstExitRow.evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(28, 33, 40)', 'table row hover matches navigation hover');
  const addExitButton = page.getByTestId('add-exit');
  assert.match(await addExitButton.getAttribute('class'), /button-secondary/);
  assert.match(await addExitButton.getAttribute('class'), /button-icon/);
  assert.match(await addExitButton.getAttribute('class'), /control-m/);
  assert.equal((await addExitButton.textContent()).trim(), '', 'add exit is an icon-only button');
  assert.equal(await addExitButton.locator('.app-icon').count(), 1);
  const exitRows = page.locator('[data-testid="exit-row"]');
  assert.equal(await exitRows.count(), 4);
  assert.match(await exitRows.filter({ hasText: 'DPI bypass' }).textContent(), /DPI bypass/);
  assert.match(await exitRows.filter({ hasText: 'Direct' }).textContent(), /direct exit/i);
  assert.equal(await exitRows.filter({ hasText: 'DPI bypass' }).locator('button').count(), 1, 'zapret has settings but no delete');
  assert.equal(await exitRows.filter({ hasText: 'Direct' }).locator('button').count(), 1, 'built-in Direct only offers route navigation');
  const gatewaysUrl=page.url();
  await exitRows.filter({hasText:'Direct'}).locator('.name-cell').click();
  assert.equal(page.url(),gatewaysUrl,'direct row does not navigate to rules');
  assert.equal(await page.getByRole('dialog').count(),0,'direct row has no edit action');
  await exitRows.filter({hasText:'DPI bypass'}).locator('.name-cell').click();
  await page.getByRole('dialog',{name:'Configure',exact:true}).waitFor();
  await page.getByRole('dialog').getByRole('button',{name:'Cancel',exact:true}).click();
  await page.getByTestId('add-exit').click();await page.getByRole('menuitem',{name:/^(Add config|Добавить конфиг|添加配置)$/}).click();
  const exitDialog = page.getByRole('dialog');
  assert.equal(await exitDialog.getByPlaceholder('Optional').evaluate(el => getComputedStyle(el).fontSize), '13px', 'input text is 13px');
  await exitDialog.getByPlaceholder('Optional').fill('Outline test');
  await exitDialog.locator('textarea').fill('not-a-config');
  await exitDialog.getByTestId('dialog-add-exit').click();
  assert.ok((await exitDialog.getByText('Unknown format').count()) >= 1, 'invalid config is rejected in the dialog');
  await exitDialog.locator('textarea').fill('ss://YWVzLTI1Ni1nY206cGFzc0BleGFtcGxlLmNvbTo4Mzg4#test');
  assert.match(await exitDialog.getByTestId('exit-detected').textContent(), /Outline/);
  await exitDialog.getByTestId('dialog-add-exit').click();
  await exitDialog.waitFor({ state: 'hidden' });
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="exit-row"]').length === 5);
  assert.equal(await exitRows.filter({hasText:'Outline test'}).getByTestId('connection-type').innerText(),'Outline/Shadowsocks');
  await page.screenshot({path:'/tmp/fg-outline-label.png',fullPage:true});
  await exitRows.filter({hasText:'Outline test'}).locator('.name-cell').click();
  const ssEditor=page.getByRole('dialog',{name:'Edit connection',exact:true});
  await ssEditor.waitFor();
  const dpiSwitch=ssEditor.getByRole('switch',{name:'DPI bypass',exact:true});
  await dpiSwitch.waitFor();assert.equal(await dpiSwitch.isChecked(),false);
  await dpiSwitch.check();
  await page.screenshot({path:'/tmp/freedomgate-ss-dpi-switch.png'});
  await ssEditor.getByRole('button',{name:'Save',exact:true}).click();await ssEditor.waitFor({state:'hidden'});
  await exitRows.filter({hasText:'Outline test'}).locator('.name-cell').click();
  await dpiSwitch.waitFor();assert.equal(await dpiSwitch.isChecked(),true,'SS DPI setting persists after reopening');
  await dpiSwitch.uncheck();
  await ssEditor.getByRole('button',{name:'Cancel',exact:true}).click();
  await exitRows.filter({hasText:'Outline test'}).locator('.name-cell').click();
  await dpiSwitch.waitFor();assert.equal(await dpiSwitch.isChecked(),true,'cancel discards switch changes');
  await ssEditor.getByRole('button',{name:'Cancel',exact:true}).click();
  await exitRows.filter({ hasText: 'Outline test' }).locator('.row-menu-trigger').click();
  const rowMenu = page.locator('.row-menu');
  await rowMenu.waitFor();
  assert.match(await rowMenu.getAttribute('class'), /select-popup/);
  assert.equal(await rowMenu.locator('li[role="menuitem"]').count(), 5);
  await rowMenu.getByRole('menuitem',{name:'Gateway diagnostics',exact:true}).waitFor();
  assert.equal(await rowMenu.getByRole('menuitem',{name:'Check connection',exact:true}).count(),0);
  assert.equal((await rowMenu.getByRole('menuitem').last().textContent()).trim(),'Remove','delete is always the final action');
  assert.equal(await rowMenu.locator('li[role="menuitem"]').first().evaluate(el => getComputedStyle(el).minHeight), '44px');
  await page.getByRole('menuitem', { name: 'Remove' }).click();
  const confirmDelete = page.getByTestId('confirm-delete');
  await confirmDelete.waitFor();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
  assert.equal(await exitRows.count(), 5, 'cancel keeps the row');
  await exitRows.filter({ hasText: 'Outline test' }).locator('.row-menu-trigger').click();
  await page.getByRole('menuitem', { name: 'Remove' }).click();
  await confirmDelete.waitFor();
  await confirmDelete.click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="exit-row"]').length === 4);

  // Settings remain available from the connection menu.
  await exitRows.filter({ hasText: 'DPI bypass' }).locator('.row-menu-trigger').click();
  await page.getByRole('menuitem',{name:'Configure',exact:true}).click();
  assert.equal(await page.getByRole('menuitem',{name:'Edit',exact:true}).count(),0);
  const zapretDialog = page.getByRole('dialog',{name:'Configure',exact:true});
  await zapretDialog.waitFor();
  assert.equal(await zapretDialog.getByLabel('Name',{exact:true}).inputValue(),'Обход DPI');
  assert.equal(await zapretDialog.getByRole('switch',{name:'Enabled',exact:true}).count(),1);
  const modeSelect = zapretDialog.getByRole('combobox',{name:'Operation mode',exact:true});
  assert.equal(await modeSelect.count(), 1);
  assert.equal(await zapretDialog.getByRole('combobox',{name:'Bypass method',exact:true}).count(), 1);
  assert.equal(await zapretDialog.getByLabel('Test domain').count(), 1);
  const detectButton = zapretDialog.getByTestId('zapret-detect');
  assert.equal(await detectButton.count(), 1);
  assert.match(await detectButton.getAttribute('class'), /button-secondary/);
  assert.equal(await detectButton.locator('.app-icon').count(), 1, 'detect button has an icon');
  assert.equal(await zapretDialog.getByLabel('TCP ports').count(), 0, 'advanced settings are hidden by default');

  const advancedToggle = zapretDialog.getByRole('button', { name: 'Advanced settings' });
  assert.equal(await advancedToggle.getAttribute('aria-expanded'), 'false');
  await advancedToggle.click();
  assert.equal(await advancedToggle.getAttribute('aria-expanded'), 'true');
  await zapretDialog.getByLabel('TCP ports').waitFor();

  await modeSelect.click();
  await page.getByRole('option', { name: 'Transparent proxy', exact: true }).click();
  await page.waitForTimeout(200);
  assert.ok(await modeSelect.inputValue());

  const strategySelect = zapretDialog.getByRole('combobox',{name:'Bypass method',exact:true});
  await strategySelect.click();
  await page.getByRole('option', { name: 'Checksum spoofing', exact: true }).click();

  const quicSwitch = zapretDialog.getByLabel('QUIC (443 UDP)');
  await quicSwitch.click();
  const hostlistSwitch = zapretDialog.getByLabel('Use hostlist');
  await hostlistSwitch.click();
  await zapretDialog.getByPlaceholder('https://...').fill('https://example.com/hosts.txt');

  const detectPromise = page.waitForResponse(response => response.url().includes('/api/zapret/autotune') && response.request().method() === 'POST');
  await zapretDialog.getByTestId('zapret-detect').click();
  const detectResponse = await detectPromise;
  assert.equal(detectResponse.status(), 503, 'no zapret probe is available locally');
  const toast = page.locator('.toast').first();
  await toast.waitFor();
  const toastColors = await toast.evaluate(el => ({ bg: getComputedStyle(el).backgroundColor, fg: getComputedStyle(el).color }));
  assert.deepEqual(toastColors, { bg: 'rgb(203, 209, 217)', fg: 'rgb(7, 26, 49)' }, 'toast contrasts with the dark theme');
  await toast.locator('.toast-close').click();
  await toast.waitFor({ state: 'detached' });

  const respPromise = page.waitForResponse(response => response.url().includes('/api/zapret') && response.request().method() === 'PUT');
  await zapretDialog.getByRole('button', { name: 'Save' }).click();
  const resp = await respPromise;
  assert.equal(resp.status(), 502, 'missing helper must not be reported as applied');
  assert.equal(await zapretDialog.isVisible(),true,'failed apply keeps settings open');
  await zapretDialog.getByRole('button',{name:'Cancel',exact:true}).click();
  await zapretDialog.waitFor({ state: 'hidden' });
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="exit-row"]')].some(row => row.textContent.includes('Checksum spoofing')));

  // Settings → DNS: the network heading may be hidden if another tab is active.
  await navigate('Settings');
  await page.getByRole('tab', { name: 'DNS', exact: true }).click();
  await page.getByRole('heading', { name: /Resolver pool/ }).waitFor();
  await page.getByRole('tab', { name: 'DNS', exact: true }).click();
  await page.getByRole('heading', { name: /Resolver pool/ }).waitFor();
  assert.equal(await page.getByRole('heading', { name: 'DNS chain' }).count(), 0, 'DNS chain card removed');
  await page.getByRole('heading', { name: 'mihomo options' }).waitFor();
  const ipv6Switch = page.getByRole('switch', { name: 'IPv6' });
  assert.equal(await ipv6Switch.count(), 1, 'switches must render');
  await ipv6Switch.click();
  const ipv6Knob = page.locator('.app-switch').filter({ hasText: 'IPv6' }).locator('.switch-track > span');
  await page.waitForTimeout(250);
  assert.equal(await ipv6Knob.evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(7, 26, 49)', 'checked knob is dark in the dark theme');
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
  await page.waitForTimeout(250);
  assert.equal(await ipv6Knob.evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(255, 255, 255)', 'checked knob is white in the light theme');
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  assert.equal(new URL(page.url()).pathname, '/settings/dns');

  const addResolverButton = page.getByTestId('add-resolver');
  assert.match(await addResolverButton.getAttribute('class'), /button-secondary/);
  assert.equal((await addResolverButton.textContent()).trim(), '', 'add resolver is an icon-only button');
  assert.equal(await addResolverButton.locator('.app-icon').count(), 1);
  assert.match(await addResolverButton.getAttribute('class'), /control-m/);
  const fallbackAdd = page.getByRole('button', { name: 'Add fallback resolver' });
  assert.equal((await fallbackAdd.textContent()).trim(), '', 'fallback add button is icon-only');
  assert.equal(await fallbackAdd.locator('.app-icon').count(), 1);
  const saveDnsButton = page.getByTestId('save-dns');
  const saveColors = await saveDnsButton.evaluate(el => ({ bg: getComputedStyle(el).backgroundColor, fg: getComputedStyle(el).color }));
  assert.deepEqual(saveColors, { bg: 'rgb(0, 114, 255)', fg: 'rgb(255, 255, 255)' }, 'primary button stays #0072ff with white text');
  const poolCard = page.locator('.data-card').filter({has:page.getByTestId('resolver-pool')});
  assert.equal(await poolCard.locator('.app-count').textContent(), '2', 'count badge shows the number in a circle');
  const poolFirstCell = poolCard.locator('[data-testid="resolver-pool"] tbody td').first();
  assert.equal(await poolFirstCell.evaluate(el => getComputedStyle(el).fontSize), '13px', 'table values are 13px');
  assert.equal(await poolFirstCell.evaluate(el => getComputedStyle(el).fontWeight), '500', 'mobile card name uses medium weight');
  const poolAddressCell = poolCard.locator('[data-testid="resolver-pool"] tbody td').nth(1);
  assert.equal(await poolAddressCell.evaluate(el => getComputedStyle(el).fontSize), '13px');
  assert.equal(await poolAddressCell.locator('code').evaluate(el => getComputedStyle(el).color), 'rgb(146, 155, 167)', 'address is secondary, not blue');
  const cardStack = page.locator('.card-stack');
  assert.equal(await cardStack.evaluate(el => getComputedStyle(el).gap), '16px', 'uniform card gap');
  assert.equal(await cardStack.locator(':scope > *').evaluateAll(els => els.every(el => getComputedStyle(el).marginTop === '0px')), true, 'cards have no individual margins');
  assert.equal(await page.locator('.data-card').count(), 5, 'AdGuard, pool, fallback, bootstrap and proxy cards');
  const cardBodyPadding = await poolCard.locator('.data-card-body').evaluate(el => ({ top: getComputedStyle(el).paddingTop, left: getComputedStyle(el).paddingLeft, right: getComputedStyle(el).paddingRight, bottom: getComputedStyle(el).paddingBottom }));
  assert.deepEqual(cardBodyPadding, { top: '0px', left: '0px', right: '0px', bottom: '0px' }, 'mobile cards manage their own inset');
  assert.equal(await poolCard.locator('.data-card-head').evaluate(el => getComputedStyle(el).borderBottomWidth), '0px', 'no divider above column headers');
  assert.notEqual(await poolCard.evaluate(el => getComputedStyle(el).boxShadow), 'none', 'data card has the regular card shadow');
  assert.equal(await poolCard.evaluate(el => getComputedStyle(el).marginTop), '0px', 'data card has no external top margin');
  assert.equal(await poolCard.locator('[data-testid="resolver-pool"] tbody td').first().evaluate(el => getComputedStyle(el).paddingLeft), '0px', 'mobile card title has no extra desktop column inset');
  const poolRows = page.locator('[data-testid="resolver-pool"] tbody tr');
  const initialRows = await poolRows.count();
  assert.equal(initialRows, 2);
  assert.equal(await page.locator('.resolver-status').count(), 3);
  assert.equal(await page.locator('[data-testid="resolver-bootstrap"] .resolver-status').count(), 1);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);

  const bootstrapRows = page.locator('[data-testid="resolver-bootstrap"] tbody tr');
  const initialBootstrap = await bootstrapRows.count();
  await page.getByRole('button', { name: 'Add bootstrap resolver' }).click();
  const bootstrapDialog = page.getByRole('dialog');
  await bootstrapDialog.waitFor();
  const bootstrapPicker = bootstrapDialog.getByPlaceholder('Search by provider or address');
  await bootstrapPicker.click();
  await bootstrapDialog.getByRole('option').first().waitFor();
  assert.ok((await bootstrapDialog.getByRole('option').count()) > 8, 'bootstrap library must show all providers, not the first 8');
  await bootstrapPicker.fill('яндекс');
  await bootstrapDialog.getByRole('option').filter({ hasText: 'Yandex DNS' }).first().click();
  const bootstrapChip = bootstrapDialog.locator('.resolver-chip');
  await bootstrapChip.waitFor();
  assert.match(await bootstrapChip.textContent(), /Yandex DNS/);
  assert.match(await bootstrapChip.textContent(), /Russia|Россия/, 'chip contains the resolver description');
  assert.equal(await bootstrapChip.locator('.custom-select').count(), 0, 'chip must contain only name and description');
  assert.equal(await bootstrapDialog.locator('.custom-select').count(), 1, 'address select stays outside the chip');
  assert.equal(await bootstrapDialog.locator('.dialog-selected').count(), 0, 'no separate description block under the chip');
  assert.equal(await bootstrapPicker.count(), 0, 'search input is replaced by the selected chip');
  assert.ok(await bootstrapDialog.getByRole('button', { name: 'Clear selection' }).count() === 1);
  await bootstrapDialog.locator('.resolver-chip-clear').click();
  await bootstrapPicker.waitFor();
  assert.equal(await bootstrapChip.count(), 0, 'clearing the chip restores the search input');
  await bootstrapPicker.fill('яндекс');
  await bootstrapDialog.getByRole('option').filter({ hasText: 'Yandex DNS' }).first().click();
  await bootstrapDialog.getByTestId('dialog-add-bootstrap').click();
  await bootstrapDialog.waitFor({ state: 'hidden' });
  await page.waitForFunction(count => document.querySelectorAll('[data-testid="resolver-bootstrap"] tbody tr').length === count + 1, initialBootstrap);

  await page.getByTestId('add-resolver').click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor();
  const picker = dialog.getByPlaceholder('Start typing a resolver name or address');
  await picker.fill('');
  await dialog.getByRole('option').first().waitFor();
  assert.equal(await dialog.getByRole('option').count(), 40, 'long lists render progressively');
  const listBox = await dialog.locator('.resolver-suggest').boundingBox();
  const dialogBox = await dialog.boundingBox();
  assert.ok(listBox.y + listBox.height <= 844 + 1, 'dropdown must stay inside the viewport');
  assert.ok(listBox.height > 280, 'dropdown must use the available height, not a fixed 280px cap');
  assert.ok(listBox.y + listBox.height > dialogBox.y + dialogBox.height, 'dropdown must not be clipped by the modal');
  await dialog.locator('.resolver-suggest').evaluate(element => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event('scroll'));
  });
  await page.waitForFunction(() => document.querySelectorAll('.resolver-suggest [role="option"]').length > 40);
  await picker.fill('яндекс');
  assert.ok((await dialog.getByRole('option').filter({ hasText: 'Yandex DNS' }).count()) >= 1, 'Russian alias must find Yandex in the DoH pool');
  await picker.fill('quad');
  await dialog.getByRole('option').filter({ hasText: 'Quad9' }).first().click();
  const resolverChip = dialog.locator('.resolver-chip');
  await resolverChip.waitFor();
  assert.match(await resolverChip.textContent(), /Quad9/);
  assert.equal(await resolverChip.locator('.custom-select').count(), 0, 'chip must contain only name and description');
  assert.ok((await dialog.locator('.custom-select').count()) >= 1, 'protocol select stays outside the chip');
  assert.equal(await dialog.locator('.dialog-selected').count(), 0, 'no separate description block under the chip');
  assert.match(await dialog.locator('.dialog-url').textContent(), /^https:\/\//, 'address preview reflects the default protocol');
  assert.equal(await picker.count(), 0, 'search input is replaced by the selected chip');

  // Protocol select: DoH -> DoT changes the address preview.
  const protocolCombo = dialog.locator('label').filter({ hasText: 'Protocol' }).getByRole('combobox');
  assert.equal(await protocolCombo.inputValue(), 'DoH');
  await protocolCombo.click();
  await page.getByRole('option', { name: 'DoT', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.select-popup'));
  assert.equal(await protocolCombo.inputValue(), 'DoT', 'protocol select changes its value');
  assert.match(await dialog.locator('.dialog-url').textContent(), /^tls:\/\/dns\.quad9\.net$/, 'protocol select updates the resolver address');

  // Proxy select: Default -> Direct changes the selected value.
  const proxyCombo = dialog.locator('label').filter({ hasText: 'Proxy for queries' }).getByRole('combobox');
  assert.equal(await proxyCombo.inputValue(), 'Default');
  await proxyCombo.click();
  await page.getByRole('option', { name: 'Direct', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.select-popup'));
  assert.equal(await proxyCombo.inputValue(), 'Direct', 'proxy select changes its value');

  await dialog.getByTestId('dialog-add-resolver').click();
  await dialog.waitFor({ state: 'hidden' });
  await page.waitForFunction(count => document.querySelectorAll('[data-testid="resolver-pool"] tbody tr').length === count + 1, initialRows);
  assert.match(await poolRows.last().textContent(), /quad9/i);
  assert.match(await poolRows.last().textContent(), /tls:\/\/dns\.quad9\.net/, 'selected protocol is saved');
  assert.equal(await poolRows.last().locator('input.select-input').inputValue(), 'Direct', 'selected proxy is saved');

  const saved = page.waitForResponse(response => response.url().includes('/api/dns') && response.request().method() === 'PUT');
  await page.getByTestId('save-dns').click();
  assert.equal((await saved).status(), 200);
  assert.equal(await page.locator('.code-preview').count(), 0);

  await navigate('Rules');
  await navigate('Settings');
  assert.equal(await page.getByRole('tab', { name: 'DNS', exact: true }).getAttribute('aria-selected'), 'true');
  await page.getByRole('heading', { name: /Resolver pool/ }).waitFor();

  assert.deepEqual(errors, []);
  await page.screenshot({ path: join(tmpdir(), 'freedomgate-dns.png'), fullPage: true });

  // A healthy engine must not show any persistent status block.
  const store = new Store(':memory:');
  const supervisor = {
    status: () => ({ state: 'running', running: true, error: null, appliedAt: new Date().toISOString(), dnsPort: 15353 }),
    apply: async () => ({ ok: true }),
  };
  const filterState = { state: 'running', filtering: true, error: null };
  const filter = { status: () => ({ ...filterState }), ensure: async () => ({ ok: true }) };
  const local = createServer(store, { supervisor, filter });
  await new Promise(resolve => local.listen(0, '127.0.0.1', resolve));
  const localBase = 'http://127.0.0.1:' + local.address().port;
  try {
    const healthy = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await healthy.goto(localBase + '/', { waitUntil: 'networkidle' });
    await healthy.getByLabel('Username').fill('admin');
    await healthy.getByLabel('Password',{exact:true}).fill('test password 12345');
    await healthy.getByRole('button', { name: 'Create administrator' }).click();
    await healthy.getByRole('heading', { name: /Overview|Начнём/ }).first().waitFor();
    assert.equal(await healthy.locator('.engine-banner').count(), 0);
    await navigate('Settings',healthy);
    await healthy.getByRole('tab', { name: 'DNS', exact: true }).click();
    await healthy.getByRole('heading', { name: /Resolver pool/ }).waitFor();
    assert.equal(await healthy.locator('.engine-banner').count(), 0);

    // A failing filtering stage must be reported globally as well.
    filterState.state = 'error';
    filterState.error = 'filter down';
    await healthy.reload({ waitUntil: 'networkidle' });
    await healthy.locator('.engine-banner').waitFor();
    assert.match(await healthy.locator('.engine-banner').textContent(), /AdGuard is not working/);
    await healthy.close();

    // Russian locale: the built-in Direct route is labelled "Прямой".
    await selectValue(page, 'language', 'ru');
    await page.waitForTimeout(300);
    await navigate('Шлюзы');
    await page.getByRole('heading', { name: 'Способы выхода в интернет' }).waitFor();
    const russianRows = await page.locator('[data-testid="exit-row"]').allTextContents();
    assert.ok(russianRows.some(text => text.includes('Прямой')), 'Russian Direct route is labelled Прямой');
    await selectValue(page, 'language', 'en');
  } finally {
    await new Promise(resolve => local.close(resolve));
    store.close();
  }
  console.log('Access methods and incoming connections cards, default zapret and its DPI settings, and DNS settings (modals, apply, banners, route) passed.');
} finally {
  await browser.close();
  server.kill('SIGTERM');
  await new Promise(resolve => setTimeout(resolve, 300));
  rmSync(folder, { recursive: true, force: true });
}
