import {diagnoseXrayConnection} from './xray-diagnostics.js';
import {expandConnectionGroup} from '../shared/connection-groups.js';
import {releaseModule} from './release-modules.js';
import {LanternSupervisor,lanternBinary} from './lantern/runtime.js';
import {TorSupervisor} from './tor/runtime.js';
import {diagnoseTlsVersions,diagnoseHttp3} from './tls-versions.js';
import {compareTransfer} from './paired-transfer.js';
import {stopManagedProcess} from './managed-process.js';
import {requestLoopbackDns} from './loopback-dns.js';
import {diagnoseProtocols} from './protocol-diagnostics.js';
import {diagnoseSpeed} from './speed-diagnostics.js';
import {normalizeHysteria2} from '../shared/hysteria2.js';
import {diagnoseTransfer} from './transfer-diagnostics.js';
import {diagnoseGatewaySni} from './sni-diagnostics.js';
import {gatewayChainAvailable,gatewayUsesLantern,gatewayUsesTcpOnly} from '../shared/gateway-wrap.js';
import {unusedPort} from './xray.js';
import {locationListeners,createGatewayLocations,gatewayFingerprint} from './gateway-location.js';
import {diagnoseGatewayDns,allocateSourcePort} from './gateway-dns-matrix.js';
import {diagnoseGateway,diagnosticPath} from './gateway-diagnostics.js';
import {observeDiagnostic} from './diagnostic-observer.js';
import {observeGatewaySocket} from './network-helper.js';
import {gatewayEditor} from './gateway-editor.js';
import {managedSocketIdentity} from './managed-socket-identity.js';
import {zapretProbeUdp} from './network-helper.js';
import {moduleBinary} from './module-paths.js';
import {privateNetworks} from './access-points/runtime.js';
import {createUdpTelemetry} from './udp-telemetry.js';
import {SsRelaySupervisor} from './ss-relay.js';
import {trafficState} from './traffic-state.js';
import {createRouteTrafficCollector} from './route-traffic.js';
import {groupRouteRules} from './route-entries.js';
import { zapretMark } from '../shared/zapret.js';
import { XraySupervisor } from './xray.js';
import { randomBytes } from 'node:crypto';
import { createTelemetryCollector } from './proxy-telemetry.js';
import {createHttpHealth} from './http-health.js';
import { spawn } from 'node:child_process';
import net from 'node:net';
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  renameSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { buildMihomoDnsConfig } from './dns-resolvers.js';
import { parseRcode } from './dns-probe.js';

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

// Full config for the managed instance: DNS block from the admin plus a
// loopback-only mixed port. Client traffic is captured by the TUN.
export function buildMihomoConfig(settings, { mixedPort = 7890, dnsPort = 15353, lanSubnets = [], controllerPort = 19090, controllerSecret = randomBytes(32).toString('hex'), onRuleOwners = null, onLocationListeners = null, locationPorts = null, remoteAccessEnabled = false, remoteUsers = [], remotePort = 17990, wrapperEndpoints = new Map() } = {}, routes = { devices: [], groups: [], profiles: [], configs: [] }) {
  routes={...routes,groups:routes.groups.filter(rule=>rule.enabled!==false),devices:routes.devices.filter(rule=>rule.enabled!==false),profiles:routes.profiles.map(profile=>profile.engine==='direct'?{...profile,enabled:true}:profile)};
  lanSubnets=[...new Set([...lanSubnets,...Object.values(routes.bridges || {}).filter(bridge=>net.isIP(bridge.address)).map(bridge=>`${bridge.address}/${net.isIP(bridge.address)===6?128:32}`)])];
  // Disabled wrapping chains reject traffic and must not override the saved DNS mode.
  const torConfigured=routes.profiles.some(profile=>profile.engine==='tor' && gatewayChainAvailable(routes.profiles,profile.id));
  const lanternConfigured=routes.profiles.some(profile=>profile.engine==='lantern' && gatewayChainAvailable(routes.profiles,profile.id));
  const dns = buildMihomoDnsConfig(torConfigured || lanternConfigured?{...settings,enhancedMode:'fake-ip'}:settings).replace(
    'dns:\n  enable: true\n',
    `dns:\n  enable: true\n  listen: 127.0.0.1:${dnsPort}\n`,
  );

  // Proxy definitions
  const proxies = [];
  const proxyGroups = [];
  const proxyTags = new Set();
  const profileMap = new Map(routes.profiles.map(p => [p.id, p]));
  const configMap = new Map(routes.configs.map(c => [c.profile_id, c]));

  for (const p of routes.profiles) {
    if (!p.id || p.enabled===false || p.engine === 'direct') continue;
    const cfg = configMap.get(p.id);
    if (!cfg) continue;

    const tag = `p-${p.id.slice(0,8)}`;
    if(!gatewayChainAvailable(routes.profiles,p.id)){
      proxies.push('  - '+JSON.stringify({name:tag,type:'reject'}));
    } else if (cfg.engine === 'zapret') {
      proxies.push(`  - name: ${tag}`, '    type: direct', '    udp: true', '    routing-mark: 268435456');
    } else if (/^socks5?:\/\//i.test(cfg.config)) {
      const url = /^socks5?:\/\//i.test(cfg.config) ? cfg.config : 'socks5://127.0.0.1:1080';
      const uri = new URL(url);
      const isAuth = uri.username && uri.password;
      proxies.push(
        `  - name: ${tag}`,
        `    type: socks5`,
        `    server: ${JSON.stringify(uri.hostname.replace(/^\[|\]$/g, ''))}`,
        `    port: ${uri.port || 1080}`,
        ...(p.gatewayId?[`    dialer-proxy: p-${p.gatewayId.slice(0,8)}`]:[]),
        ...(isAuth ? [`    username: ${JSON.stringify(decodeURIComponent(uri.username))}`, `    password: ${JSON.stringify(decodeURIComponent(uri.password))}`] : []),
      );
    } else if (cfg.engine === 'mihomo') {
      const saved=JSON.parse(cfg.config),proxy=saved.mihomo || (saved.type==='hysteria2'?normalizeHysteria2(saved):saved);
      proxies.push('  - '+JSON.stringify({...proxy,name:tag,...(p.gatewayId?{'dialer-proxy':`p-${p.gatewayId.slice(0,8)}`}:{})}));
    } else if(cfg.engine==='lantern'){
      const bridge=routes.bridges?.[p.id];if(!bridge)continue;
      proxies.push('  - '+JSON.stringify({name:tag,type:'http',server:'127.0.0.1',port:bridge.port,udp:false,'interface-name':'lo'}));
    } else if ((cfg.engine === 'xray' || cfg.engine === 'outline' || cfg.engine==='tor')) {
      const bridge=routes.bridges?.[p.id];
      if(!bridge)continue;
      proxies.push(`  - name: ${tag}`, '    type: socks5', '    server: 127.0.0.1', `    port: ${bridge.port}`, `    udp: ${cfg.engine==='tor'?'false':cfg.engine==='outline'?(bridge.udp===true?'true':'false'):'true'}`, '    interface-name: lo');
    } else {
      continue;
    }
    proxyGroups.push(
      `  - name: ${tag}-grp`,
      `    type: select`,
      `    proxies:`,
      `      - ${tag}`,
    );
    proxyTags.add(`${tag}-grp`);
  }

  const supportedTags = new Set(proxyTags);
  // Keep unsupported saved profiles visible, but never let a group bypass them via DIRECT.
  const routingProfiles=routes.profiles.map(profile=>profile.diagnosticOnly?{...profile,enabled:false}:profile);
  const routingAvailable=id=>gatewayChainAvailable(routingProfiles,id);
  const groupMembers = new Set([...(routes.connectionGroups || []).flatMap(group => expandConnectionGroup(routes.connectionGroups,group.id)),...routes.profiles.filter(profile=>!routingAvailable(profile.id)).map(profile=>profile.id)]);
  for (const id of groupMembers) {
    const profile = profileMap.get(id);
    const tag = `p-${id.slice(0,8)}-grp`;
    if (!profile || profile.engine === 'direct' || proxyTags.has(tag)) continue;
    proxyGroups.push(`  - name: ${tag}`, '    type: select', '    proxies:', '      - REJECT');
    proxyTags.add(tag);
  }
  const connectionGroupTags = new Map();
  for (const group of routes.connectionGroups || []) {
    const enabled=expandConnectionGroup(routes.connectionGroups,group.id).filter(id=>profileMap.has(id) && routingAvailable(id));
    const tag = `cg-${group.id}`;
    connectionGroupTags.set(group.id, tag);
    const memberTag=id=>profileMap.get(id)?.engine==='direct'?'DIRECT':proxyTags.has(`p-${id.slice(0,8)}-grp`)?`p-${id.slice(0,8)}-grp`:'REJECT';
    const primary=enabled.filter(id=>!['direct','zapret'].includes(profileMap.get(id)?.engine)).map(memberTag);
    const reserve=[...enabled.filter(id=>profileMap.get(id)?.engine==='zapret'),...enabled.filter(id=>profileMap.get(id)?.engine==='direct')].map(memberTag);
    const health=['    url: https://www.gstatic.com/generate_204','    interval: 60','    timeout: 5000','    lazy: false'];
    const primaryTag=reserve.length && primary.length?`${tag}-proxies`:tag;
    if(primary.length || !reserve.length){
      proxyGroups.push(`  - name: ${primaryTag}`,'    type: url-test','    proxies:',...(primary.length?primary:['REJECT']).map(member=>`      - ${member}`),...health,'    tolerance: 30');
    }
    if(reserve.length){
      proxyGroups.push(`  - name: ${tag}`,'    type: fallback','    proxies:',...(primary.length?[primaryTag,...reserve]:reserve).map(member=>`      - ${member}`),...health);
    }
  }

  const overrides = new Set(routes.groups.filter(group=>group.zapretStrategy && routingAvailable(group.routeId || group.route_id) && profileMap.get(group.routeId || group.route_id)?.engine==='zapret').map(group=>group.zapretStrategy));
  for(const strategy of overrides) {
    proxies.push(`  - name: zapret-${strategy}`, '    type: direct', '    udp: true', `    routing-mark: ${zapretMark(strategy)}`);
  }

  // Resolve destinations once so explicit DIRECT rules retain their priority.
  const destination = id => {
    if (id === 'block') return 'REJECT';
    if (connectionGroupTags.has(id)) return connectionGroupTags.get(id);
    const profile = profileMap.get(id);
    if (!profile) return 'REJECT';
    if(!routingAvailable(profile.id))return 'REJECT';
    if (profile.engine === 'direct') return 'DIRECT';
    const tag = `p-${profile.id.slice(0,8)}-grp`;
    return proxyTags.has(tag) ? tag : 'REJECT';
  };
  const rules = [];

  const ruleOwners=[];
  if(lanternConfigured){const lantern=routes.profiles.find(profile=>profile.engine==='lantern' && gatewayChainAvailable(routes.profiles,profile.id)),target=lantern.gatewayId?destination(lantern.gatewayId):'DIRECT';for(const name of ['lantern-headless','lantern-headles']){if(lantern.gatewayId){rules.push(`  - AND,((PROCESS-NAME,${name}),(NETWORK,udp)),REJECT`);ruleOwners.push(null);}rules.push(`  - PROCESS-NAME,${name},${target}`);ruleOwners.push(null);}}
  if(torConfigured){rules.push('  - PROCESS-NAME,tor,DIRECT','  - PROCESS-NAME,lyrebird,DIRECT');ruleOwners.push(null,null);}
  if(remoteAccessEnabled){for(const subnet of privateNetworks){rules.push(`  - AND,((IN-NAME,fg-remote),(IP-CIDR${subnet.includes(':')?'6':''},${subnet})),REJECT`);ruleOwners.push(null);}}
  for (const group of [...routes.groups.filter(group=>(group.routeId || group.route_id)==='block'),...routes.groups.filter(group=>(group.routeId || group.route_id)!=='block').reverse()]) {
    const routeId=group.route_id || group.routeId;
    const target = group.zapretStrategy && routingAvailable(routeId) && profileMap.get(routeId)?.engine==='zapret' ? `zapret-${group.zapretStrategy}` : destination(routeId);
    if (!target) continue;
    const targetRules = rules;
    for (const rule of groupRouteRules(group,target)) {
      targetRules.push('  - '+rule);
      ruleOwners.push({kind:'groups',id:group.id});
      // mihomo skips UDP-incapable proxies. Catch that fallthrough before any
      // later rule (including MATCH,DIRECT), using exactly the same match.
      if(target!=='DIRECT' && target!=='REJECT'){
        const match=rule.slice(0,rule.lastIndexOf(','));
        targetRules.push(`  - AND,((NETWORK,udp),(${match})),REJECT`);
        ruleOwners.push({kind:'groups',id:group.id});
      }
    }
  }

  for (const device of routes.devices) {
    const target = destination(device.route_id || device.routeId);
    const family = net.isIP(device.identifier);
    // MAC identities are resolved to DHCP/static lease IPs by the API.
    if (!target || !family) continue;
    rules.push(`  - SRC-IP-CIDR,${device.identifier}/${family === 6 ? 128 : 32},${target}`);
    ruleOwners.push({kind:'devices',id:device.id});
    if(target!=='DIRECT' && target!=='REJECT'){
      rules.push(`  - AND,((NETWORK,udp),(SRC-IP-CIDR,${device.identifier}/${family === 6 ? 128 : 32})),REJECT`);
      ruleOwners.push({kind:'devices',id:device.id});
    }
  }
  onRuleOwners?.([...ruleOwners,null]);

  const proxySection = proxies.length ? `proxies:\n${proxies.join('\n')}\n` : '';
  const groupSection = proxyGroups.length ? `proxy-groups:\n${proxyGroups.join('\n')}\n` : '';
  const rulesSection = rules.length ? `\n${rules.join('\n')}\n` : '';
  const locations=locationListeners(routes.profiles,routes.configs,supportedTags,controllerSecret,locationPorts?{ports:locationPorts}:{});
  onLocationListeners?.(locations);
  const wrapListeners=[...wrapperEndpoints].filter(([id])=>routes.profiles.some(p=>p.gatewayId===id && p.enabled!==false)).map(([id,entry])=>'  - '+JSON.stringify({name:'fg-wrap-'+id,type:'socks',listen:'127.0.0.1',port:entry.port,udp:true,proxy:routes.profiles.some(p=>p.id===id && p.enabled!==false) && supportedTags.has(`p-${id.slice(0,8)}-grp`)?`p-${id.slice(0,8)}`:'REJECT',users:[{username:entry.username,password:entry.password}]})).join('\n');
  const listenerSection=(wrapListeners?wrapListeners+'\n':'')+(remoteAccessEnabled?'  - name: fg-remote\n    type: socks\n    listen: 127.0.0.1\n    port: '+remotePort+'\n    udp: true\n    users: '+JSON.stringify(remoteUsers)+'\n':'')+locations.map(entry=>'  - '+JSON.stringify({name:'fg-geo-'+entry.id,type:'mixed',udp:true,listen:'127.0.0.1',port:entry.port,proxy:entry.tag,users:[{username:'fg-geo',password:entry.secret}]})).join('\n')+(locations.length?'\n':'');

  return `mixed-port: ${mixedPort}
external-controller: 127.0.0.1:${controllerPort}
secret: ${JSON.stringify(controllerSecret)}
allow-lan: false
bind-address: 127.0.0.1
mode: rule
${torConfigured || lanternConfigured?'find-process-mode: always\n':''}${listenerSection?'listeners:\n'+listenerSection:''}log-level: warning
tun:
  enable: true
  stack: system
  auto-route: true
  auto-detect-interface: true
  mtu: 1500
  dns-hijack:
    - any:53
  route-exclude-address:
    - 192.168.0.0/16
    - 172.16.0.0/12
${lanSubnets.filter(Boolean).map(subnet => `    - ${subnet}`).join('\n')}${lanSubnets.filter(Boolean).length ? '\n' : ''}${proxySection}${groupSection}${dns}rules:${rulesSection}
  - MATCH,DIRECT
`;
}

function tcpOpen(port, timeout = 400) {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port, timeout });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(false));
  });
}

async function dnsRcode(port,timeout=1200) {
 const message=await requestLoopbackDns(port,undefined,{timeout});
 return message?parseRcode(message):null;
}

export class MihomoSupervisor {
  constructor({
    binary = process.env.FREEDOMGATE_MIHOMO || moduleBinary('mihomo','mihomo','/opt/freedomgate/modules/mihomo/v1.19.33/mihomo'),
    stateDir = process.env.FREEDOMGATE_STATE_DIR || '/var/lib/freedomgate',
    mixedPort = Number(process.env.FREEDOMGATE_MIHOMO_PORT || 7890),
    dnsPort = Number(process.env.FREEDOMGATE_MIHOMO_DNS_PORT || 15353),
    lanSubnets = [],
    controllerPort = Number(process.env.FREEDOMGATE_MIHOMO_CONTROLLER_PORT || 19090),
    xray = null,
    ssRelay = null,
    tor = null,
    lantern = null,
  } = {}) {
    this.lantern=lantern || new LanternSupervisor({stateDir});
    this.tor=tor || new TorSupervisor({stateDir});
    this.xray=xray || new XraySupervisor({stateDir});
    this.ssRelay=ssRelay || new SsRelaySupervisor({stateDir});
    this.binary = binary;
    this.dir = join(stateDir, 'mihomo');
    this.configPath = join(this.dir, 'config.yaml');
    this.mixedPort = mixedPort;
    this.dnsPort = dnsPort;
    this.lanSubnets = lanSubnets;
    this.clientResolver=()=>[];
    this.routeTrafficCollector=createRouteTrafficCollector(path=>this.controller(path),{clients:()=>this.clientResolver(),storage:trafficState(join(stateDir,'traffic-totals.json'))});
    this.routeTrafficTimer=null;this.routeTrafficActive=false;
    this.controllerPort = controllerPort;
    this.controllerSecret = randomBytes(32).toString('hex');
    this.httpHealthReporter=()=>{};
    this.httpHealth=createHttpHealth((path,options)=>this.controller(path,options),{report:event=>this.httpHealthReporter(event),transport:profile=>this.httpHealthTransport(profile)});
    this.collectTelemetry = createTelemetryCollector(path => this.controller(path));
    this.collectUdpTelemetry=createUdpTelemetry(profile=>profile.engine==='direct'?this.directUdpEndpoint(profile):profile.engine==='zapret'?{key:'zapret',probe:zapretProbeUdp}:this.ssRelay.entries?.get(profile.id) || this.xray.entries?.get(profile.id));
    this.locationEndpoints=new Map();
    this.locationPorts=new Map();
    this.wrapperEndpoints=new Map();
    this.diagnosticLocationResults=new Map();
    this.gatewayLocations=createGatewayLocations(profile=>this.locationEndpoint(profile));
    this.process = null;
    this.state = existsSync(binary) ? 'stopped' : 'unavailable';
    this.error = null;
    this.appliedAt = null;
    this.dnsRcode = null;
    this._routes = { devices: [], groups: [], profiles: [], configs: [] };
    this.queue = Promise.resolve();
  }

  status() {
    return {
      state: this.state,
      running: Boolean(this.process),
      pid: this.process?.pid || null,
      appliedAt: this.appliedAt,
      error: this.error,
      binary: this.binary,
      configPath: this.configPath,
      mixedPort: this.mixedPort,
      dnsPort: this.dnsPort,
      dnsRcode: this.dnsRcode,
      xray: this.xray.status(),
      ssRelay: this.ssRelay.status(),
      tor:this.tor.status(),
      torInstalled:existsSync(join(releaseModule('tor').root,'tor/tor')),
      lantern:this.lantern.status(),
      lanternInstalled:this.lantern.available?.() ?? existsSync(lanternBinary()),
    };
  }

  // Serialised: two saves in a row must not restart the engine twice in parallel.
  apply(settings) {
    const run = () => this.#apply(settings);
    this.queue = this.queue.then(run, run);
    return this.queue;
  }

  async restore(settings) {
    if (this.state === 'unavailable') return { ok: false, error: 'The mihomo engine was not found.' };
    return this.apply(settings);
  }

  async stop() {
    this.gatewayLocations.stop();
    this.httpHealth.stop();
    this.routeTrafficActive=false;clearTimeout(this.routeTrafficTimer);this.routeTrafficCollector.pause();
    await this.routeTrafficCollector.sample();this.routeTrafficCollector.flush();
    // Cancel bridge restart timers immediately, before waiting for any child.
    await Promise.all([this.#stopChild(),this.xray.stop(),this.ssRelay.stop(),this.tor.stop(),this.lantern.stop()]);
    if (this.state !== 'unavailable') this.state = 'stopped';
  }

  // Store routes so they are included in every config generation.
  setRoutes(devices = [], groups = [], profiles = [], configs = [], connectionGroups = []) {
    this._routes = { devices, groups, profiles, configs, connectionGroups };
  }

  // Reapply with current DNS settings + routes.
  reapply() {
    if (!this._lastSettings) { return Promise.resolve({ ok: false, error: 'DNS settings have not been applied yet.' }); }
    return this.apply(this._lastSettings);
  }

  async watchLogs(onEvent,{signal}={}) {
    if(this.state!=='running')throw Error('Engine unavailable');
    const response=await fetch(`http://127.0.0.1:${this.controllerPort}/logs?level=info`,{headers:{Authorization:`Bearer ${this.controllerSecret}`},signal});
    if(!response.ok || !response.body)throw Error('Log stream unavailable');
    const decoder=new TextDecoder();let buffer='';
    for await(const chunk of response.body){
      buffer+=decoder.decode(chunk,{stream:true});
      let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);try{onEvent(JSON.parse(line));}catch{}}
      if(buffer.length>65536)throw Error('Invalid log stream');
    }
  }
  async blockedRouteRules() {
    const data=await this.controller('/rules');
    const blockRoutes=new Map([...(this._routes.groups || []),...(this._routes.devices || [])].filter(route=>(route.routeId || route.route_id)==='block' && route.enabled!==false).map(route=>[route.id,route]));
    return (data.rules || []).flatMap((rule,index)=>{const owner=this._appliedRuleOwners?.[index],route=owner && blockRoutes.get(owner.id);return rule.proxy==='REJECT' && route?[{type:rule.type,payload:rule.payload,id:route.id,name:route.name || route.identifier || route.id}]:[];});
  }
  async controller(path, {method='GET',body,timeout=3000,signal}={}) {
    const response = await fetch(`http://127.0.0.1:${this.controllerPort}${path}`, {
      method, body:body===undefined?undefined:JSON.stringify(body), headers: {Authorization: `Bearer ${this.controllerSecret}`,'Content-Type':'application/json'}, signal: signal?AbortSignal.any([signal,AbortSignal.timeout(timeout)]):AbortSignal.timeout(timeout),
    });
    if (!response.ok) throw Object.assign(new Error('Mihomo telemetry unavailable'),{status:response.status});
    return method==='DELETE' || response.status===204?null:response.json();
  }
  setHttpHealthReporter(report){this.httpHealthReporter=report;}
  locationEndpoint(profile){
    const endpoint=this.locationEndpoints.get(profile.id);if(!endpoint)return null;
    const transport=this.httpHealthTransport(profile);
    const seen=new Set();let current=profile;
    while(current && !seen.has(current.id)){
      seen.add(current.id);
      if(current.engine==='lantern'){
        const lantern=this.lantern.status()[current.id] || {};
        return {...endpoint,key:endpoint.key+':lantern:'+JSON.stringify([lantern.state,lantern.startedAt]),transportState:transport.state,timeoutMs:30000,ttl:5*60*1000};
      }
      if(current.engine==='tor'){
        const tor=this.tor.status()[current.id] || {};
        return {...endpoint,key:endpoint.key+':tor:'+JSON.stringify([tor.state,tor.mode,tor.startedAt]),transportState:transport.state,timeoutMs:30000,ttl:5*60*1000};
      }
      current=this._routes.profiles.find(row=>row.id===current.gatewayId);
    }
    return endpoint;
  }
  httpHealthTransport(profile){
    const seen=new Set();let current=profile;
    while(current && !seen.has(current.id)){
      seen.add(current.id);
      if(current.engine==='lantern'){
        const state=this.lantern.status()[current.id]?.state;
        return {state:current.enabled===false || ['error','stopped'].includes(state)?'failed':state==='running'?'ready':'connecting',timeout:30000};
      }
      if(current.engine==='tor'){
        const state=this.tor.status()[current.id]?.state;
        return {state:current.enabled===false || ['failed','unavailable','stopped'].includes(state)?'failed':state==='ready'?'ready':'connecting',timeout:20000};
      }
      current=this._routes.profiles.find(row=>row.id===current.gatewayId);
    }
    return {state:'ready'};
  }
  async telemetry(profiles, groups) {
    if (this.state !== 'running') return {available: false, profiles: {}, groups: {}};
    try {
      const result=await this.collectTelemetry(profiles, groups);
      this.gatewayLocations.prune(profiles.map(profile=>profile.id));
      for(const profile of profiles){const metric=result.profiles[profile.id];if(metric){Object.assign(metric,this.httpHealth.get(profile));metric.location=this.gatewayLocations.get(this.diagnosticEnabledIds?.has(profile.id)?{...profile,enabled:true}:profile);const saved=this.diagnosticLocationResults.get(profile.id);if(profile.enabled===false && !this.diagnosticEnabledIds?.has(profile.id) && saved?.key===gatewayFingerprint(profiles,this._routes.configs || [],profile.id))metric.location=saved.value;metric.udp=gatewayUsesTcpOnly(profiles,profile.id)?{status:'unsupported',delay:null}:this.collectUdpTelemetry(profile);if(profile.engine==='lantern')metric.lantern=this.lantern.status()[profile.id];if(profile.engine==='tor')metric.tor=this.tor.status()[profile.id];if(profile.enabled===false){metric.ping=null;metric.httpStatus='disabled';}}}
      for(const group of groups){const metric=result.groups[group.id];if(metric){const selected=result.profiles[metric.selectedId];if(selected)for(const key of ['ping','httpStatus','httpHistory','httpEndpoint','measuredAt'])metric[key]=selected[key];metric.udp=selected?.udp || {status:'unmeasured',delay:null};}}
      return result;
    }
    catch { return {available: false, profiles: {}, groups: {}}; }
  }

  directUdpEndpoint(profile){
    const endpoint=this.locationEndpoints.get(profile.id);
    return endpoint?{port:endpoint.port,kind:'stun',key:`direct:${endpoint.port}:${endpoint.secret}`,auth:{username:'fg-geo',password:endpoint.secret}}:null;
  }

  async checkGatewayConnection(id,options){
    this._diagnosticLocation=null;
    const profile=this._routes.profiles.find(row=>row.id===id);
    if(!profile)throw Error('Gateway is unavailable.');
    const key=gatewayFingerprint(this._routes.profiles.map(row=>({...row,enabled:true})),this._routes.configs || [],id);
    const value=await this.gatewayLocations.refresh(profile,options);
    if(!options?.signal?.aborted && ['ok','unavailable'].includes(value.status))this._diagnosticLocation={id,value,key};
    return value;
  }
  rememberDiagnosticLocation(id,profiles){
    const measured=this._diagnosticLocation;
    if(measured?.id!==id)return;
    this._diagnosticLocation=null;
    if(measured.key!==gatewayFingerprint(profiles.map(row=>({...row,enabled:true})),this._routes.configs || [],id))return;
    this.diagnosticLocationResults.set(id,{key:gatewayFingerprint(profiles,this._routes.configs || [],id),value:measured.value});
  }

  diagnosticControl(id){
    const endpoint=this.locationEndpoints.get(id);
    if(this.state!=='running' || !endpoint)return null;
    const fingerprint=gatewayFingerprint(this._routes.profiles || [],this._routes.configs || [],id);
    return {upstream:{...endpoint,username:'fg-geo',password:endpoint.secret},
      isCurrent:()=>this.state==='running' && this.locationEndpoints.get(id)===endpoint && gatewayFingerprint(this._routes.profiles || [],this._routes.configs || [],id)===fingerprint,
      observe:context=>observeDiagnostic((path,options)=>this.controller(path,options),context)};
  }

  async diagnoseGateway(id,{signal,targets}={}){
    if(this.state!=='running')throw Error('The engine is unavailable.');
    const endpoint=this.locationEndpoints.get(id),fingerprint=gatewayFingerprint(this._routes.profiles || [],this._routes.configs || [],id);
    const report=await diagnoseGateway({id,profiles:this._routes.profiles || [],endpoint,signal,targets,
      observe:context=>observeDiagnostic((path,options)=>this.controller(path,options),context)});
    const selected=this._routes.profiles.find(profile=>profile.id===id);
    if(selected?.engine==='xray' && report.attempts?.length){
      const config=this._routes.configs.find(row=>row.profile_id===id),wrap=selected.gatewayId?this.wrapperEndpoints.get(selected.gatewayId):null;
      if(selected.gatewayId && !wrap)report.xrayConnection={state:'unavailable',reason:'insufficient-evidence',events:[],scope:'isolated-xray-connection'};
      else if(config)report.xrayConnection=await diagnoseXrayConnection({row:{...config,...(wrap?{wrapEndpoint:{...wrap,remoteDns:gatewayUsesTcpOnly(this._routes.profiles,selected.gatewayId)}}:{})},binary:this.xray.binary,target:report.attempts[0].url,signal});
    }
    const outer=report.path.chain.at(-1);
    if(outer && !['direct','zapret'].includes(outer.engine))report.path.externalConnection={state:'unavailable',reason:'peer-not-observable'};
    if(!signal?.aborted && outer && !['direct','zapret'].includes(outer.engine)){
      try{
        const profile=this._routes.profiles.find(row=>row.id===outer.id),config=this._routes.configs.find(row=>row.profile_id===outer.id);
        const {fields}=gatewayEditor({profile,config});
        const entry=outer.engine==='outline'?this.ssRelay.entries.get(outer.id):outer.engine==='xray'?this.xray.entries.get(outer.id):null;
        const address=entry?.address || fields.server,pid=(entry?.process || this.process)?.pid;
        if(net.isIP(address) && pid)report.path.externalConnection=await observeGatewaySocket({signal,pid,address,port:Number(fields.port),...await managedSocketIdentity(pid)});
      }catch{report.path.externalConnection={state:'unavailable',reason:'socket-evidence-unavailable'};}
    }
    if(this.locationEndpoints.get(id)!==endpoint || gatewayFingerprint(this._routes.profiles || [],this._routes.configs || [],id)!==fingerprint){
      report.path.configChanged=true;report.path.engineVerified=false;
      if(report.xrayConnection)report.xrayConnection={state:'unavailable',reason:'configuration-changed',events:[],scope:'isolated-xray-connection'};
      report.path.externalConnection={state:'unavailable',reason:'configuration-changed'};
    }
    return report;
  }

  async diagnoseGatewayDns(id,{signal,...options}={}){
    if(this.state!=='running')throw Error('The engine is unavailable.');
    const endpoint=this.locationEndpoints.get(id);
    const fingerprint=gatewayFingerprint(this._routes.profiles || [],this._routes.configs || [],id);
    const report=await diagnoseGatewayDns({...options,isCurrent:()=>this.locationEndpoints.get(id)===endpoint && gatewayFingerprint(this._routes.profiles || [],this._routes.configs || [],id)===fingerprint,id,profiles:this._routes.profiles || [],endpoint,signal,
      observe:context=>observeDiagnostic((path,request)=>this.controller(path,request),context)});
    if(this.locationEndpoints.get(id)!==endpoint){
      report.path.configChanged=true;report.state='unavailable';
      for(const attempt of report.attempts)attempt.pathObservation={state:'unavailable',reason:'configuration-changed'};
      for(const comparison of report.comparisons)Object.assign(comparison,{state:'incomplete',validResponses:0});
    }
    return report;
  }

  diagnosticEngines(id){
    const chain=diagnosticPath(this._routes.profiles || [],id).chain;
    const executable=(child,binary)=>process.platform==='linux' && child?.pid?`/proc/${child.pid}/exe`:binary;
    const engines=[{id:'mihomo',binary:executable(this.process,this.binary)}];
    for(const profile of chain){
      if(profile.engine==='lantern')engines.push({id:'lantern',binary:executable(this.lantern.entries.get(profile.id)?.child,lanternBinary())});
      const owner=profile.engine==='xray'?this.xray:profile.engine==='outline'?this.ssRelay:null;
      if(owner)engines.push({id:profile.engine,binary:executable(owner.entries.get(profile.id)?.process,owner.binary)});
    }
    return engines;
  }

  async diagnoseHttp3(id,options={}){return this.diagnoseTlsVersions(id,{...options,kind:'h3'});}

  async diagnoseTlsVersions(id,{name,provider,signal,kind='tls'}={}){
    const endpoint=this.locationEndpoints.get(id),fingerprint=gatewayFingerprint(this._routes.profiles,this._routes.configs,id);
    if(!endpoint)return {state:'completed',outcome:'unavailable',reason:'gateway-unavailable',attempts:[]};
    return (kind==='h3'?diagnoseHttp3:diagnoseTlsVersions)({name,endpoint,signal,...(kind==='h3'?{allocatePort:()=>allocateSourcePort('udp')}:{}),isCurrent:()=>this.locationEndpoints.get(id)===endpoint && gatewayFingerprint(this._routes.profiles,this._routes.configs,id)===fingerprint,
      resolve:options=>this.diagnoseGatewayDns(id,{...options,providers:[provider],transports:['tcp']}),observe:context=>observeDiagnostic((path,request)=>this.controller(path,request),context)});
  }

  async compareTransfer(id,{signal,onProgress}={}){
    const direct=this._routes.profiles.find(row=>row.engine==='direct');
    if(!direct || direct.id===id)return {state:'completed',outcome:'unavailable',reason:'direct-control-unavailable',results:[]};
    const ids=[direct.id,id],endpoints=ids.map(key=>this.locationEndpoints.get(key)),fingerprints=ids.map(key=>gatewayFingerprint(this._routes.profiles,this._routes.configs,key));
    return compareTransfer({signal,onProgress,isCurrent:()=>ids.every((key,index)=>this.locationEndpoints.get(key)===endpoints[index] && gatewayFingerprint(this._routes.profiles,this._routes.configs,key)===fingerprints[index]),
      request:(mode,options)=>this.diagnoseTransfer(mode==='direct'?direct.id:id,options)});
  }

  async diagnoseTransfer(id,{signal,targets}={}){
    if(this.state!=='running')throw Error('The engine is unavailable.');
    const endpoint=this.locationEndpoints.get(id),fingerprint=gatewayFingerprint(this._routes.profiles || [],this._routes.configs || [],id);
    return diagnoseTransfer({id,profiles:this._routes.profiles || [],endpoint,signal,targets,
      isCurrent:()=>this.locationEndpoints.get(id)===endpoint && gatewayFingerprint(this._routes.profiles || [],this._routes.configs || [],id)===fingerprint,
      observe:context=>observeDiagnostic((path,request)=>this.controller(path,request),context)});
  }

  async diagnoseProtocols(id,{name,provider,tcpConfirmed,signal}={}){
    if(gatewayUsesLantern(this._routes.profiles,id))return {state:'completed',outcome:tcpConfirmed?'ok':'unavailable',attempts:[],protocols:{tcp:{state:tcpConfirmed?'available':'unconfirmed',evidence:tcpConfirmed?'website-response':null},udp:{state:'unsupported',reason:'lantern-tcp-only'}}};
    if(this._routes.profiles.find(row=>row.id===id)?.engine==='tor')return {state:'completed',outcome:tcpConfirmed?'ok':'unavailable',attempts:[],protocols:{tcp:{state:tcpConfirmed?'available':'unconfirmed',evidence:tcpConfirmed?'website-response':null},udp:{state:'unsupported',reason:'tor-tcp-only'}}};
    return diagnoseProtocols({name,provider,tcpConfirmed,signal,request:options=>this.diagnoseGatewayDns(id,options)});
  }

  async diagnoseSpeed(id,{signal,onProgress}={}){
    if(this.state!=='running')throw Error('The engine is unavailable.');
    const endpoint=this.locationEndpoints.get(id),fingerprint=gatewayFingerprint(this._routes.profiles || [],this._routes.configs || [],id);
    return diagnoseSpeed({id,profiles:this._routes.profiles || [],endpoint,signal,onProgress,
      isCurrent:()=>this.locationEndpoints.get(id)===endpoint && gatewayFingerprint(this._routes.profiles || [],this._routes.configs || [],id)===fingerprint,
      observe:context=>observeDiagnostic((path,request)=>this.controller(path,request),context)});
  }

  async diagnoseGatewaySni(id,{signal,...options}={}){
    if(this.state!=='running')throw Error('The engine is unavailable.');
    const endpoint=this.locationEndpoints.get(id),fingerprint=gatewayFingerprint(this._routes.profiles || [],this._routes.configs || [],id);
    return diagnoseGatewaySni({...options,id,profiles:this._routes.profiles || [],endpoint,signal,
      isCurrent:()=>this.locationEndpoints.get(id)===endpoint && gatewayFingerprint(this._routes.profiles || [],this._routes.configs || [],id)===fingerprint,
      observe:context=>observeDiagnostic((path,request)=>this.controller(path,request),context)});
  }

  setClientResolver(resolve){this.clientResolver=resolve;}
  architecturePaths(){return this.routeTrafficCollector.observations();}
  routeTraffic(){return this.routeTrafficCollector.snapshot();}
  async pollRouteTraffic(){
    await this.routeTrafficCollector.sample();
    if(this.routeTrafficActive){this.routeTrafficTimer=setTimeout(()=>this.pollRouteTraffic(),1000);this.routeTrafficTimer.unref();}
  }

  async #apply(settings) {
    if(!existsSync(this.binary))return this.#applyManaged(settings,{});
    let prepared,ssPrepared,torPrepared,lanternPrepared;
    try{
      const enabledIds=new Set((this._routes.profiles || []).filter(profile=>gatewayChainAvailable(this._routes.profiles,profile.id)).map(profile=>profile.id));
      const wrapped=(this._routes.profiles || []).filter(p=>enabledIds.has(p.id) && p.gatewayId);
      for(const p of wrapped)if(!this.wrapperEndpoints.has(p.gatewayId))this.wrapperEndpoints.set(p.gatewayId,{port:await unusedPort(),username:'fg-wrap',password:randomBytes(32).toString('hex')});
      const activeConfigs=(this._routes.configs || []).filter(config=>enabledIds.has(config.profile_id)).map(config=>{const p=this._routes.profiles.find(p=>p.id===config.profile_id);return {...config,...(p?.gatewayId?{wrapEndpoint:{...this.wrapperEndpoints.get(p.gatewayId),key:gatewayFingerprint(this._routes.profiles,this._routes.configs,p.gatewayId),remoteDns:gatewayUsesTcpOnly(this._routes.profiles,p.gatewayId)}}:{})};});
      torPrepared=await this.tor.prepare(activeConfigs);
      lanternPrepared=await this.lantern.prepare(activeConfigs);
      prepared=await this.xray.prepare(activeConfigs);
      ssPrepared=await this.ssRelay.prepare(activeConfigs);
      const result=await this.#applyManaged(settings,{...prepared.bridges,...ssPrepared.bridges,...torPrepared.bridges,...lanternPrepared.bridges});
      if(result.ok){await prepared.commit();await ssPrepared.commit();await torPrepared.commit();await lanternPrepared.commit();this.httpHealth.start(this._routes.profiles || []);}else{await prepared.rollback();await ssPrepared.rollback();await torPrepared.rollback();await lanternPrepared.rollback();}
      return result;
    }catch(error){
      await prepared?.rollback();
      await ssPrepared?.rollback();
      await torPrepared?.rollback();
      await lanternPrepared?.rollback();
      this.error=error.message?.startsWith('SS Relay') || error.message?.startsWith('Outline SDK') || error.message?.startsWith('Xray') || error.message?.includes('VPN') || error.message?.includes('Bootstrap') || error.message?.includes('Lantern') ? error.message : 'Failed to prepare the Xray connection.';
      return {ok:false,error:this.error};
    }
  }

  async #applyManaged(settings, bridges) {
    if (!existsSync(this.binary)) {
      this.state = 'unavailable';
      this.error = 'The mihomo engine was not found.';
      return { ok: false, error: this.error };
    }
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const candidate = `${this.configPath}.new`;
    let candidateOwners=[],candidateLocations=[];
    writeFileSync(candidate, buildMihomoConfig(settings, { wrapperEndpoints:this.wrapperEndpoints,mixedPort: this.mixedPort, dnsPort: this.dnsPort, lanSubnets: [...this.lanSubnets,...(this.accessPointHosts || [])], remoteAccessEnabled:this.remoteAccessEnabled, remoteUsers:this.remoteAccessUsers || [], controllerPort: this.controllerPort, controllerSecret: this.controllerSecret,onRuleOwners:owners=>{candidateOwners=owners;},locationPorts:this.locationPorts,onLocationListeners:listeners=>{candidateLocations=listeners;} }, {...this._routes,bridges}), { mode: 0o600 });
    chmodSync(candidate, 0o600);
    const validation = await this.#validate(candidate);
    if (!validation.ok) {
      try {
        unlinkSync(candidate);
      } catch {
        /* best effort */
      }
      this.error = `mihomo rejected the configuration: ${validation.output || 'no output'}`;
      return { ok: false, error: this.error };
    }
    const previous = existsSync(this.configPath) ? `${this.configPath}.prev` : null;
    if (previous) {
      copyFileSync(this.configPath, previous);
      chmodSync(previous, 0o600);
    }
    const hot=Boolean(this.process && this.state==='running');
    if(hot && readFileSync(candidate,'utf8')===readFileSync(this.configPath,'utf8')){
      unlinkSync(candidate);this._lastSettings=settings;this._appliedRuleOwners=candidateOwners;this.routeTrafficCollector.setOwners(candidateOwners);return {ok:true,unchanged:true,dnsRcode:this.dnsRcode};
    }
    await this.routeTrafficCollector.sample();
    this.routeTrafficCollector.pause();
    let ready;
    if(hot){
      try{
        await this.controller('/configs?force=true',{method:'PUT',body:{path:candidate}});
        ready=await this.#waitReady();
        if(!ready.ok)throw Error(ready.error);
        renameSync(candidate,this.configPath);
      }catch{
        // No process restart as a fallback: restore the last known working config.
        let restored=false;
        try{await this.controller('/configs?force=true',{method:'PUT',body:{path:this.configPath}});restored=(await this.#waitReady()).ok;}catch{}
        try{unlinkSync(candidate);}catch{}
        this.routeTrafficCollector.setOwners(this._appliedRuleOwners || []);
        this.state=restored?'running':'error';
        this.error=restored?'Failed to apply the configuration. The previous configuration was restored.':'Failed to apply or restore the configuration.';
        return {ok:false,error:this.error};
      }
    }else{
      await this.#stopChild();
      renameSync(candidate,this.configPath);
      this.#spawn(this.configPath);
      ready=await this.#waitReady();
      if(!ready.ok){
        await this.#stopChild();
        if(previous && existsSync(previous)){
          copyFileSync(previous,this.configPath);this.#spawn(this.configPath);
          if((await this.#waitReady()).ok)this.routeTrafficCollector.setOwners(this._appliedRuleOwners || []);
        }
        this.state='error';this.error=ready.error;return {ok:false,error:this.error};
      }
    }
    this._lastSettings=settings;
    this.locationEndpoints=new Map(candidateLocations.map(entry=>[entry.id,entry]));
    this.gatewayLocations.start(this._routes.profiles || []);
    this._appliedRuleOwners=candidateOwners;
    this.routeTrafficCollector.setOwners(candidateOwners);
    if(!this.routeTrafficActive){this.routeTrafficActive=true;this.pollRouteTraffic();}
    this.state = 'running';
    this.dnsRcode = ready.dnsRcode;
    this.appliedAt = new Date().toISOString();
    this.error = ready.dnsRcode === 0 ? null : `DNS resolvers returned code ${ready.dnsRcode}`;
    return { ok: true, dnsRcode: ready.dnsRcode, warning: this.error || undefined };
  }

  #validate(path) {
    return new Promise(resolve => {
      let output = '';
      const child = spawn(this.binary, ['-t', '-d', this.dir, '-f', path], { stdio: ['ignore', 'pipe', 'pipe'] });
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve({ ok: false, output: 'timeout' });
      }, 15000);
      child.stdout.on('data', chunk => (output += chunk));
      child.stderr.on('data', chunk => (output += chunk));
      child.on('error', error => {
        clearTimeout(timer);
        resolve({ ok: false, output: error.code || error.message });
      });
      child.on('exit', code => {
        clearTimeout(timer);
        resolve({ ok: code === 0, output: output.trim().slice(-400) });
      });
    });
  }

  #spawn(path) {
    this.collectTelemetry = createTelemetryCollector(path => this.controller(path));
    const fd = openSync(join(this.dir, 'mihomo.log'), 'a', 0o600);
    const child = spawn(this.binary, ['-d', this.dir, '-f', path], { stdio: ['ignore', fd, fd] });
    closeSync(fd);
    this.process = child;
    child.on('exit', (code, signal) => {
      if (this.process !== child) return;
      this.process = null;
      if (this.state === 'running') {
        this.state = 'error';
        this.error = `mihomo exited (${signal || code})`;
      }
    });
    child.on('error', error => {
      if (this.process !== child) return;
      this.process = null;
      this.state = 'error';
      this.error = error.code || error.message;
    });
  }

  #stopChild() {
    const child=this.process;this.process=null;
    return stopManagedProcess(child);
  }

  async #waitReady(timeout = 8000) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      if (!this.process) return { ok: false, error: 'mihomo did not start' };
      if (await tcpOpen(this.mixedPort)) {
        const rcode = await dnsRcode(this.dnsPort);
        if (rcode !== null) return { ok: true, dnsRcode: rcode };
      }
      await delay(200);
    }
    return { ok: false, error: 'mihomo did not open its DNS or proxy port' };
  }
}
