// Private stdin carries the ephemeral URI; no credentials are printed.
import {readFileSync} from 'node:fs';
import {Store} from '../server/store.js';
import {buildMihomoConfig} from '../server/mihomo.js';
import {defaultDnsSettings} from '../server/dns-resolvers.js';
const store=new Store(':memory:');
try {
  const row=store.importProfile({value:readFileSync(0,'utf8').trim()});
  let yaml=buildMihomoConfig(defaultDnsSettings,{mixedPort:17890,dnsPort:15353,controllerPort:19090},
    {profiles:store.profiles(),configs:store.db.prepare('SELECT * FROM profile_configs').all(),groups:[],devices:[]});
  // Fixture-only: explicit proxy listener, no TUN, no default direct fallback.
  yaml=yaml.replace('tun:\n  enable: true','tun:\n  enable: false').replace('dns:\n  enable: true','dns:\n  enable: false').replace('MATCH,DIRECT','MATCH,REJECT');
  yaml+='\nlisteners:\n  - '+JSON.stringify({name:'hy2-fixture',type:'socks',listen:'127.0.0.1',port:18080,udp:true,proxy:'p-'+row.id.slice(0,8)})+'\n';
  // buildMihomoConfig already emits location listeners; append to that list.
  const extra=yaml.lastIndexOf('\nlisteners:');
  if(yaml.indexOf('\nlisteners:')!==extra){const listener=yaml.slice(extra+'\nlisteners:\n'.length);yaml=yaml.slice(0,extra).replace(/\nlog-level:/,'\n'+listener+'log-level:');}
  process.stdout.write(yaml);
} finally {store.close();}
