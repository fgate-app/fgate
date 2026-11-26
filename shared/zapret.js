// Stable packet marks form the contract between mihomo and nfqws2.
export const ZAPRET_MARK = 0x10000000;
export const ZAPRET_PRESETS = Object.freeze([
  {id:'md5sum', code:1, label:'Подмена контрольной суммы'},
  {id:'autottl', code:2, label:'Автоподбор TTL'},
  {id:'ipid', code:3, label:'Подмена IP ID'},
  {id:'tpws2', code:4, label:'Прозрачный прокси, версия 2'},
  {id:'nfqws2', code:5, label:'Перехват пакетов, версия 2'},
  {id:'youtube', code:6, label:'YouTube (TLS + QUIC)'},
].map(preset=>Object.freeze(preset)));

export function normalizeZapretStrategy(value) {
  if(value===undefined || value===null || value==='')return null;
  if(!ZAPRET_PRESETS.some(preset=>preset.id===value))throw new Error("Select a zapret strategy from the list.");
  return value;
}

export function zapretMark(strategy) {
  const value=normalizeZapretStrategy(strategy);
  return ZAPRET_MARK + (ZAPRET_PRESETS.find(preset=>preset.id===value)?.code || 0);
}

// Independent from legacy udpPorts, which continues to select QUIC ports.
export const ZAPRET_UDP_DEFAULTS = Object.freeze({udp:false,udpServicePorts:'3478-3481,5349,19294-19344,50000-65535',udpStrategy:'fake',udpRepeats:6});
