// Private stdin carries ephemeral credentials. Only generated YAML is returned.
import {readFileSync} from 'node:fs';
import {configRecords} from '../shared/gateway-config.js';
import {Store} from '../server/store.js';
import {buildMihomoConfig} from '../server/mihomo.js';
import {defaultDnsSettings} from '../server/dns-resolvers.js';
const {username,password,multiplexing='MULTIPLEXING_LOW'}=JSON.parse(readFileSync(0,'utf8')),store=new Store(':memory:');
try {
 const profiles=['TCP','UDP'].map(transport=>store.importProfile({value:configRecords(JSON.stringify({proxies:[{name:transport,type:'mieru',server:'127.0.0.1',port:18443,transport,username,password,udp:true,multiplexing,'handshake-mode':'HANDSHAKE_STANDARD'}]}))[0]}));
 let yaml=buildMihomoConfig(defaultDnsSettings,{}, {profiles:store.profiles(),configs:store.db.prepare('SELECT * FROM profile_configs').all(),groups:[],devices:[]});
 yaml=yaml.replace('tun:\n  enable: true','tun:\n  enable: false').replace('dns:\n  enable: true','dns:\n  enable: false').replace('MATCH,DIRECT','MATCH,REJECT');
 const listeners=profiles.map((row,i)=>'  - '+JSON.stringify({name:'mieru-fixture-'+i,type:'socks',listen:'127.0.0.1',port:18080+i,udp:true,proxy:'p-'+row.id.slice(0,8)})).join('\n');
 yaml=yaml.replace('\nlog-level:','\n'+listeners+'\nlog-level:');process.stdout.write(yaml);
} finally {store.close();}
