import {chromium,expect} from '@playwright/test';
import assert from 'node:assert/strict';
const browser=await chromium.launch({channel:'chrome',headless:true});
try{
 const page=await browser.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
 for(const locale of ['en','ru','zh-CN']){
  await page.addInitScript(locale=>localStorage.setItem('fg.locale',locale),locale);
  for(const [variant,code] of Object.entries({'country':'NL','lowercase':'NL','missing-code':'NL','invalid-code':'NL','legacy-russia':'RU','legacy-russian-name':'RU','legacy-united-states':'US','legacy-netherlands':'NL','unknown-country':''})){
   await page.goto(`http://127.0.0.1:6006/iframe.html?id=components-gateway-location--${variant}&viewMode=story&globals=locale:${locale}`);
   await page.getByTestId('gateway-location').waitFor();const flag=page.locator('.gateway-country-flag');
   if(code){await expect(flag).toHaveText(String.fromCodePoint(...[...code].map(letter=>0x1f1e6+letter.charCodeAt(0)-65)));await expect(page.getByTestId('gateway-location')).toContainText(new Intl.DisplayNames([locale],{type:'region'}).of(code));await expect(flag).toHaveAttribute('aria-hidden','true');}
   else {await expect(flag).toHaveCount(0);await expect(page.getByTestId('gateway-location')).not.toContainText('Unrecognized location');}
   await expect(page.getByTestId('gateway-location')).toContainText('203.0.113.8');await expect(page.getByTestId('gateway-location')).toContainText('Example Transit');
  }
 }
 await page.setViewportSize({width:390,height:844});await page.goto('http://127.0.0.1:6006/iframe.html?id=components-gateway-location--country&viewMode=story&globals=locale:zh-CN');await expect(page.locator('.gateway-country-flag')).toHaveText('🇳🇱');await page.screenshot({path:'/tmp/fg-country-flag.png'});assert.deepEqual(errors,[]);
 console.log('Country flags: valid/lowercase/missing/invalid code, en/ru/zh-CN, legacy names, provider/IP preservation and mobile passed.');
}finally{await browser.close();}
