import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveCountryCode} from '../web/src/lib/countries.js';
test('legacy GeoIP country names resolve consistently across source languages',()=>{
 for(const [code,names] of Object.entries({RU:['Russia','Россия','Russian Federation','Российская Федерация'],US:['United States','United States of America','США','美国'],NL:['The Netherlands','Netherlands','Нидерланды','荷兰']}))for(const country of names)assert.equal(resolveCountryCode({country}),code,country);
 assert.equal(resolveCountryCode({countryCode:' ru ',country:'Russia'}),'RU');assert.equal(resolveCountryCode({country_code:'us'}),'US');assert.equal(resolveCountryCode({countryCode:'XX',country:'The Netherlands'}),'NL');assert.equal(resolveCountryCode({country:'Unknown place'}),'');assert.equal(resolveCountryCode({}),'');
});
