export function normalizeImportedName(value) {
  if (typeof value !== 'string') return '';
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  let name = '';
  for (const character of clean) {
    if (name.length + character.length > 100) break;
    name += character;
  }
  return name;
}

// URI fragments are labels, not query strings: a literal + remains a +.
export function profileLinkName(value) {
  if (typeof value !== 'string' || !/^(ss|socks5?|vless|vpn|hy2|hysteria2|trojan|vmess|ssr|tuic|hysteria|anytls|http|https|ssh):\/\//i.test(value.trim())) return '';
  const link = value.trim(), marker = link.indexOf('#');
  if (marker < 0) return '';
  try { return normalizeImportedName(decodeURIComponent(link.slice(marker + 1))); }
  catch { return ''; }
}
