import {parseMihomoDocument,nativeLinkPattern,parseMihomoLink} from './mihomo-proxy.js';
// File contents are data: only supported connection records are extracted.
export const CONFIG_LIMIT = 262144;
export function configRecords(text,depth=0) {
  if(depth>3)throw Error('Invalid proxy list.');
  let value = String(text).replace(/^\uFEFF/, '').trim();
  if (!value || value.length > CONFIG_LIMIT) throw new Error("Enter a configuration up to 256 KB.");
  if (/^[A-Za-z0-9+/_=-]+$/.test(value.replace(/\s/g, ''))) {
    try {
      const raw = value.replace(/\s/g, '').replace(/-/g, '+').replace(/_/g, '/');
      const decoded = new TextDecoder('utf-8', {fatal:true}).decode(Uint8Array.from(atob(raw), c=>c.charCodeAt(0))).trim();
      if (/^(ss|vless|socks5?|vpn|hy2|hysteria2):\/\//.test(decoded) || nativeLinkPattern.test(decoded)) value = decoded;
    } catch { /* Fall through to a readable format error. */ }
  }
  if (/^(ss|vless|socks5?|vpn|hy2|hysteria2):\/\//.test(value) || nativeLinkPattern.test(value)) {
    const records=value.split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
    if (records.some(line=>!/^(ss|vless|socks5?|vpn|hy2|hysteria2):\/\/\S+$/.test(line) && !nativeLinkPattern.test(line))) throw new Error("The list contains unsupported connections.");
    if(records.length>200)throw new Error("The file must contain no more than 200 connections.");
    return records;
  }
  if (/^\[Interface\]/mi.test(value) || /^\s*(client|remote\s|<ca>)/m.test(value)) return [value];
  let root;try {root=JSON.parse(value);}catch{/* YAML is parsed below. */}
  if(Array.isArray(root) && root.every(row=>typeof row==='string')){
    if(!root.length || root.length>200)throw Error('Specify one proxy or a list of up to 200 proxies.');
    const records=root.flatMap(row=>configRecords(row,depth+1));
    if(records.length>200)throw Error('The file must contain no more than 200 connections.');
    return records;
  }
  if(root?.mihomo || root?.outbounds || root?.containers)return [value];
  return parseMihomoDocument(value);
}
export function configKind(value) {
  if(nativeLinkPattern.test(value))return parseMihomoLink(value).type;
  try{const node=JSON.parse(value);if(node.mihomo)return node.mihomo.type;}catch{/* Not a JSON record. */}
  if (/^\[Interface\]/mi.test(value)) return 'WireGuard';
  if (/^\s*(client|remote\s|<ca>)/m.test(value)) return 'OpenVPN';
  if(/^(hy2|hysteria2):\/\//i.test(value))return 'Hysteria 2';
  if(value.startsWith('ss://'))return 'Outline';
  if(/^socks5?:\/\//i.test(value))return 'SOCKS5';
  if(value.startsWith('vless://'))return 'VLESS';
  if(value.startsWith('vpn://'))return 'Amnezia';
  return 'JSON';
}
