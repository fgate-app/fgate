// Explicit opt-in: uses a short-lived administrator session prepared on the RPi.
// Never changes profiles/network settings; revokes this session in finally.
import {chromium,expect} from '@playwright/test';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {exportDiagnosticReport} from '../../shared/diagnostic-report.js';
const base=process.env.FREEDOMGATE_RPI_URL || 'http://127.0.0.1:18789';
const session=JSON.parse(readFileSync(process.env.FREEDOMGATE_RPI_SESSION,'utf8'));
const result={checkedAt:new Date().toISOString(),assets:[],pages:[],api:[],diagnostics:{}};
const hash=value=>createHash('sha256').update(value).digest('hex');
const browser=await chromium.launch({channel:'chrome',headless:true});
const context=await browser.newContext({viewport:{width:1280,height:900},serviceWorkers:'block'});
await context.addCookies([{name:'fg_session',value:session.token,url:base,httpOnly:true,sameSite:'Strict'}]);
await context.addInitScript(()=>localStorage.setItem('fg.locale','en'));
const page=await context.newPage(),errors=[];
page.on('pageerror',error=>errors.push(error.message));
page.on('console',message=>{if(/TypeError|ReferenceError|Unhandled error/.test(message.text()))errors.push(message.text());});
const get=async path=>{const r=await context.request.get(base+path,{timeout:30000});assert.equal(r.status(),200,path);return r.json();};
try{
 assert.equal((await get('/api/auth/session')).user.role,'admin');
 assert.equal((await get('/api/health')).ready,true);
 for(const path of ['/api/dns/engine','/api/clients','/api/routes','/api/network/status','/api/profiles']){
  const value=await get(path);result.api.push({path,status:200});
  if(path==='/api/dns/engine'){assert.equal(value.engine.state,'running');assert.equal(value.filter.state,'running');}
  if(path==='/api/network/status')assert.equal(value.ok,true);
 }
 const html=readFileSync(new URL('../../web/dist/index.html',import.meta.url));
 const served=await context.request.get(base+'/connections');assert.equal(hash(await served.body()),hash(html));
 for(const asset of html.toString().matchAll(/(?:src|href)="(\/assets\/[^"?]+)"/g)){
  const path=asset[1],response=await context.request.get(base+path);assert.equal(response.status(),200);
  const digest=hash(await response.body());assert.equal(digest,hash(readFileSync(new URL('../../web/dist'+path,import.meta.url))));result.assets.push({path,sha256:digest});
 }
 for(const path of ['/connections','/dns','/routes','/settings']){await page.goto(base+path,{waitUntil:'networkidle'});await expect(page.locator('main')).toBeVisible();result.pages.push(path);}
 await page.goto(base+'/connections',{waitUntil:'networkidle'});
 const row=page.getByTestId('exit-row').filter({has:page.locator('.gateway-name>strong').filter({hasText:/^Amnezia Xray$/})});await expect(row).toHaveCount(1);
 await row.getByRole('button',{name:'Actions',exact:true}).click();await page.getByRole('menuitem',{name:'Gateway diagnostics',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'Gateway diagnostics',exact:true});await expect(dialog).toHaveClass(/is-wide/);await expect(dialog.getByRole('heading',{name:'Gateway diagnostics Amnezia Xray',exact:true})).toBeVisible();await expect.poll(async()=>Math.round((await dialog.boundingBox()).width)).toBe(1120);await expect(dialog.locator('.diagnostic-context')).toHaveCount(0);await expect(dialog).not.toContainText('Choose checks, then run diagnostics.');result.diagnostics.dialogWidth=1120;
 await expect(page.getByTestId('diagnostic-outcome')).toHaveCount(0);await expect(dialog.getByRole('button',{name:'Run diagnostics',exact:true})).toBeEnabled();await page.screenshot({path:'/tmp/fg-rpi-diagnostics-ready.png',animations:'disabled'});
 await expect(dialog.getByRole('switch',{name:'Compare DNS paths'})).toBeVisible();
 await expect(dialog.getByRole('switch',{name:'Compare SNI and IP addresses'})).toBeVisible();
 await dialog.getByTestId('diagnostic-capture-switch').check();
 await dialog.getByRole('switch',{name:'Receive domain data through the gateway'}).check();
 const responsePromise=page.waitForResponse(r=>r.url().includes('/diagnostics') && r.request().method()==='POST',{timeout:120000});
 await page.getByTestId('diagnostic-retry').click();const response=await responsePromise;assert.equal(response.status(),200);assert.match(response.headers()['content-type'],/application\/x-ndjson/);await expect(page.getByRole('progressbar')).toBeVisible();assert.ok(Number(await page.getByRole('progressbar').getAttribute('value'))<Number(await page.getByRole('progressbar').getAttribute('max')));await expect(page.getByTestId('diagnostic-summary')).toHaveCount(0);await expect(page.getByTestId('diagnostic-export')).toHaveCount(0);await expect(page.getByTestId('diagnostic-identity')).toBeVisible();result.diagnostics.progressBeforeCompletion=true;result.diagnostics.resultsHiddenDuringRun=true;
 const events=(await response.text()).trim().split('\n').map(line=>JSON.parse(line));const report=events.find(event=>event.type==='result').report;assert.ok(events.filter(event=>event.type==='progress').length>=10);assert.equal(report.progress.state,'completed');await expect(page.getByRole('progressbar')).toHaveCount(0);await expect(page.locator('.diagnostic-steps')).toHaveCount(0);result.diagnostics.progressHiddenAfterCompletion=true;result.diagnostics.progressSteps=report.progress.steps;await expect(page.locator('[data-testid^="diagnostic-finding-downloads:"]').first()).toContainText('not a speed test');
 assert.equal(report.schemaVersion,2);assert.ok(report.measurement.environment.engines.some(row=>row.id==='mihomo' && row.state==='ok'));assert.ok(report.measurement.environment.engines.some(row=>row.id==='xray' && row.state==='ok'));assert.equal(report.measurement.environment.tools.curl.state,'ok');result.diagnostics.environment=report.measurement.environment;assert.equal(report.targetReports.length,report.domains.length);assert.ok(report.targetReports.every(target=>target.transfer?.attempts?.some(row=>row.complete && row.pathObservation?.state==='verified')),'Every listed domain has a completed bounded response through the selected gateway');
 const capture=report.endpointControl?.results?.flatMap(row=>row.attempts || []).find(row=>row.tcpCapture)?.tcpCapture;
 assert.ok(capture,'Explicit server capture returned');assert.equal(capture.state,'observed');assert.equal(capture.probeCorrelated,true);assert.ok(capture.packets.some(row=>row.direction==='outbound' && row.flags.includes('SYN')));result.diagnostics.tcpCapture={state:capture.state,probeCorrelated:capture.probeCorrelated,packetCount:capture.packets.length,limits:capture.limits};
 result.diagnostics.transfer=report.targetReports.flatMap(target=>target.transfer.attempts.map(({bytes,ttfbMs,durationMs,outcome,pathObservation})=>({domain:target.domain,bytes,ttfbMs,durationMs,outcome,pathState:pathObservation?.state})));
 result.diagnostics.uplink=report.targetReports.flatMap(target=>(target.uplinkControl?.attempts || []).map(({pathObservation,outcome})=>({domain:target.domain,pathState:pathObservation?.state,outcome})));assert.ok(result.diagnostics.uplink.length);
 await page.locator('[data-testid^="diagnostic-finding-downloads:"]').first().scrollIntoViewIfNeeded();await page.screenshot({path:'/tmp/fg-rpi-transfer-desktop.png',animations:'disabled'});
 const downloadPromise=page.waitForEvent('download');await page.getByTestId('diagnostic-export').click();const download=await downloadPromise;
 const exported=JSON.parse(readFileSync(await download.path(),'utf8'));assert.equal(exported.anonymized,true);assert.equal(exported.targetReports.length,exported.domains.length);
 assert.equal(exported.egressIdentity.observation,'cached-gateway-location');await expect(page.getByTestId('diagnostic-identity')).toBeVisible();
 result.diagnostics.egressIdentity={state:exported.egressIdentity.state,ipPresent:!!exported.egressIdentity.ip,countryPresent:!!(exported.egressIdentity.country || exported.egressIdentity.countryCode),providerPresent:!!exported.egressIdentity.provider,source:exported.egressIdentity.source,checkedAt:exported.egressIdentity.checkedAt};
 if(exported.egressIdentity.state==='available'){await expect(page.getByTestId('diagnostic-identity')).toContainText(exported.egressIdentity.ip);if(exported.egressIdentity.provider)await expect(page.getByTestId('diagnostic-identity')).toContainText(exported.egressIdentity.provider);}else await expect(page.getByTestId('diagnostic-identity')).toContainText('Unavailable');
 // Do not store the live report, local addressing, profile names or identifiers.
 if(process.env.FREEDOMGATE_RPI_REPORT)writeFileSync(process.env.FREEDOMGATE_RPI_REPORT,JSON.stringify(exportDiagnosticReport(report),null,2)+'\n');
 await page.setViewportSize({width:390,height:844});assert.ok(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth));await page.locator('[data-testid^="diagnostic-finding-downloads:"]').first().scrollIntoViewIfNeeded();await page.screenshot({path:'/tmp/fg-rpi-transfer-mobile.png',animations:'disabled'});
 await page.getByTestId('diagnostic-retry').click();await expect(page.getByTestId('diagnostic-settings')).toBeVisible();await expect(page.getByTestId('diagnostic-summary')).toHaveCount(0);await expect(page.getByTestId('diagnostic-export')).toHaveCount(0);result.diagnostics.retryReturnsSettings=true;await page.getByTestId('diagnostic-dns-switch').check();await page.getByTestId('diagnostic-sni-switch').check();await expect(page.getByTestId('diagnostic-domains')).toHaveCount(1);await expect(dialog.getByRole('combobox',{name:'Primary DNS resolver',exact:true})).toHaveCount(1);
 await page.getByTestId('diagnostic-retry').click();await expect(page.getByTestId('diagnostic-progress')).toBeVisible();await expect(page.locator('.diagnostic-steps [data-kind=websites][data-state=finished]').first()).toBeVisible({timeout:60000});await expect(page.getByTestId('diagnostic-summary')).toHaveCount(0);await expect(page.getByTestId('diagnostic-export')).toHaveCount(0);await expect(page.getByTestId('diagnostic-identity')).toBeVisible();await page.getByTestId('diagnostic-cancel').click();await expect(page.getByTestId('diagnostic-summary')).toContainText('Diagnostics cancelled');
 const partialDownload=page.waitForEvent('download');await page.getByTestId('diagnostic-export').click();const partial=JSON.parse(readFileSync(await (await partialDownload).path(),'utf8'));assert.equal(partial.progress.state,'cancelled');assert.ok(partial.progress.steps.some(step=>step.state==='finished'));assert.ok(partial.progress.steps.some(step=>step.state!=='finished'));assert.equal(partial.anonymized,true);await expect(page.getByRole('progressbar')).toHaveCount(0);await expect(page.locator('.diagnostic-steps')).toHaveCount(0);result.diagnostics.progressHiddenAfterCancellation=true;result.diagnostics.partialCancellation='completed-checks-kept';
 await page.screenshot({path:'/tmp/fg-rpi-cancelled-mobile.png',animations:'disabled'});await page.getByTestId('diagnostic-close').click();await expect(dialog).toBeHidden();
 // A new request must succeed after cancellation: proves the concurrency slot was released.
 const profiles=await get('/api/profiles'),direct=profiles.find(row=>row.engine==='direct');assert.ok(direct);
 let resumed;
 for(let i=0;i<20;i++){
  resumed=await context.request.post(base+`/api/profiles/${direct.id}/diagnostics`,{headers:{'X-CSRF-Token':session.csrf},data:{},timeout:60000});
  if(resumed.status()!==409)break;
  await new Promise(resolve=>setTimeout(resolve,200));
 }
 assert.equal(resumed.status(),200);result.diagnostics.cancellation='slot-released';
 const locals=[];
 for(const profile of profiles.filter(row=>['direct','zapret'].includes(row.engine))){
  await page.setViewportSize({width:1280,height:900});await page.goto(base+'/connections',{waitUntil:'networkidle'});
  await page.locator(`[data-testid="exit-row"][data-engine="${profile.engine}"]`).getByRole('button',{name:'Actions',exact:true}).click();await page.getByRole('menuitem',{name:'Gateway diagnostics',exact:true}).click();
  await expect(dialog).toBeVisible();await expect(dialog.getByRole('switch',{name:'Check the direct uplink'})).toHaveCount(0);await expect(dialog.getByRole('switch',{name:'Check gateway server addresses'})).toHaveCount(0);await expect(dialog.getByRole('switch',{name:'Check DNS resolvers'})).toHaveCount(1);
  await expect(page.getByTestId('diagnostic-outcome')).toHaveCount(0);await dialog.getByRole('button',{name:'Run diagnostics',exact:true}).click();await expect(page.getByTestId('diagnostic-retry')).toBeEnabled({timeout:60000});await expect(page.getByTestId('diagnostic-outcome')).toBeVisible();assert.doesNotMatch(await dialog.innerText(),/Tunnel protocol|Connecting to proxy|External gateway route/);
  const localResponse=await context.request.post(base+`/api/profiles/${profile.id}/diagnostics`,{headers:{'X-CSRF-Token':session.csrf},data:{uplink:true,endpoint:true},timeout:60000});assert.equal(localResponse.status(),200);
  const local=await localResponse.json();assert.equal(local.measurement.checks.uplink,false);assert.equal(local.measurement.checks.endpoint,false);assert.equal(local.gatewayKind,profile.engine==='direct'?'direct':'dpi-bypass');
  for(const key of ['endpointControl','uplinkControl','dnsPathComparisons'])assert.equal(key in local,false,key);assert.equal(local.path.externalConnection,undefined);assert.ok(local.attempts.every(row=>row.stages.every(stage=>!['proxy-connect','tunnel-protocol'].includes(stage.id))));
  locals.push({kind:local.gatewayKind,outcome:local.outcome,externalProxyFields:false});await page.screenshot({path:`/tmp/fg-rpi-local-${profile.engine}.png`,animations:'disabled'});await page.getByTestId('diagnostic-close').click();
 }
 result.diagnostics.localExits=locals;

 assert.deepEqual(errors,[]);result.browserErrors=errors;
 console.log(JSON.stringify(result,null,2));
}finally{
 await context.request.post(base+'/api/auth/logout',{headers:{'X-CSRF-Token':session.csrf},data:{}}).catch(()=>{});
 await browser.close();
}
