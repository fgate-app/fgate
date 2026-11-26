// Illustrative topology only: no API calls, real addresses or production state.
export function networkArchitectureDemo(scenario='incident') {
 const incident=scenario==='incident';
 const nodes=[
  {id:'laptop',kind:'device',icon:'laptop',name:'MacBook Pro',detail:'192.168.10.24',x:1072,y:126},
  {id:'phone',kind:'device',icon:'phone',name:'iPhone 16',detail:'192.168.10.38',x:1072,y:326},
  {id:'tv',kind:'device',icon:'tv',name:'Living room TV',detail:'192.168.10.52',x:1072,y:526,state:'offline'},
  {id:'lan',kind:'input',icon:'ethernet',name:'Ethernet',detail:'LAN · eth1',x:32,y:426},
  {id:'wifi',kind:'input',icon:'wifi',name:'FreedomGate',detail:'Wi-Fi · wlan0',x:32,y:566},
  {id:'dns',kind:'module',icon:'dns',name:'AdGuard Home',detail:'DNS · :53',x:292,y:526},
  {id:'core',kind:'module',icon:'brand',name:'mihomo',detail:'TUN · Meta',x:292,y:326},
  {id:'xray',kind:'module',icon:'modules',name:'Xray',detail:'VLESS · REALITY',x:292,y:126},
  {id:'web',kind:'rule',icon:'routes',nameKey:'architecture.ruleWeb',detailKey:'architecture.webDomains',x:812,y:126},
  {id:'default',kind:'rule',icon:'routes',nameKey:'architecture.ruleDefault',detailKey:'architecture.allOther',x:812,y:326},
  {id:'media',kind:'rule',icon:'routes',nameKey:'architecture.ruleMedia',detail:'youtube.com · +4',x:812,y:526,state:incident?'blocked':'healthy'},
  {id:'berlin',kind:'gateway',icon:'public',name:'Berlin',detail:'Proxy · VLESS / REALITY',country:'DE',x:552,y:126},
  {id:'direct',kind:'gateway',icon:'public',nameKey:'architecture.direct',detail:'Direct · TCP / UDP',country:'RU',x:552,y:326},
  {id:'amsterdam',kind:'gateway',icon:'public',name:'Amsterdam',detail:'Proxy · Shadowsocks',country:'NL',x:552,y:526,state:incident?'error':'healthy',statusKey:incident?'architecture.unreachable':null},
  {id:'backup',kind:'gateway',icon:'public',name:'Helsinki',detail:'VPN · WireGuard',country:'FI',x:552,y:706,state:'disabled'},
  {id:'wan',kind:'output',icon:'ethernet',name:'Ethernet',detail:'WAN · eth0',x:32,y:126},
  {id:'wanBackup',kind:'output',icon:'wifi',name:'Wi-Fi',detail:'WAN · wlan1',x:32,y:706,state:'disabled'},
 ];
 const edges=[
  ['wan','core','33.2','1.8'],['wanBackup','core',null,null,'disabled'],
  ['lan','dns','0.02','0.01'],['wifi','dns','0.01','0.01'],['dns','core',null,null],
  ['core','xray',null,null],['xray','berlin','28.1','1.4'],
  ['core','direct','5.1','0.4'],['core','amsterdam',null,null,incident?'error':null],
  ['core','backup',null,null,'disabled'],
  ['berlin','web','28.1','1.4'],['direct','default','5.1','0.4'],
  ['amsterdam','media',incident?'0':'3.2',incident?'0':'0.2',incident?'error':null],
  ['web','laptop','20.1','1.0'],['web','phone','8.0','0.4'],
  ['default','laptop','4.7','0.2'],['default','phone','0.4','0.2'],
  ['default','tv',null,null,'offline'],
  ['media','phone',incident?'0':'3.2',incident?'0':'0.2',incident?'blocked':null],
 ].map(([source,target,download,upload,state],id)=>({id:'edge-'+id,source,target,download,upload,state:state||'healthy'}));
 return {nodes:nodes.map(node=>({state:'healthy',...node})),edges};
}
