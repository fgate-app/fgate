import {mdiArrowTopRight} from '@mdi/js';
import {protocolAssets} from '../icons/protocol-assets.js';
// Protocol metadata is independent from monochrome artwork.
const symbol=(id,label,color,path,aliases=[])=>({id,label,color,path,aliases,kind:'symbol',source:'FreedomGate',viewBox:'0 0 24 24'});
export const protocols = [
  {id:'openvpn',label:'OpenVPN',color:'#EA7E20',path:protocolAssets.openvpn.shapes.map(shape=>shape.path).join(' '),kind:'brand',source:'Provided SVG',viewBox:'0 0 24 24',aliases:['ovpn']},
  {id:'wireguard',label:'WireGuard',color:'#88171A',path:protocolAssets.wireguard.shapes.map(shape=>shape.path).join(' '),kind:'brand',source:'Provided SVG',viewBox:'0 0 24 24',aliases:['wg']},
  symbol('sstp','SSTP','#607CC4','M7 9V6a5 5 0 0 1 10 0v3h3v13H4V9h3Zm3 0h4V6a2 2 0 0 0-4 0v3ZM7 13v2h10v-2H7Zm0 4v2h10v-2H7Z'),
  symbol('ss','Shadowsocks','#38A8D8','M2 11 22 2 15 22 11 14 2 11Zm4.8-.2 5.6 2.1 2.1 5.6L18.7 5.3 6.8 10.8Z',['shadowsocks']),
  symbol('ssr','ShadowsocksR','#8A79E8','M2 10 19 2 14 18 10 13 2 10Zm4.6-.2 4.8 1.8 1.8 3.7 2.7-9.2-9.3 3.7ZM17 14h3v2h-3v-2Zm-1 4h6v2h-6v-2Z',['shadowsocksr']),
  symbol('vless','VLESS','#5D91F5','M2 4h4l6 13 6-13h4L12 24 2 4Z'),
  symbol('vmess','VMess','#AB7AE8','M2 3h4l6 12 6-12h4L12 23 2 3Zm8 0h4v5h-4V3Z'),
  symbol('trojan','Trojan','#E49B52','M4 3h16v3l-2 2v7l-6 7-6-7V8L4 6V3Zm4 7v4l4 5 4-5v-4h-2v5h-4v-5H8Z'),
  symbol('hysteria2','Hysteria 2','#DC6EA5','M4 2h4v8h8V2h4v20h-4v-8H8v8H4V2Zm6 2h4v4h-4V4Z',['hy2','hysteria-2']),
  symbol('hysteria','Hysteria','#C17DCD','M4 2h4v8h8V2h4v20h-4v-8H8v8H4V2Z'),
  symbol('tuic','TUIC','#43B7AC','M2 3h20v4h-8v15h-4V7H2V3Z'),
  symbol('socks5','SOCKS5','#86A1BE','M4 2h16v4H8v4h8l4 4v4l-4 4H4v-4h12v-4H4V2Z',['socks','socks-5']),
  symbol('http','HTTP proxy','#6F9EC5','M2 5h9v6H7v2h4v6H2v-4h5v-2H2V5Zm11 0h9v4h-5v2h5v8h-9v-4h5v-2h-5V5Z'),
  symbol('https','HTTPS proxy','#6F9EC5','M7 9V6a5 5 0 0 1 10 0v3h3v13H4V9h3Zm3 0h4V6a2 2 0 0 0-4 0v3Zm1 4v5h2v-5h-2Z'),
  symbol('amneziawg','AmneziaWG','#E2AD50','M1 21 9 3h6l8 18h-5l-2-5H8l-2 5H1Zm9-9h4l-2-5-2 5Z',['awg','amnezia-wg']),
  symbol('zapret','zapret','#8192A9','M8 2h4v6h-4V2Zm0 14h4v6h-4v-6ZM2 11h16.17l-3.58-3.59L16 6l6 6-6 6-1.41-1.41L18.17 13H2v-2Z'),
  symbol('direct','Direct','#5DBB63','M4 11h12l-4-4 1.4-1.4L20 12l-6.6 6.4L12 17l4-4H4v-2Z'),
  symbol('outline','Outline / Shadowsocks','#50AF8E','M3 2h18v20H3V2Zm4 4v12h10V6H7Zm3 3h4v6h-4V9Z'),
  symbol('other','Other / unknown','#8192A9','M3 3h7v7H3V3Zm11 0h7v7h-7V3ZM3 14h7v7H3v-7Zm11 0h7v7h-7v-7Z',['unknown',''])
];
const provided = {
  openvpn:'openvpn',wireguard:'wireguard',ss:'shadowsocks',ssr:'shadowsocks',outline:'shadowsocks',
  vless:'vless',vmess:'vless',socks5:'socks4',trojan:'trojan',tuic:'tuic',http:'http',https:'http'
};
for (const item of protocols) {
  const asset=protocolAssets[provided[item.id]];
  if (asset) Object.assign(item,asset,{path:asset.shapes.map(shape=>shape.path).join(' '),source:'Provided SVG',kind:'provided'});
}
protocols.find(item=>item.id==='ss').aliases.push('ss2022','ss-2022','shadowsocks2022','shadowsocks-2022');
Object.assign(protocols.find(item=>item.id==='direct'),{path:mdiArrowTopRight,source:'Material Design Icons'});
protocols.push({...symbol('socks4','SOCKS4','#86A1BE',protocolAssets.socks4.shapes.map(shape=>shape.path).join(' '),['socks-4']),...protocolAssets.socks4,source:'Provided SVG',kind:'provided'});

// Original monochrome symbols for local Tor and Lantern exits.
for(const [id,label,color] of [['tor','Tor','#7d4698'],['lantern','Lantern','#e5a42a']]){
 const asset=protocolAssets[id];
 protocols.push({...symbol(id,label,color,asset.shapes.map(shape=>shape.path).join(' ')),...asset,source:'FreedomGate SVG'});
}

export function getProtocol(value) {
  const key=String(value ?? '').trim().toLowerCase();
  return protocols.find(p=>p.id===key || p.aliases.includes(key)) || protocols.find(p=>p.id==='other');
}
