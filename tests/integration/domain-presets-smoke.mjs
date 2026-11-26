// Native module validation with a public catalog; never changes gateway routes or filters.
import {readFileSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {spawn,execFileSync} from 'node:child_process';import net from 'node:net';import assert from 'node:assert/strict';
import {buildMihomoConfig} from '../../server/mihomo.js';import {buildAdGuardConfig} from '../../server/adguard.js';
import {defaultDnsSettings} from '../../server/dns-resolvers.js';import {adguardDomainRule} from '../../server/route-entries.js';
const file=process.env.FREEDOMGATE_TEST_DOMAIN_CATALOG;if(!file)throw Error('Set FREEDOMGATE_TEST_DOMAIN_CATALOG to the public catalog.json');
const catalog=JSON.parse(readFileSync(file,'utf8')),entries=[...new Set(Object.values(catalog.lists).flat())];
const folder=mkdtempSync(join(tmpdir(),'fg-preset-native-'));let filter;
async function port(){const server=net.createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const value=server.address().port;await new Promise(resolve=>server.close(resolve));return value;}
try{
 const yaml=buildMihomoConfig(defaultDnsSettings,{}, {profiles:[],configs:[],devices:[],groups:[{entries,routeId:'block'}]});
 const mf=join(folder,'mihomo.yaml');writeFileSync(mf,yaml,{mode:0o600});
 execFileSync(process.env.FREEDOMGATE_MIHOMO || '/opt/freedomgate/modules/mihomo/v1.19.33/mihomo',['-t','-d',folder,'-f',mf],{stdio:'pipe',timeout:20000});
 const dnsPort=await port(),webPort=await port();
 const rules=[...new Set(entries.map(adguardDomainRule).filter(Boolean))];
 let config=buildAdGuardConfig({listenPort:dnsPort,webPort,upstreamPort:await port()}).replace('    - 0.0.0.0','    - 127.0.0.1').replace(/filters:\n[\s\S]*?user_rules:\n[\s\S]*/,'filters: []\nuser_rules:\n'+rules.map(rule=>'  - '+JSON.stringify(rule)).join('\n')+'\n');
 const af=join(folder,'adguard.yaml');writeFileSync(af,config,{mode:0o600});
 filter=spawn(process.env.FREEDOMGATE_ADGUARD || '/opt/freedomgate/modules/adguard/v0.107.80/AdGuardHome',['--no-check-update','-c',af,'-w',folder],{stdio:'ignore'});
 const check=async name=>{const response=await fetch(`http://127.0.0.1:${webPort}/control/filtering/check_host?name=${encodeURIComponent(name)}&qtype=A`,{signal:AbortSignal.timeout(1500)});assert.equal(response.status,200);return response.json();};
 for(let n=0;n<100;n++){try{await check('unrelated.invalid');break;}catch{if(n===99)throw Error('Isolated AdGuard not ready');await new Promise(resolve=>setTimeout(resolve,100));}}
 assert.equal((await check('yt3.googleusercontent.com')).reason,'FilteredBlackList');
 const response=await fetch(`http://127.0.0.1:${webPort}/control/filtering/set_rules`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({rules:[adguardDomainRule('full:exact-preset.example.org'),adguardDomainRule('regexp:(^|\\.)video[0-9]{1,3}\\.example$')]})});assert.equal(response.status,200);
 assert.equal((await check('exact-preset.example.org')).reason,'FilteredBlackList');
 assert.notEqual((await check('sub.exact-preset.example.org')).reason,'FilteredBlackList','full rules do not match subdomains');
 assert.equal((await check('video123.example')).reason,'FilteredBlackList');
 assert.notEqual((await check('video1234.example')).reason,'FilteredBlackList','comma quantifier retains its upper bound');
 assert.notEqual((await check('unrelated.invalid')).reason,'FilteredBlackList');
 console.log(`Native mihomo accepted ${entries.length} entries; AdGuard exact/domain/regex semantics passed.`);
}finally{
 if(filter && filter.exitCode===null && filter.signalCode===null){filter.kill('SIGTERM');await new Promise(resolve=>filter.once('exit',resolve));}
 rmSync(folder,{recursive:true,force:true});
}
