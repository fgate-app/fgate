import {execFileSync} from 'node:child_process';import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {buildMihomoConfig} from '../../server/mihomo.js';import {defaultDnsSettings} from '../../server/dns-resolvers.js';
const folder=mkdtempSync(join(tmpdir(),'fg-disabled-'));
try{
 const profiles=[{id:'direct01',engine:'direct',enabled:false},{id:'ss-node1',engine:'outline',enabled:false},{id:'xraynode',engine:'xray',enabled:true}];
 const yaml=buildMihomoConfig(defaultDnsSettings,{}, {profiles,configs:[{profile_id:'ss-node1',engine:'outline',config:'unused'},{profile_id:'xraynode',engine:'xray',config:'{}'}],bridges:{xraynode:{port:18000,address:'192.0.2.1'}},connectionGroups:[{id:'empty',members:['ss-node1']},{id:'mixed',members:['ss-node1','xraynode','direct01']}],devices:[{id:'phone',identifier:'10.20.0.115',routeId:'ss-node1'}],groups:[{id:'site',entries:['example.com'],routeId:'empty'}]});
 const path=join(folder,'config.yaml');writeFileSync(path,yaml,{mode:0o600});
 execFileSync(process.env.FREEDOMGATE_MIHOMO || '/opt/freedomgate/modules/mihomo/v1.19.33/mihomo',['-t','-d',folder,'-f',path],{stdio:'pipe',timeout:15000});
 console.log('Native config: disabled members, empty/mixed groups, immutable Direct and routes validated.');
}finally{rmSync(folder,{recursive:true,force:true});}
