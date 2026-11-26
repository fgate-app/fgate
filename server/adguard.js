import {stopManagedProcess} from './managed-process.js';
import {requestLoopbackDns} from './loopback-dns.js';
import {normalizeAdGuardSettings} from '../shared/adguard-policy.js';
import {normalizeAdGuardStatistics} from './adguard-statistics.js';
import {moduleBinary} from './module-paths.js';
import { spawn } from 'node:child_process';
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
import { parseAddresses, parseRcode } from './dns-probe.js';

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

const BLOCKED_NAME = 'blocked.example';

// AdGuard Home config. schema_version is required, otherwise the migrator
// tries to upgrade an "old" config and rejects our lists.
export function buildAdGuardConfig({
  listenPort = 53053,
  upstreamPort = 15353,
  webPort = 13000,
  filterUrl = 'https://adguardteam.github.io/HostlistsRegistry/assets/filter_1.txt',
} = {}) {
  return `schema_version: 34
http:
  address: 127.0.0.1:${webPort}
users: []
dns:
  bind_hosts:
    - 0.0.0.0
  port: ${listenPort}
  upstream_dns:
    - 127.0.0.1:${upstreamPort}
  bootstrap_dns:
    - 1.1.1.1
filters:
  - enabled: true
    url: ${filterUrl}
    name: AdGuard DNS filter
    id: 1
user_rules:
  - "||${BLOCKED_NAME}^"
`;
}

// AdGuard writes canonical YAML. Preserve the entire user_rules section as
// emitted by AdGuard, including multiline rule strings, without a YAML runtime
// dependency. All managed network/listener options still come from our builder.
export function preserveAdGuardUserRules(config, previous) {
  function section(lines) {
    const start = lines.findIndex(line => /^user_rules:/.test(line));
    if (start < 0) return null;
    let end = start + 1;
    while (end < lines.length && (!lines[end].trim() || /^[ \t#]/.test(lines[end]))) end++;
    return { start, end };
  }
  const oldLines = previous.split('\n'), newLines = config.split('\n');
  const oldSection = section(oldLines), newSection = section(newLines);
  if (!oldSection || !newSection) return config;
  newLines.splice(newSection.start, newSection.end - newSection.start,
    ...oldLines.slice(oldSection.start, oldSection.end));
  return newLines.join('\n').replace(/\n*$/, '\n');
}

export function preserveAdGuardPolicy(config,previous){
  for(const key of ['filters','whitelist_filters','querylog','safebrowsing','parental','safesearch','blocked_services']){
    const expression=new RegExp('^'+key+':[^\\n]*(?:\\n(?:[ \t].*|#[^\\n]*|))*(?:\\n|$)','m');
    const old=previous.match(expression)?.[0];if(!old)continue;
    if(expression.test(config))config=config.replace(expression,()=>old);else config+='\n'+old;
  }
  return config;
}

export function normalizeAdGuardRule(value) {
  if(typeof value!=='string' || !value.trim() || value.length>2048 || /[\r\n\x00-\x1f]/.test(value))throw new Error("Specify one AdGuard rule of up to 2048 characters.");
  return value.trim();
}

async function query(port,name,timeout=1500) {
 const message=await requestLoopbackDns(port,name,{timeout});
 return message?{rcode:parseRcode(message),addresses:parseAddresses(message)}:null;
}

export class AdGuardSupervisor {
  constructor({
    binary = process.env.FREEDOMGATE_ADGUARD || moduleBinary('adguard','AdGuardHome','/opt/freedomgate/modules/adguard/v0.107.80/AdGuardHome'),
    stateDir = process.env.FREEDOMGATE_STATE_DIR || '/var/lib/freedomgate',
    listenPort = Number(process.env.FREEDOMGATE_ADGUARD_PORT || 53053),
    upstreamPort = Number(process.env.FREEDOMGATE_MIHOMO_DNS_PORT || 15353),
    webPort = Number(process.env.FREEDOMGATE_ADGUARD_WEB_PORT || 13000),
    request = globalThis.fetch,
  } = {}) {
    this.binary = binary;
    this.dir = join(stateDir, 'adguard');
    this.configPath = join(this.dir, 'AdGuardHome.yaml');
    this.listenPort = listenPort;
    this.upstreamPort = upstreamPort;
    this.webPort = webPort;
    this.request = request;
    this.process = null;
    this.state = existsSync(binary) ? 'stopped' : 'unavailable';
    this.error = null;
    this.appliedAt = null;
    this.filtering = false;
    this.queue = Promise.resolve();
  }

  status() {
    return {
      state: this.state,
      running: Boolean(this.process),
      pid: this.process?.pid || null,
      appliedAt: this.appliedAt,
      error: this.error,
      listenPort: this.listenPort,
      upstreamPort: this.upstreamPort,
      filtering: this.filtering,
      binary: this.binary,
      configPath: this.configPath,
    };
  }

  async #control(path, body, timeout=5000, method=body===undefined?'GET':'POST') {
    const response=await this.request(`http://127.0.0.1:${this.webPort}/control/${path}`, {
      method,
      headers:{'Content-Type':'application/json'},
      ...(body===undefined?{}:{body:JSON.stringify(body)}),
      signal:AbortSignal.timeout(timeout),
    });
    if(!response.ok)throw new Error(`AdGuard Home: HTTP ${response.status}`);
    return body===undefined ? response.json() : null;
  }

  async statistics() {
    const cacheLifetime = 30000;
    if (this.statsCache && Date.now() - this.statsCache.time < cacheLifetime) {
      return this.statsCache.value;
    }
    if (this.statsPending) return this.statsPending;

    this.statsPending = (async () => {
      try {
        const value = normalizeAdGuardStatistics(await this.#control('stats'));
        this.statsCache = { time: Date.now(), value };
        return value;
      } catch {
        return { available: false, samples: [] };
      }
    })().finally(() => { this.statsPending = null; });
    return this.statsPending;
  }

  async blockedQueries() {
    if(this.status().state!=='running')throw Error('DNS unavailable');
    if(!this.journalFilters || Date.now()-this.journalFilters.time>60000){
      const data=await this.#control('filtering/status');
      this.journalFilters={time:Date.now(),names:Object.fromEntries((data.filters || []).map(filter=>[String(filter.id),filter.name || filter.url]))};
    }
    const data=await this.#control('querylog?limit=1000&reason=FilteredBlackList&reason=FilteredSafeBrowsing&reason=FilteredParental&reason=FilteredInvalid&reason=FilteredBlockedService');
    return {...data,filters:this.journalFilters.names};
  }

  setSettingsResolver(resolve){this.settingsResolver=resolve;}
  async configuration(){
    const [dns,log]=await Promise.all([this.#control('dns_info'),this.#control('querylog/config')]);
    return normalizeAdGuardSettings({cacheSize:dns.cache_enabled===false?0:dns.cache_size,blockedTtl:dns.blocked_response_ttl,logEnabled:log.enabled,logInterval:log.interval});
  }
  async configure(input){
    const settings=normalizeAdGuardSettings(input),before=await this.configuration(),logBefore=await this.#control('querylog/config');
    const apply=async value=>{
      await this.#control('dns_config',{cache_size:value.cacheSize,cache_enabled:value.cacheSize>0,blocked_response_ttl:value.blockedTtl});
      await this.#control('querylog/config/update',{...logBefore,enabled:value.logEnabled,interval:value.logInterval},5000,'PUT');
    };
    try{await apply(settings);}catch(error){await apply(before).catch(()=>{});throw error;}
    return settings;
  }
  async policySnapshot(){const data=await this.#control('filtering/status');return {filters:data.filters || [],userRules:await this.userRules()};}
  async reconcileFilters(previous,desired){
    const snapshot=await this.policySnapshot(),wanted=new Map();
    for(const source of desired){const old=wanted.get(source.url);wanted.set(source.url,{...source,enabled:source.enabled || old?.enabled || false});}
    for(const source of wanted.values()){
      const existing=snapshot.filters.find(filter=>filter.url===source.url);
      if(!existing)await this.#control('filtering/add_url',{name:source.name || source.url,url:source.url,whitelist:false},30000);
      if(!existing || existing.enabled!==source.enabled || (source.name && existing.name!==source.name))await this.#control('filtering/set_url',{url:source.url,whitelist:false,data:{url:source.url,name:source.name || existing?.name || source.url,enabled:source.enabled}});
    }
    for(const source of snapshot.filters)if(previous.includes(source.url) && !wanted.has(source.url))await this.#control('filtering/remove_url',{url:source.url,whitelist:false});
    this.journalFilters=null;
  }

  async userRules() {
    const data=await this.#control('filtering/status');
    return Array.isArray(data.user_rules) ? data.user_rules.filter(rule=>typeof rule==='string' && rule!==`||${BLOCKED_NAME}^`) : [];
  }

  reconcileUserRules(previous,desired) {
    const change=async()=>{
      const current=await this.userRules();
      const managed=new Set(previous);
      const rules=[...new Set([...current.filter(rule=>!managed.has(rule)),...desired.map(normalizeAdGuardRule)])];
      if(JSON.stringify(rules)!==JSON.stringify(current)) {
        await this.#control('filtering/set_rules',{rules:[`||${BLOCKED_NAME}^`,...rules]});
        await this.#control('cache_clear',{});
      }
      return rules;
    };
    this.queue=this.queue.then(change,change);
    return this.queue;
  }

  apply() {
    const run = () => this.#apply();
    this.queue = this.queue.then(run, run);
    return this.queue;
  }

  async ensure() {
    if (this.state === 'running') return { ok: true };
    return this.apply();
  }

  async restore() {
    if (this.state === 'unavailable') return { ok: false, error: "AdGuard Home was not found." };
    return this.apply();
  }

  async stop() {
    await this.#stopChild();
    if (this.state !== 'unavailable') this.state = 'stopped';
  }

  async #apply() {
    if (!existsSync(this.binary)) {
      this.state = 'unavailable';
      this.error = "AdGuard Home was not found.";
      return { ok: false, error: this.error };
    }
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const candidate = `${this.configPath}.new`;
    let config = buildAdGuardConfig({ listenPort: this.listenPort, upstreamPort: this.upstreamPort, webPort: this.webPort });
    if (existsSync(this.configPath)){const previousConfig=readFileSync(this.configPath,'utf8');config=preserveAdGuardPolicy(preserveAdGuardUserRules(config,previousConfig),previousConfig);}
    writeFileSync(candidate, config, { mode: 0o600 });
    chmodSync(candidate, 0o600);
    const validation = await this.#validate(candidate);
    if (!validation.ok) {
      try {
        unlinkSync(candidate);
      } catch {
        /* best effort */
      }
      this.error = `AdGuard Home rejected the configuration: ${validation.output || "no output"}`;
      return { ok: false, error: this.error };
    }
    const previous = existsSync(this.configPath) ? `${this.configPath}.prev` : null;
    if (previous) {
      copyFileSync(this.configPath, previous);
      chmodSync(previous, 0o600);
    }
    await this.#stopChild();
    renameSync(candidate, this.configPath);
    this.#spawn(this.configPath);
    const ready = await this.#waitReady();
    if (!ready.ok) {
      await this.#stopChild();
      if (previous && existsSync(previous)) {
        copyFileSync(previous, this.configPath);
        this.#spawn(this.configPath);
        await this.#waitReady();
      }
      this.state = 'error';
      this.error = ready.error;
      return { ok: false, error: this.error };
    }
    this.state = 'running';
    if(this.settingsResolver?.())await this.configure(this.settingsResolver());
    this.filtering = ready.filtering;
    this.appliedAt = new Date().toISOString();
    this.error = ready.filtering ? null : "Filtering is unconfirmed: the test domain was not blocked.";
    return { ok: true, filtering: ready.filtering, warning: this.error || undefined };
  }

  #validate(path) {
    return new Promise(resolve => {
      let output = '';
      const child = spawn(this.binary, ['--check-config', '-c', path], { stdio: ['ignore', 'pipe', 'pipe'] });
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
    const fd = openSync(join(this.dir, 'adguard.log'), 'a', 0o600);
    const child = spawn(this.binary, ['--no-check-update', '-c', path, '-w', this.dir], { stdio: ['ignore', fd, fd] });
    closeSync(fd);
    this.process = child;
    child.on('exit', (code, signal) => {
      if (this.process !== child) return;
      this.process = null;
      if (this.state === 'running') {
        this.state = 'error';
        this.error = `AdGuard Home exited (${signal || code})`;
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

  async #waitReady(timeout = 10000) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      if (!this.process) return { ok: false, error: "AdGuard Home did not start" };
      const upstream = await query(this.listenPort, 'example.com');
      if (upstream && upstream.rcode === 0) {
        const blocked = await query(this.listenPort, BLOCKED_NAME);
        const filtering = Boolean(blocked) && (blocked.rcode === 3 || blocked.addresses.includes('0.0.0.0'));
        return { ok: true, filtering };
      }
      await delay(250);
    }
    return { ok: false, error: "AdGuard Home is not responding to DNS queries" };
  }
}
