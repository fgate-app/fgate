import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
const browser=await chromium.launch({channel:'chrome',headless:true});
try{
 const page=await browser.newPage({viewport:{width:1600,height:1050}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 for(const [locale,label] of [['en','Search devices, rules and gateways'],['ru','Поиск устройств, правил и шлюзов'],['zh-CN','搜索设备、规则和网关']]){
  await page.goto(`http://127.0.0.1:6006/iframe.html?id=overview-network-architecture--loading&viewMode=story&globals=theme:${locale==='ru'?'dark':'light'};locale:${locale}`);
  const spinner=page.getByTestId('app-spinner');await spinner.waitFor();assert.equal(await page.locator('.architecture-viewport').getAttribute('aria-busy'),'true');
  const spinRect=await spinner.boundingBox(),area=await page.locator('.architecture-viewport').boundingBox();assert.ok(Math.abs(spinRect.x+spinRect.width/2-area.x-area.width/2)<1&&Math.abs(spinRect.y+spinRect.height/2-area.y-area.height/2)<1);
  await page.goto(`http://127.0.0.1:6006/iframe.html?id=overview-network-architecture--current-map&viewMode=story&globals=theme:${locale==='ru'?'dark':'light'};locale:${locale}`);
  const search=page.getByTestId('architecture-search');await search.waitFor();assert.equal(await page.getByTestId('app-spinner').count(),0);assert.equal(await search.getAttribute('aria-label'),label);assert.equal(await page.locator('.architecture-health').count(),0);
  await search.focus();assert.equal(await search.getAttribute('aria-expanded'),'false','no suggestions for empty query');
  await search.fill('198.51.100.12');await page.getByRole('option',{name:/^Device 02/}).waitFor();
  assert.equal(await page.locator('.select-popup').evaluate(node=>node.matches(':popover-open')),true);
  await page.getByRole('option',{name:/^Device 02/}).click();
  const device=page.locator('[data-architecture-node="client:02:00:00:00:00:02"]');assert.equal(await device.getAttribute('aria-pressed'),'true');
  assert.equal(await page.locator('[data-architecture-node="gateway:gw-00001"]').evaluate(n=>n.classList.contains('is-dim')),false);
  assert.equal(await page.locator('[data-architecture-node="client:02:00:00:00:00:01"]').evaluate(n=>n.classList.contains('is-dim')),true);
  assert.equal(await page.locator('.architecture-gateway-wrap.is-dim').count(),3,'unrelated wrapping headers are dimmed too');
  const centered=await device.boundingBox(),viewport=await page.locator('.architecture-viewport').boundingBox();assert.ok(Math.abs(centered.x+centered.width/2-viewport.x-viewport.width/2)<1&&Math.abs(centered.y+centered.height/2-viewport.y-viewport.height/2)<1);
  await search.fill('vLeSs 02');await page.getByRole('option',{name:/^VLESS 02/}).waitFor();await search.press('ArrowDown');await search.press('Enter');
  assert.equal(await page.locator('[data-architecture-node="gateway:gw-00008"]').getAttribute('aria-pressed'),'true');
  if(locale==='en'){await search.fill('ru');assert.equal(await page.getByRole('option').count(),1,'category labels must not create false name matches');}
  await search.fill('Youtube');await page.getByRole('option',{name:/^Youtube/}).click();assert.equal(await page.locator('[data-architecture-node="rule:groups:rule-003"]').getAttribute('aria-pressed'),'true');
  assert.equal(await page.locator('[data-architecture-node="group:group-002"]').evaluate(n=>n.classList.contains('is-dim')),false);
  await search.fill('no_such_node_123');assert.equal(await page.getByRole('option').count(),0);await page.locator('.select-empty').waitFor();
  await search.press('Escape');assert.equal(await search.getAttribute('aria-expanded'),'false');
  await search.fill('');assert.equal(await page.locator('.architecture-node.is-selected').count(),0);assert.equal(await page.locator('.architecture-node.is-dim').count(),0);
  await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await search.fill('Device');await page.getByRole('option').first().waitFor();const popup=await page.locator('.select-popup').boundingBox();assert.ok(popup.x>=0&&popup.x+popup.width<=390&&popup.y>=0&&popup.y+popup.height<=844);
  await page.screenshot({path:`/tmp/fg-map-search-${locale}-mobile.png`});await search.press('Escape');
  await page.goto(`http://127.0.0.1:6006/iframe.html?id=overview-network-architecture--loading&viewMode=story&globals=theme:dark;locale:${locale}`);
  await page.getByTestId('app-spinner').waitFor();
  const mobileSpin=await page.getByTestId('app-spinner').boundingBox(),mobileArea=await page.locator('.architecture-viewport').boundingBox();assert.ok(Math.abs(mobileSpin.x+mobileSpin.width/2-mobileArea.x-mobileArea.width/2)<1&&Math.abs(mobileSpin.y+mobileSpin.height/2-mobileArea.y-mobileArea.height/2)<1);
  await page.setViewportSize({width:1600,height:1050});
 }
 assert.deepEqual(errors,[]);console.log('Map search: localized suggestions, name/IP/case, pointer/keyboard, chain selection, centering, empty/reset and mobile top-layer popup passed.');
}finally{await browser.close();}
