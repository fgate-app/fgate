import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
const browser=await chromium.launch({channel:'chrome',headless:true});
function luminance(color){const rgb=color.match(/[\d.]+/g).slice(0,3).map(Number).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;});return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722;}
function contrast(a,b){const x=luminance(a),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);}
try{
 const page=await browser.newPage({viewport:{width:1280,height:1000}});await page.goto('http://127.0.0.1:6006/iframe.html?id=foundations-interface-colors--compare-themes&viewMode=story');await page.locator('[data-ui-theme="light"] [data-color-token="--color-surface"]').waitFor();
 for(const theme of ['light','dark']){
  const frame=page.locator(`[data-ui-theme="${theme}"]`);
  const swatch=token=>frame.locator(`[data-color-token="--color-${token}"]`).evaluate(element=>getComputedStyle(element).backgroundColor);
  const surface=await swatch('surface');
  assert.equal(await swatch('success'),'rgb(22, 163, 74)');for(const background of ['page','surface','secondary'])assert.ok(contrast(await swatch(background),await swatch('success'))>=3,theme+' availability marker contrast');
  for(const token of ['text-muted','text-secondary','text-label','text-table','text-primary','text-strong','danger'])assert.ok(contrast(surface,await swatch(token))>=4.5,theme+' '+token+' contrast');
  for(const token of await frame.locator('[data-color-token]').all())assert.notEqual(await token.evaluate(element=>getComputedStyle(element).backgroundColor),'rgba(0, 0, 0, 0)');
  const aliases=await frame.evaluate(element=>{const s=getComputedStyle(element);return ['--palette-30','--color-accent-strong','--palette-39','--color-text-table','--color-on-secondary','--color-text-primary'].map(token=>s.getPropertyValue(token).trim());});assert.equal(aliases[0],aliases[1]);assert.equal(aliases[2],aliases[3]);assert.equal(aliases[4],aliases[5]);
  const input=frame.locator('.app-input');const idle=await input.evaluate(element=>getComputedStyle(element).backgroundColor);await input.hover();assert.notEqual(await input.evaluate(element=>getComputedStyle(element).backgroundColor),idle,'hover remains distinct');
 }
 await page.screenshot({path:'/tmp/fg-interface-colors.png',fullPage:true});
 console.log('Both theme palettes, token aliases, independent previews, text/status contrast and distinct hover states passed.');
}finally{await browser.close();}
