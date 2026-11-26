import {chromium,expect} from '@playwright/test';
import assert from 'node:assert/strict';
import {Store} from '../server/store.js';
import {createServer} from '../server/index.js';
import {normalizeAdGuardSettings} from '../shared/adguard-policy.js';
const store=new Store(':memory:');let rules=['@@||allowed.fixture^'],filters=[{url:'https://example.com/list',name:'Fixture AdGuard list',enabled:true}],settings=normalizeAdGuardSettings();
const filter={status:()=>({state:'running',filtering:true}),userRules:async()=>[...rules],policySnapshot:async()=>({userRules:[...rules],filters:[...filters]}),reconcileUserRules:async(previous,desired)=>{rules=[...new Set([...rules.filter(rule=>!previous.includes(rule)),...desired])];},reconcileFilters:async(previous,desired)=>{filters=[...desired];},configuration:async()=>settings,configure:async input=>{settings=normalizeAdGuardSettings(input);return settings;}};
const server=createServer(store,{filter,inlineDelay:20});await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
let browser;
try{
 browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base);await page.getByLabel('Username').fill('admin');await page.getByLabel('Password',{exact:true}).fill('fixture password 12345');await page.getByRole('button',{name:'Create administrator'}).click();await page.getByTestId('overview-dashboard').waitFor();
 await page.goto(base+'/routes/domains');let row=page.getByTestId('route-group-row').filter({hasText:'AdGuard DNS filter'});await row.waitFor();assert.equal(store.routeGroups().filter(g=>g.dnsFilters.length).length,0);
 await expect(row.getByRole('switch')).toHaveCount(0);await expect(row.getByRole('button',{name:'Move up'})).toHaveCount(0);
 await row.locator('.name-cell').click();await expect(page.locator('.card-stack > .data-card').last()).toContainText('AdGuard Home');let dialog=page.locator('dialog[open]');await expect(dialog.getByLabel('DNS subscription URLs')).toHaveValue('https://example.com/list');
 await dialog.getByLabel('DNS subscription URLs').fill('file:///etc/passwd');await dialog.getByTestId('save-adguard').click();await expect(page.locator('.toast.is-error').last()).toContainText('HTTP(S)');assert.equal(filters[0].url,'https://example.com/list');
 await dialog.getByLabel('DNS subscription URLs').fill('https://example.com/new-list');await dialog.getByTestId('save-adguard').click();await dialog.waitFor({state:'hidden'});assert.equal(filters[0].url,'https://example.com/new-list');
 await page.locator('tr').filter({hasText:'AdGuard Home'}).locator('td').first().click();dialog=page.locator('dialog[open]');await expect(dialog.getByLabel('DNS cache size, MB')).toHaveValue('4');
 await dialog.getByLabel('DNS cache size, MB').fill('-1');await dialog.getByTestId('save-adguard').click();await expect(page.locator('.toast.is-error').last()).toContainText('256 MB');assert.equal(store.adGuardSettings().cacheSize,4194304);
 await dialog.getByLabel('DNS cache size, MB').fill('12');await dialog.getByRole('combobox',{name:'DNS log retention',exact:true}).click();await page.getByRole('option',{name:'7 days',exact:true}).click();await dialog.locator('.app-switch').filter({hasText:'DNS query log'}).locator('.switch-track').click();await expect(dialog).toContainText('new AdGuard blocks will not appear');
 await page.screenshot({animations:'disabled',path:'/tmp/fg-adguard-settings.png'});await dialog.getByTestId('save-adguard').click();await dialog.waitFor({state:'hidden'});assert.equal(store.adGuardSettings().cacheSize,12582912);assert.equal(settings.logEnabled,false);assert.equal(settings.logInterval,604800000);
 await page.locator('tr').filter({hasText:'AdGuard Home'}).locator('td').first().click();dialog=page.locator('dialog[open]');await expect(dialog.getByLabel('DNS cache size, MB')).toHaveValue('12');
 await page.setViewportSize({width:390,height:844});await page.screenshot({animations:'disabled',path:'/tmp/fg-adguard-settings-mobile.png'});assert.ok(await dialog.evaluate(el=>el.getBoundingClientRect().right<=innerWidth));
 await dialog.locator('.app-switch').filter({hasText:'Enabled'}).first().locator('.switch-track').click();await dialog.getByTestId('save-adguard').click();await dialog.waitFor({state:'hidden'});assert.equal(filters[0].enabled,false);
 await page.goto(base+'/routes/domains');await expect(page.getByTestId('route-group-row').filter({hasText:'AdGuard DNS filter'})).toHaveCount(0);
 await page.goto(base+'/settings/dns');await page.locator('tr').filter({hasText:'AdGuard Home'}).locator('td').first().click();dialog=page.locator('dialog[open]');await dialog.locator('.app-switch').filter({hasText:'Enabled'}).first().locator('.switch-track').click();await dialog.getByTestId('save-adguard').click();await dialog.waitFor({state:'hidden'});
 await page.goto(base+'/routes/domains');await expect(page.getByTestId('route-group-row').filter({hasText:'AdGuard DNS filter'})).toHaveCount(1);
 assert.deepEqual(errors,[]);console.log('Unified blocking: migration, DNS subscription edit/toggle, validation, DNS settings persistence and mobile dialogs passed.');
}finally{await browser?.close();server.closeAllConnections();await new Promise(r=>server.close(r));store.close();}
