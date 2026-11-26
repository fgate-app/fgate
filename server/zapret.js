import {fileURLToPath} from 'node:url';
import { ZAPRET_PRESETS, ZAPRET_MARK, zapretMark, ZAPRET_UDP_DEFAULTS } from '../shared/zapret.js';
// Strategy planner and autotune harness for zapret.
// A real strategy probe is supplied by the zapret adapter on the target device.
// Without a probe the harness reports that testing is unavailable instead of
// pretending a strategy worked.

export const ZAPRET_STRATEGIES = [
  { id: 'md5sum', mode: 'tpws', protocols: ['http', 'https'], label: 'Подмена контрольной суммы' },
  { id: 'autottl', mode: 'tpws', protocols: ['http', 'https'], label: 'Автоподбор TTL' },
  { id: 'ipid', mode: 'tpws', protocols: ['http', 'https'], label: 'Подмена IP ID' },
  { id: 'tpws2', mode: 'tpws', protocols: ['http', 'https'], label: 'Прозрачный прокси, версия 2' },
  { id: 'nfqws2', mode: 'nfqws', protocols: ['http', 'https', 'quic', 'udp'], label: 'Перехват пакетов, версия 2' },
  { id: 'youtube', mode: 'nfqws', protocols: ['http', 'https', 'quic', 'udp'], label: 'YouTube (TLS + QUIC)' },
];

export const TEST_TARGETS = [
  'youtube.com',
  'rutracker.org',
  'discord.com',
  'telegram.org',
  'wikipedia.org',
  'instagram.com',
];

const MODE_PREFERENCES = {
  auto: ['md5sum', 'autottl', 'ipid', 'tpws2', 'nfqws2', 'youtube'],
  tpws: ['tpws2', 'md5sum', 'autottl', 'ipid'],
  nfqws: ['nfqws2', 'md5sum', 'youtube'],
};

export function normalizeTarget(value) {
  const target = String(value ?? '').trim().toLowerCase();
  if (!target) throw new Error("Specify a domain to check.");
  if (target.length > 253 || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(target)) {
    throw new Error("Specify a valid domain, such as youtube.com.");
  }
  return target;
}

export function candidateStrategies(settings = {}) {
  const protocols = [
    settings.http !== false ? 'http' : null,
    settings.https !== false ? 'https' : null,
    settings.quic !== false ? 'quic' : null,
    settings.udp === true ? 'udp' : null,
  ].filter(Boolean);
  const mode = ['auto', 'tpws', 'nfqws'].includes(settings.mode) ? settings.mode : 'auto';
  const preferred = [...(MODE_PREFERENCES[mode] || MODE_PREFERENCES.auto)];
  if(protocols.includes('udp') && !preferred.includes('nfqws2'))preferred.push('nfqws2');
  return preferred
    .map(id => ZAPRET_STRATEGIES.find(strategy => strategy.id === id))
    .filter(Boolean)
    .filter(strategy => strategy.protocols.some(protocol => protocols.includes(protocol)));
}

export function planStrategy(settings = {}) {
  const candidates = candidateStrategies(settings);
  const chosen = candidates[0] || ZAPRET_STRATEGIES[0];
  return {
    mode: chosen.mode,
    strategy: chosen.id,
    protocols: [
      settings.http !== false ? 'http' : null,
      settings.https !== false ? 'https' : null,
      settings.quic !== false ? 'quic' : null,
      settings.udp === true ? 'udp' : null,
    ].filter(Boolean),
    reason: `Recommended strategy: ${chosen.id}.`,
  };
}

export async function runAutotune(settings, { target, probe = null } = {}) {
  const candidates = candidateStrategies(settings);
  const results = [];
  for (const strategy of candidates) {
    if (typeof probe !== 'function') {
      results.push({ strategy: strategy.id, state: 'unavailable', error: "Strategy testing is unavailable on this host." });
      continue;
    }
    const started = Date.now();
    try {
      const outcome = await probe(strategy, target);
      results.push({
        strategy: strategy.id,
        state: outcome?.ok ? 'ok' : 'fail',
        ms: Date.now() - started,
        error: outcome?.ok ? undefined : outcome?.error || "The strategy did not work.",
      });
    } catch (error) {
      results.push({ strategy: strategy.id, state: 'fail', error: error.message });
    }
  }
  const winner = results.find(result => result.state === 'ok');
  return {
    target,
    results,
    ok: Boolean(winner),
    state: winner ? 'ok' : 'unavailable',
    strategy: winner?.strategy || null,
    mode: winner ? candidates.find(strategy => strategy.id === winner.strategy)?.mode || null : null,
  };
}

// Translate a strategy id into nfqws2 arguments. Each protocol gets its own
// profile; --new separates profiles. The caller prepends the global options
// (queue number, fwmark, lua-init, daemon, pidfile).
// Captured upstream handshakes are pinned with the application so existing
// module installations and subsequent module updates use the same tested data.
export function zapretBlobArgs() {
  return [
    '--blob=fg_tls_google:@'+fileURLToPath(new URL('./zapret-assets/tls_clienthello_www_google_com.bin',import.meta.url)),
    '--blob=fg_quic_google:@'+fileURLToPath(new URL('./zapret-assets/quic_initial_www_google_com.bin',import.meta.url)),
  ];
}

const FAKE = { http: 'fake_default_http', tls: 'fake_default_tls', quic: 'fake_default_quic' };

function desyncArgs(strategyId, proto, settings) {
  if (strategyId === 'custom') {
    const custom = String(settings.customStrategy || '').trim();
    if (custom) return [`--lua-desync=${custom}`];
  }
  if(strategyId==='youtube'){
    if(proto==='quic')return ['--lua-desync=fake:blob=fg_quic_google:repeats=1'];
    // CDN probes fail with the additional fake ClientHello on this path.
    // Split the real handshake without injecting a second TLS identity.
    if(proto==='tls')return ['--lua-desync=multidisorder:pos=1,midsld'];
  }
  if (proto === 'quic') return [`--lua-desync=fake:blob=${FAKE.quic}:repeats=6`];
  const blob = FAKE[proto];
  const seq = proto === 'tls' ? ':tcp_seq=-10000' : '';
  switch (strategyId) {
    case 'md5sum':
      return [`--lua-desync=fake:blob=${blob}:tcp_md5`];
    case 'autottl':
      return [`--lua-desync=fake:blob=${blob}:tcp_md5:ip_autottl=1,1-64`];
    case 'ipid':
      return [`--lua-desync=fake:blob=${blob}:tcp_md5:ip_id=rnd`];
    case 'tpws2':
      return [`--lua-desync=fake:blob=${blob}:tcp_md5${seq}`, '--lua-desync=multidisorder:pos=1,midsld'];
    case 'nfqws2':
    default:
      return [
        `--lua-desync=fake:blob=${blob}:tcp_md5${seq}`,
        proto === 'http' ? '--lua-desync=multisplit:pos=method+2' : '--lua-desync=multisplit:pos=1,midsld',
      ];
  }
}

export function portList(value, fallback) {
  const text=String(value || fallback);
  if(text.length>512)throw new Error("Invalid zapret port list.");
  const ports=text.split(',').map(port=>port.trim());
  for(const port of ports) {
    const match=/^(\d+)(?:-(\d+))?$/.exec(port);
    if(!match || Number(match[1])<1 || Number(match[1])>65535 || (match[2] && (Number(match[2])<Number(match[1]) || Number(match[2])>65535)))throw new Error("Invalid zapret port list.");
  }
  return ports.join(',');
}

export function normalizeUdpSettings(input = {}, defaults = ZAPRET_UDP_DEFAULTS) {
  const value={...ZAPRET_UDP_DEFAULTS,...defaults};
  for(const key of Object.keys(ZAPRET_UDP_DEFAULTS))if(input[key]!==undefined)value[key]=input[key];
  if(typeof value.udp!=='boolean')throw new Error("Invalid UDP switch value.");
  value.udpServicePorts=portList(value.udpServicePorts,ZAPRET_UDP_DEFAULTS.udpServicePorts);
  if(!['fake','fake-quic'].includes(value.udpStrategy))throw new Error("Select a UDP bypass method from the list.");
  const repeats=Number(value.udpRepeats);
  if(value.udpRepeats==='' || !Number.isInteger(repeats) || repeats<1 || repeats>20)throw new Error("UDP repeat count must be between 1 and 20.");
  return {udp:value.udp,udpServicePorts:value.udpServicePorts,udpStrategy:value.udpStrategy,udpRepeats:repeats};
}

// Merge overlapping ranges before generating an nftables set: QUIC and general
// UDP may use the same ports, but each packet must be queued only once.
export function udpQueuePorts(settings = {}) {
  const lists=[];
  if(settings.quic!==false)lists.push(portList(settings.udpPorts,'443'));
  if(settings.udp===true)lists.push(normalizeUdpSettings(settings).udpServicePorts);
  const ranges=lists.flatMap(list=>list.split(',').map(value=>{const [start,end]=value.split('-').map(Number);return [start,end || start];})).sort((a,b)=>a[0]-b[0]);
  const merged=[];
  for(const range of ranges){const last=merged.at(-1);if(last && range[0]<=last[1]+1)last[1]=Math.max(last[1],range[1]);else merged.push([...range]);}
  return merged.map(([start,end])=>start===end?String(start):`${start}-${end}`).join(',');
}

export function strategyArgs(strategyId, settings = {}, {mark} = {}) {
  const id = strategyId === 'custom' || ZAPRET_STRATEGIES.some(strategy => strategy.id === strategyId) ? strategyId : 'nfqws2';
  const tcpPorts = portList(settings.tcpPorts, '80,443');
  const udpPorts = portList(settings.udpPorts, '443');
  const profiles = [];
  if (settings.http !== false) {
    profiles.push([`--filter-tcp=${tcpPorts}`, '--filter-l7=http', '--payload=http_req', ...desyncArgs(id, 'http', settings)]);
  }
  if (settings.https !== false) {
    profiles.push([`--filter-tcp=${tcpPorts}`, '--filter-l7=tls', '--payload=tls_client_hello', ...desyncArgs(id, 'tls', settings)]);
  }
  if (settings.quic !== false) {
    profiles.push([`--filter-udp=${udpPorts}`, '--filter-l7=quic', '--payload=quic_initial', ...desyncArgs(id, 'quic', settings)]);
  }
  if (settings.udp === true) {
    const udp=normalizeUdpSettings(settings);
    // Keep QUIC independent, including when its profile is switched off. The
    // unknown protocol accepts application UDP that nfqws2 cannot identify.
    profiles.push([`--filter-udp=${udp.udpServicePorts}`, '--filter-l7=wireguard,stun,discord,dtls,dht,utp_bt,dns,unknown', '--out-range=-n3', '--payload=all',
      `--lua-desync=fake:blob=${udp.udpStrategy==='fake-quic'?FAKE.quic:'0x00000000'}:payload=all:repeats=${udp.udpRepeats}`]);
  }
  const args = [];
  profiles.forEach((profile, index) => {
    if(mark!==undefined)args.push(`--filter-mark=0x${mark.toString(16)}/0xffffffff`);
    args.push(...profile);
    if (index < profiles.length - 1) args.push('--new');
  });
  return args;
}

// Explicit marks select group presets. Unmarked/default zapret traffic inherits
// the general strategy. Precompile presets so route edits need no daemon restart.
export function strategyProfiles(settings = {}, strategy = settings.strategy || 'nfqws2') {
  const profiles = [
    ...ZAPRET_PRESETS.map(preset=>strategyArgs(preset.id,settings,{mark:zapretMark(preset.id)})),
    strategyArgs(strategy,settings,{mark:ZAPRET_MARK}),
  ].filter(args=>args.length);
  return profiles.flatMap((args,index)=>index ? ['--new',...args] : args);
}
