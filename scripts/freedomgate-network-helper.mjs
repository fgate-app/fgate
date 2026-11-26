#!/usr/bin/env node
import {createResourceFetch,validDownloadGateways} from '../server/resource-fetch.js';
import {probePathMtu} from '../server/path-mtu.js';
import {hostapdConfig,normalizeStaticLeases,dnsmasqConfig,nftConfig} from '../server/network-config.js';
// Privileged network helper for FreedomGate.
//
// The admin web service runs as the unprivileged `freedomgate` user with
// NoNewPrivileges and an empty capability set, so it cannot touch interfaces,
// hostapd, dnsmasq or nftables directly. This helper is the only root process
// that owns OS-level networking. The web service talks to it over a Unix
// socket; every command is validated here before anything is executed.
//
// Protocol: one JSON object per connection, one JSON response back.
//   {"action":"apply","config":{...}}  -> apply AP/DHCP/NAT/DNS guard
//   {"action":"stop"}                  -> tear the client network down
//   {"action":"status"}                -> report what is currently running
//
// Run as root. Socket path defaults to /run/freedomgate/network.sock.

import {traceEndpointRoute} from '../server/endpoint-route.js';
import {ProxyStrategyHelper,strategyQueue} from '../server/proxy-strategy-helper.js';
import {sniTargets} from '../server/sni-diagnostics.js';
import {dnsMatrixProviders,normalizeDnsMatrixName} from '../server/dns-matrix-catalog.js';
import {replaceDhcpConfig} from '../server/dhcp-config.js';
import {outlineDpiArgs,outlineDpiNft,OUTLINE_DPI_TABLE,OUTLINE_DPI_PRIORITY} from '../server/outline-dpi.js';
import {ModuleUpdates} from '../server/module-updates.js';
import {SystemUpdates} from '../server/system-updates.js';
import { serveHelperConnection } from '../server/helper-protocol.js';
import { createServer } from 'node:net';
import { chmod, chown, mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateNetworkSetup, listInterfaces} from '../server/network.js';
import {runtimeNetworks, multiDnsmasqConfig, multiNftConfig} from '../server/network-runtime.js';
import { canReuseNetwork } from '../server/network-reuse.js';
import { strategyProfiles, portList, udpQueuePorts, zapretBlobArgs } from '../server/zapret.js';

const exec = promisify(execFile);
const RUN_DIR = process.env.FREEDOMGATE_RUN_DIR || '/run/freedomgate';
const SOCKET = join(RUN_DIR, 'network.sock');
const SERVICE_USER = process.env.FREEDOMGATE_SERVICE_USER || 'freedomgate';
const NAT_TABLE = 'freedomgate_nat';
const HOSTAPD_CONF = join(RUN_DIR, 'hostapd.conf');
const DNSMASQ_CONF = join(RUN_DIR, 'dnsmasq.conf');
const NFT_CONF = join(RUN_DIR, 'nft.conf');
const ZAPRET_TABLE = 'freedomgate_zapret';
const ZAPRET_NFT = join(RUN_DIR, 'zapret.nft');
const ZAPRET_PID = join(RUN_DIR, 'nfqws2.pid');
const ZAPRET_MODULE_DIR = process.env.FREEDOMGATE_ZAPRET_DIR || '/opt/freedomgate/modules/zapret2';
const ZAPRET_QNUM = Number(process.env.FREEDOMGATE_ZAPRET_QNUM || 300);
const CURRENT_STATE = join(RUN_DIR, 'current.json');

async function saveCurrent() {
  if (!current) return;
  await writeFile(CURRENT_STATE, JSON.stringify(current)).catch(() => {});
}

async function loadCurrent() {
  try {
    const raw = await readFile(CURRENT_STATE, 'utf8');
    current = JSON.parse(raw);
  } catch { /* fresh start */ }
}

// Remember the applied configuration so `stop` can remove the address.
let current = null;
let zapretCurrent = null;

const IPV4_CIDR = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/;
const IFACE_NAME = /^[a-zA-Z0-9_.:-]{1,15}$/;
const SSID_MAX = 32;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 63;

function fail(message) {
  const error = new Error(message);
  error.userFacing = true;
  return error;
}

function requireInterface(name, label, names) {
  if (!IFACE_NAME.test(String(name || ''))) throw fail(`Invalid interface name "${label}".`);
  if (name === 'lo') throw fail("Loopback cannot be used as an ingress or egress interface.");
  if (!names.includes(name)) throw fail(`Interface "${label}" (${name}) was not found.`);
}

async function interfaceNames() {
  try {
    return await readdir('/sys/class/net');
  } catch {
    throw fail("Failed to read the network interface list.");
  }
}

function parseCidr(value) {
  const match = IPV4_CIDR.exec(String(value || '').trim());
  if (!match) throw fail("Specify the client subnet in IPv4/CIDR format, such as 10.10.0.1/24.");
  const octets = match.slice(1, 5).map(Number);
  if (octets.some(octet => octet > 255)) throw fail("Invalid gateway address.");
  const prefix = Number(match[5]);
  if (prefix < 8 || prefix > 30) throw fail("The subnet prefix must be between /8 and /30.");
  return { address: octets.join('.'), prefix };
}

function validateConfig(config) {
  if (!config || typeof config !== 'object') throw fail("Expected a network configuration object.");
  const uplink = config.uplink?.interface;
  const client = config.client?.interface;
  const clientType = config.client?.type === 'ethernet' ? 'ethernet' : 'ap';
  const subnet = config.client?.subnet;
  const dhcpStart = config.dhcp?.start;
  const dhcpEnd = config.dhcp?.end;
  if (!uplink) throw fail("No ingress interface was specified.");
  if (!client) throw fail("No client interface was specified.");
  if (uplink === client) throw fail("Ingress and egress must use different interfaces.");
  const parsed = parseCidr(subnet);
  if (clientType === 'ap') {
    const ssid = String(config.client?.ssid ?? '');
    const password = String(config.client?.password ?? '');
    if (!ssid.trim() || ssid.length > SSID_MAX) throw fail("SSID must contain between 1 and 32 characters.");
    if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
      throw fail("The Wi-Fi password must contain between 8 and 63 characters.");
    }
  }
  if (!dhcpStart || !dhcpEnd) throw fail("Specify the DHCP range.");
  return { uplink, client, clientType, subnet, dhcpStart, dhcpEnd, ...parsed };
}

async function run(command, args, options = {}) {
  try {
    const result = await exec(command, args, { maxBuffer: 1 << 20, ...options });
    return result.stdout.trim();
  } catch (error) {
    const stderr = String(error.stderr || '').trim();
    const stdout = String(error.stdout || '').trim();
    throw fail(`${command} ${args.join(' ')}: ${stderr || stdout || error.message}`);
  }
}

async function zapretPaths() {
  const managed='/opt/freedomgate/modules/zapret/current';
  if(await readFile(join(managed,'manifest.json')).then(()=>true).catch(()=>false))return {binary:join(managed,'nfqws2'),lua:join(managed,'lua')};
  const entries = await readdir(ZAPRET_MODULE_DIR).catch(() => []);
  const commit = entries.find(entry => /^[0-9a-f]{40}$/.test(entry));
  if (!commit) throw fail("The zapret2 module is not installed.");
  const dir = join(ZAPRET_MODULE_DIR, commit);
  return { binary: join(dir, 'nfqws2'), lua: join(dir, 'lua') };
}

async function zapretNftConfig(settings) {
  let subnet = current?.subnet;
  let uplinkSubnet = current?.uplinkSubnet;
  if (!subnet && current?.client) {
    try {
      const info = await run('ip', ['-4', '-o', 'addr', 'show', 'dev', current.client]);
      const match = /inet (\d+\.\d+\.\d+\.\d+\/\d+)/.exec(info);
      if (match) subnet = match[1];
    } catch {}
  }
  if (!uplinkSubnet && current?.uplink) {
    try {
      const info = await run('ip', ['-4', '-o', 'addr', 'show', 'dev', current.uplink]);
      const match = /inet (\d+\.\d+\.\d+\.\d+\/\d+)/.exec(info);
      if (match) uplinkSubnet = match[1];
    } catch {}
  }
  const skip = [subnet, uplinkSubnet]
    .filter(Boolean)
    .map(cidr => `    ip daddr ${cidr} return\n`)
    .join('');
  const tcp=portList(settings.tcpPorts,'80,443');
  const udp=udpQueuePorts(settings);
  return `table inet ${ZAPRET_TABLE} {
  chain postrouting {
    type filter hook postrouting priority 101; policy accept;
    oifname "lo" return
    meta mark 0x10000007 return
${skip}${settings.http!==false || settings.https!==false ? `    meta mark and 0x50000000 == 0x10000000 tcp dport { ${tcp} } counter queue num ${ZAPRET_QNUM} bypass` : ''}
${udp ? `    meta mark and 0x50000000 == 0x10000000 udp dport { ${udp} } counter queue num ${ZAPRET_QNUM} bypass` : ''}
  }
}
`;
}

async function stopOwnedDaemon(pidfile, executable) {
  try {
    const pid=Number((await readFile(pidfile,'utf8')).trim());
    if(!Number.isInteger(pid)||pid<2)return;
    const command=await readFile(`/proc/${pid}/cmdline`,'utf8');
    if(!command.includes(executable)||!command.includes(RUN_DIR))return;
    await exec('kill',['-TERM',String(pid)]);
    for(let attempt=0;attempt<50;attempt++) {
      try { await readFile(`/proc/${pid}/cmdline`); } catch { return; }
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    throw fail(`Failed to stop ${executable}.`);
  } catch(error) { if(error.code!=='ENOENT')throw error; }
}

const OUTLINE_DPI_PID=join(RUN_DIR,'outline-nfqws2.pid');
let outlineDpiPending=null;
async function stopOutlineDpi(){
 await stopOwnedDaemon(OUTLINE_DPI_PID,'nfqws2');
 await exec('nft',['delete','table','inet',OUTLINE_DPI_TABLE]).catch(()=>{});
 await exec('ip',['rule','del','priority',OUTLINE_DPI_PRIORITY,'fwmark','0x10000007/0xffffffff','lookup','main']).catch(()=>{});
 await unlink(OUTLINE_DPI_PID).catch(()=>{});
}
async function startOutlineDpi(){
 try{
  const pid=Number((await readFile(OUTLINE_DPI_PID,'utf8')).trim());
  const cmd=await readFile(`/proc/${pid}/cmdline`,'utf8');
  if(cmd.includes(OUTLINE_DPI_PID)){
   await run('nft',['list','table','inet',OUTLINE_DPI_TABLE]);
   return {ok:true};
  }
 }catch{}
 const paths=await zapretPaths();
 const [binary,...args]=outlineDpiArgs({...paths,pidfile:OUTLINE_DPI_PID});
 await run(binary,args.filter(arg=>arg!=='--daemon' && !arg.startsWith('--pidfile=')).concat('--dry-run'),{timeout:15000});
 await stopOutlineDpi();
 try{
  await run(binary,args,{timeout:15000});
  const uid=Number(await run('id',['-u',SERVICE_USER]));
  await run('ip',['rule','add','priority',OUTLINE_DPI_PRIORITY,'fwmark','0x10000007/0xffffffff','lookup','main']);
  const nftfile=join(RUN_DIR,'outline-dpi.nft');
  await writeFile(nftfile,outlineDpiNft(uid));
  await run('nft',['-f',nftfile]);
  return {ok:true};
 }catch(error){await stopOutlineDpi().catch(()=>{});throw error;}
}
function ensureOutlineDpi(){
 if(!outlineDpiPending)outlineDpiPending=startOutlineDpi().finally(()=>{outlineDpiPending=null;});
 return outlineDpiPending;
}

async function stopZapret() {
  await stopOwnedDaemon(ZAPRET_PID,'nfqws2');
  await exec('nft', ['delete', 'table', 'inet', ZAPRET_TABLE]).catch(() => {});
  try { await unlink(ZAPRET_PID); } catch { /* not running */ }
  zapretCurrent = null;
}

async function zapretApply(request) {
  const settings = request?.settings && typeof request.settings === 'object' ? request.settings : {};
  const strategy = String(request?.strategy || settings.strategy || 'nfqws2');
  const { binary, lua } = await zapretPaths();
  const args = [
    `--qnum=${ZAPRET_QNUM}`,
    '--daemon',
    `--pidfile=${ZAPRET_PID}`,
    '--fwmark=0x40000000',
    '--bind-fix4',
    '--bind-fix6',
    '--user=root',
    `--lua-init=@${join(lua, 'zapret-lib.lua')}`,
    `--lua-init=@${join(lua, 'zapret-antidpi.lua')}`,
    `--lua-init=@${join(lua, 'zapret-auto.lua')}`,
    ...zapretBlobArgs(),
    ...strategyProfiles(settings, strategy),
  ];
  await run(binary, args.filter(arg=>arg!=='--daemon' && !arg.startsWith('--pidfile=')).concat('--dry-run'), {timeout:15000});
  await stopZapret();
  await run(binary, args, { timeout: 15000 });
  let pid = null;
  for (let i = 0; i < 50; i += 1) {
    try {
      pid = Number(String(await readFile(ZAPRET_PID, 'utf8')).trim());
      if (pid > 0) break;
    } catch { /* not written yet */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!pid) throw fail("nfqws2 did not write its PID file.");
  await writeFile(ZAPRET_NFT, await zapretNftConfig(settings));
  await run('nft', ['-f', ZAPRET_NFT]);
  zapretCurrent = { strategy, settings };
  return { ok: true, strategy, pid };
}

async function zapretProbeUdp() {
  const measuredAt=new Date().toISOString();
  const uplink=current?.uplink;
  if(!uplink || !/^[a-zA-Z0-9_.:-]{1,32}$/.test(uplink))return {ok:true,status:'unmeasured',delay:null,measuredAt};
  try {
    const output=await run('python3',[fileURLToPath(new URL('../server/zapret-udp-probe.py',import.meta.url)),uplink],{timeout:4000});
    const result=JSON.parse(output);
    if(!['ok','timeout','error'].includes(result.status) || (result.status==='ok' && (!Number.isInteger(result.delay) || result.delay<1)))throw Error('Invalid UDP result');
    return {ok:true,...result,measuredAt};
  }catch{return {ok:true,status:'error',delay:null,measuredAt};}
}

let uplinkProbeRunning=false;
async function diagnosticUplink(signal){
  if(uplinkProbeRunning)return {ok:false,error:'Uplink diagnostics are already running.'};
  if(!current?.uplink || !IFACE_NAME.test(current.uplink))return {ok:false,error:'No applied uplink was found.'};
  uplinkProbeRunning=true;
  try{
    const helperTimeoutMs=18000;
    const output=await run('python3',[fileURLToPath(new URL('../server/uplink-probe.py',import.meta.url)),current.uplink],{timeout:helperTimeoutMs,signal,killSignal:'SIGKILL'});
    const value=JSON.parse(output);return {...value,limits:{...(value.limits || {}),helperTimeoutMs}};
  }finally{uplinkProbeRunning=false;}
}

async function zapretStatus() {
  let running = false;
  try {
    const pid = Number(String(await readFile(ZAPRET_PID, 'utf8')).trim());
    if (pid > 0) {
      await exec('kill', ['-0', String(pid)]);
      running = true;
    }
  } catch { /* not running */ }
  let nftables = false;
  try {
    await exec('nft', ['list', 'table', 'inet', ZAPRET_TABLE]);
    nftables = true;
  } catch { /* absent */ }
  return { ok: true, running, nftables, strategy: zapretCurrent?.strategy || null };
}

async function stopNetwork(keepVlans=false) {
  await stopZapret();
  await stopOwnedDaemon(join(RUN_DIR,'hostapd.pid'),'hostapd');
  await stopOwnedDaemon(join(RUN_DIR,'dnsmasq.pid'),'dnsmasq');
  await exec('nft', ['delete', 'table', 'inet', NAT_TABLE]).catch(() => {});
  if (current) {
    for (const network of current.networks || [{interface:current.client,address:current.address,prefix:current.prefix}]) await exec('ip',['addr','del',`${network.address}/${network.prefix}`,'dev',network.interface]).catch(()=>{});
    if(!keepVlans) for(const iface of current.ownedVlans || []) await exec('ip',['link','del',iface]).catch(()=>{});
    current = null;
  }
}

async function daemonRunning(executable) {
  try {
    const pid=Number((await readFile(join(RUN_DIR,executable+'.pid'),'utf8')).trim());
    if(!Number.isInteger(pid)||pid<2)return false;
    const command=await readFile(`/proc/${pid}/cmdline`,'utf8');
    return command.includes(executable) && command.includes(RUN_DIR);
  }catch{return false;}
}

async function applyNetwork(config) {
  const validated = validateNetworkSetup(config, listInterfaces());
  const networks = runtimeNetworks(validated);
  const primary = networks[0];
  const parsed = {...validateConfig({...validated,client:{...validated.client,interface:primary.interface}}),
    ...(networks.length>1 || primary.vlanId ? {networks} : {})};
  const staticLeases = normalizeStaticLeases(config.staticLeases);
  const names = await interfaceNames();
  requireInterface(parsed.uplink, 'ingress', names);
  for (const network of networks) {
    requireInterface(network.parent, 'egress', names);
    if (network.vlanId && names.includes(network.interface)) {
      const links=JSON.parse(await run('ip',['-d','-j','link','show','dev',network.interface]));
      const parent=JSON.parse(await run('ip',['-j','link','show','dev',network.parent]))[0];
      const existing=links[0];
      if(existing?.linkinfo?.info_kind!=='vlan' || existing.linkinfo.info_data.id!==Number(network.vlanId) || existing.link_index!==parent.ifindex)
        throw fail("The VLAN name is already used by another interface.");
    }
  }
  const apConfig=parsed.clientType==='ap'?hostapdConfig(config.client.ssid,config.client.password,parsed.client):null;
  if(await canReuseNetwork({current,parsed,apConfig,
    savedApConfig:await readFile(HOSTAPD_CONF,'utf8').catch(()=>null),daemonRunning,run})) {
    // Refresh only the owned firewall transaction when generator rules change.
    // Keep AP, DHCP, addresses and VPN processes intact.
    const expectedNft=parsed.networks?multiNftConfig(networks,parsed.uplink,current.uplinkSubnet):nftConfig(parsed.client,parsed.uplink,parsed.subnet,current.uplinkSubnet);
    const savedNft=await readFile(NFT_CONF,'utf8').catch(()=>null);
    const firewallChanged=expectedNft!==savedNft;
    if(firewallChanged){
      const staged=join(RUN_DIR,'network.refresh.nft');
      await writeFile(staged,`delete table inet ${NAT_TABLE}\n`+expectedNft);
      await run('nft',['--check','-f',staged]);
      await run('nft',['-f',staged]);
      await writeFile(NFT_CONF,expectedNft);
    }
    const expectedDns=parsed.networks?multiDnsmasqConfig(networks,staticLeases):dnsmasqConfig(parsed.client,parsed.address,parsed.dhcpStart,parsed.dhcpEnd,staticLeases);
    const savedDns=await readFile(DNSMASQ_CONF,'utf8').catch(()=>null);
    const result=expectedDns===savedDns?{ok:true,applied:[],unchanged:true}:await applyLeases(staticLeases);
    return {...result,unchanged:result.unchanged && !firewallChanged,applied:[...(result.applied || []),...(firewallChanged?['nftables']:[])],wifiRestarted:false,warnings:[]};
  }

  const previous=current;
  const snapshots=await Promise.all([HOSTAPD_CONF,DNSMASQ_CONF,NFT_CONF].map(path=>readFile(path,'utf8').catch(()=>null)));
  const dnsConfig=parsed.networks?multiDnsmasqConfig(networks,staticLeases):dnsmasqConfig(parsed.client,parsed.address,parsed.dhcpStart,parsed.dhcpEnd,staticLeases);
  const uplinkInfo = await run('ip', ['-4', '-o', 'addr', 'show', 'dev', parsed.uplink]);
  const uplinkMatch = /inet (\d+\.\d+\.\d+\.\d+\/\d+)/.exec(uplinkInfo);
  const uplinkSubnet = uplinkMatch ? uplinkMatch[1] : '';
  const nftRules=parsed.networks?multiNftConfig(networks,parsed.uplink,uplinkSubnet):nftConfig(parsed.client,parsed.uplink,parsed.subnet,uplinkSubnet);
  const stagedDns=join(RUN_DIR,'dnsmasq.next.conf'),stagedNft=join(RUN_DIR,'network.next.nft');
  await writeFile(stagedDns,dnsConfig);
  await writeFile(stagedNft,nftRules);
  await run('dnsmasq',['--test','-C',stagedDns]);
  // A replacement table cannot be checked while the live table already exists.
  // Check the complete transaction without committing it.
  const liveTable=await run('nft',['list','table','inet',NAT_TABLE]).then(()=>true).catch(()=>false);
  await writeFile(stagedNft,(liveTable?`delete table inet ${NAT_TABLE}\n`:'')+nftRules);
  await run('nft',['--check','-f',stagedNft]);
  const ownedVlans = current?.ownedVlans || [];
  // Keep VLAN links during reconfiguration; only addresses owned by this
  // service are removed. The physical uplink is never flushed or taken down.
  await stopNetwork(true);
  const createdVlans = [];
  try {
    for (const network of networks) {
      if(network.vlanId) await run('ip',['link','set',network.parent,'up']);
      if (network.vlanId && !names.includes(network.interface)) {
        await run('ip',['link','add','link',network.parent,'name',network.interface,'type','vlan','id',String(network.vlanId)]);
        createdVlans.push(network.interface);
      }
      if(network.type==='ethernet') await exec('nmcli',['device','set',network.interface,'managed','no']).catch(()=>{});
      if (network.type === 'ap') {
        await exec('nmcli',['device','set',network.interface,'managed','no']).catch(()=>{});
        await exec('ip',['link','set',network.interface,'down']).catch(()=>{});
        await exec('iw',['dev',network.interface,'set','type','managed']).catch(()=>{});
      }
      await run('ip',['link','set',network.interface,'up']);
      await run('ip',['addr','replace',`${network.address}/${network.prefix}`,'dev',network.interface]);
    }
  if (parsed.clientType === 'ap') {
    await mkdir(join(RUN_DIR, 'hostapd'), { recursive: true });
    await writeFile(HOSTAPD_CONF, hostapdConfig(config.client.ssid, config.client.password, parsed.client));
    await run('hostapd', ['-B', '-P', '/run/freedomgate/hostapd.pid', HOSTAPD_CONF]);
  }

  await writeFile(DNSMASQ_CONF, dnsConfig);
  await run('dnsmasq', ['-C', DNSMASQ_CONF]);

  await writeFile(NFT_CONF, nftRules);
  await run('nft', ['-f', NFT_CONF]);
  await run('sysctl', ['-w', 'net.ipv4.ip_forward=1']);

  current = { ...parsed, client: parsed.client, address: parsed.address, prefix: parsed.prefix, uplinkSubnet, staticLeases, ownedVlans:[...new Set([...ownedVlans,...createdVlans])].filter(iface=>networks.some(n=>n.interface===iface)) };
  await saveCurrent();
  for(const iface of ownedVlans.filter(iface=>!current.ownedVlans.includes(iface))) await exec('ip',['link','del',iface]).catch(()=>{});
  return { ok: true, applied: ['interface', 'hostapd', 'dnsmasq', 'nftables', 'ip_forward'], warnings: [] };
  } catch(error) {
    await stopOwnedDaemon(join(RUN_DIR,'hostapd.pid'),'hostapd');
    await stopOwnedDaemon(join(RUN_DIR,'dnsmasq.pid'),'dnsmasq');
    await exec('nft',['delete','table','inet',NAT_TABLE]).catch(()=>{});
    for(const network of networks) await exec('ip',['addr','del',`${network.address}/${network.prefix}`,'dev',network.interface]).catch(()=>{});
    for(const iface of createdVlans) await exec('ip',['link','del',iface]).catch(()=>{});
    current=previous;
    try {
      if(previous) {
        for(const network of previous.networks || [{interface:previous.client,address:previous.address,prefix:previous.prefix}]) {
          await run('ip',['link','set',network.interface,'up']);
          await run('ip',['addr','replace',`${network.address}/${network.prefix}`,'dev',network.interface]);
        }
        for(const [index,path] of [HOSTAPD_CONF,DNSMASQ_CONF,NFT_CONF].entries()) if(snapshots[index]!==null) await writeFile(path,snapshots[index]);
        if(previous.clientType==='ap') await run('hostapd',['-B','-P',join(RUN_DIR,'hostapd.pid'),HOSTAPD_CONF]);
        await run('dnsmasq',['-C',DNSMASQ_CONF]);
        await run('nft',['-f',NFT_CONF]);
        await saveCurrent();
      }
    } catch(rollbackError) {throw fail(`${error.message} Network recovery: ${rollbackError.message}`);}
    throw error;
  }
}

async function applyLeases(leases) {
  if (!current) return { ok: true, applied: [], skipped: true };
  const staticLeases = normalizeStaticLeases(leases);
  const expected=current.networks?multiDnsmasqConfig(current.networks,staticLeases):dnsmasqConfig(current.client,current.address,current.dhcpStart,current.dhcpEnd,staticLeases);
  if(expected===await readFile(DNSMASQ_CONF,'utf8').catch(()=>null) && await daemonRunning('dnsmasq'))return {ok:true,applied:[],unchanged:true,leases:staticLeases.length};
  await replaceDhcpConfig(expected,{
    read:()=>readFile(DNSMASQ_CONF,'utf8'),
    validate:async content=>{
      const staged=join(RUN_DIR,'dnsmasq.leases.next.conf');
      await writeFile(staged,content);
      try {await run('dnsmasq',['--test','-C',staged]);}
      finally {await unlink(staged).catch(()=>{});}
    },
    write:content=>writeFile(DNSMASQ_CONF,content),
    stop:()=>stopOwnedDaemon(join(RUN_DIR,'dnsmasq.pid'),'dnsmasq'),
    start:()=>run('dnsmasq',['-C',DNSMASQ_CONF])
  });
  current = { ...current, staticLeases };
  await saveCurrent();
  return { ok: true, applied: ['dnsmasq'], leases: staticLeases.length };
}

async function statusNetwork() {
  const probe = async (command, args) => {
    try {
      await exec(command, args);
      return true;
    } catch {
      return false;
    }
  };
  return {
    ok: true,
    hostapd: await probe('pgrep', ['-f', 'hostapd.*freedomgate']),
    dnsmasq: await probe('pgrep', ['-f', 'dnsmasq.*freedomgate']),
    nftables: await probe('nft', ['list', 'table', 'inet', NAT_TABLE]),
    applied: current,
  };
}

let moduleDownloadGateways=[],moduleBatchTask=null;
const systemUpdates=new SystemUpdates({fetchImpl:createResourceFetch({gateways:()=>moduleDownloadGateways})});
const moduleUpdates=new ModuleUpdates({fetchImpl:createResourceFetch({gateways:()=>moduleDownloadGateways}),restart:async id=>{const zapret=zapretCurrent;await moduleUpdates.restartService(id);if(id==='zapret' && zapret)await zapretApply(zapret);}});
const strategyDiagnostics=new ProxyStrategyHelper({run,paths:zapretPaths,stopDaemon:stopOwnedDaemon,runDir:RUN_DIR});

async function handle(request, {signal} = {}) {
  if(request.action==='diagnostic-mtu')return probePathMtu({address:request.address,interfaceName:current?.uplink,signal});
  if(request.action==='diagnostic-endpoint-route')return traceEndpointRoute({addresses:request.addresses,port:request.port,interfaceName:current?.uplink,signal});
  if(request.action==='diagnostic-strategy'){if(request.op==='start' && strategyQueue===ZAPRET_QNUM)return {ok:false,reason:'diagnostic-queue-unavailable'};return strategyDiagnostics.handle(request,{signal,interface:current?.uplink});}
  if(request?.action==='modules'){
    if(request.op!=='status' && !moduleUpdates.task)moduleDownloadGateways=validDownloadGateways(request.gateways);
    try{if(request.op==='status'){await systemUpdates.recover();return {ok:true,modules:[...moduleUpdates.snapshot(),systemUpdates.snapshot()]};}if(moduleBatchTask||moduleUpdates.task||systemUpdates.busy)throw Object.assign(fail('Wait for the current update to finish.'),{status:409});if(request.op==='check' && request.id===undefined){moduleBatchTask=(async()=>{if(systemUpdates.supported)await systemUpdates.check();moduleUpdates.start('check');await moduleUpdates.task;})().catch(()=>systemUpdates.set({state:'error',error:'Could not check for system updates.'}).catch(()=>{})).finally(()=>{moduleBatchTask=null;});return {ok:true,accepted:true};}if(request.id==='system')return systemUpdates.start(request.op,request.version);return moduleUpdates.start(request.op,request.id,request.version);}
    catch(error){return {ok:false,status:error.status || 500,error:error.message};}
  }
  const action = String(request?.action || '');
  if(action==='diagnostic-sni'){
    if(!current?.uplink || !IFACE_NAME.test(current.uplink))return {ok:false,state:'unavailable',error:'No applied uplink was found.'};
    const name=normalizeDnsMatrixName(request.name);
    const helperTimeoutMs=50000;
    const output=await run('python3',[fileURLToPath(new URL('../server/sni-probe.py',import.meta.url)),current.uplink,JSON.stringify(sniTargets()),name,JSON.stringify(Array.isArray(request.fakeIpRanges)?request.fakeIpRanges:[])],{timeout:helperTimeoutMs,signal,killSignal:'SIGKILL'});
    const value=JSON.parse(output);return {...value,limits:{...(value.limits || {}),helperTimeoutMs}};
  }
  if(action==='diagnostic-dns'){
    if(!current?.uplink || !IFACE_NAME.test(current.uplink))return {ok:false,state:'unavailable',error:'No applied uplink was found.'};
    const name=normalizeDnsMatrixName(request.name),providers=dnsMatrixProviders(request.providers,request.mode==='endpoint'?4:(request.family ?? 4));
    if(request.mode!==undefined && request.mode!=='endpoint')throw fail('Invalid DNS diagnostic mode.');
    if(request.mode==='endpoint'){
      if(providers.length!==1)throw fail('Invalid endpoint DNS provider.');
      const helperTimeoutMs=12000;
      const output=await run('python3',[fileURLToPath(new URL('../server/dns-matrix.py',import.meta.url)),'--endpoint',current.uplink,name,JSON.stringify(providers)],{timeout:helperTimeoutMs,signal,killSignal:'SIGKILL'});
      const value=JSON.parse(output);return {...value,limits:{...(value.limits || {}),helperTimeoutMs}};
    }
    const helperTimeoutMs=40000;
    const output=await run('python3',[fileURLToPath(new URL('../server/dns-matrix.py',import.meta.url)),current.uplink,name,JSON.stringify(providers)],{timeout:helperTimeoutMs,signal,killSignal:'SIGKILL'});
    const value=JSON.parse(output);return {...value,limits:{...(value.limits || {}),helperTimeoutMs}};
  }
  if(action==='diagnostic-endpoint'){
    const {addresses,port}=request;
    if(request.capture!==undefined && typeof request.capture!=='boolean')throw fail('Invalid TCP capture option.');
    if(!current?.uplink || !IFACE_NAME.test(current.uplink))return {ok:false,state:'unavailable',error:'No applied uplink was found.'};
    if(!Array.isArray(addresses) || addresses.length<1 || addresses.length>8 || addresses.some(address=>typeof address!=='string' || address.length>45 || !/^[a-fA-F0-9:.]+$/.test(address)) || !Number.isInteger(port) || port<1 || port>65535)throw fail('Invalid endpoint probe parameters.');
    const helperTimeoutMs=40000;
    const output=await run('python3',[fileURLToPath(new URL('../server/endpoint_probe.py',import.meta.url)),current.uplink,JSON.stringify({addresses,port,capture:request.capture===true})],{timeout:helperTimeoutMs,signal,killSignal:'SIGKILL'});
    const value=JSON.parse(output);return {...value,limits:{...(value.limits || {}),helperTimeoutMs}};
  }
  if(action==='diagnostic-socket'){
    const {pid,address,port,processStartedAt,inodes}=request;
    if(!Number.isInteger(pid) || pid<2 || !Number.isInteger(port) || port<1 || port>65535 ||
       typeof address!=='string' || address.length>45 || !/^[a-fA-F0-9:.]+$/.test(address))throw fail('Invalid socket observation parameters.');
    if(typeof processStartedAt!=='string' || !/^\d{1,20}$/.test(processStartedAt) || !Array.isArray(inodes) || inodes.length>1024 || inodes.some(inode=>typeof inode!=='string' || !/^\d{1,20}$/.test(inode)))throw fail('Invalid socket identity.');
    const output=await run('python3',[fileURLToPath(new URL('../server/socket-route.py',import.meta.url)),String(pid),address,String(port),SERVICE_USER,JSON.stringify({processStartedAt,inodes})],{timeout:5000,signal,killSignal:'SIGKILL'});
    return JSON.parse(output);
  }
  if(action==='diagnostic-uplink')return diagnosticUplink(signal);
  if (action === 'outline-dpi') return ensureOutlineDpi();
  if (action === 'apply') return applyNetwork(request.config);
  if (action === 'leases') return applyLeases(request.leases);
  if (action === 'stop') {
    await stopNetwork();
    return { ok: true, applied: [] };
  }
  if (action === 'status') return statusNetwork();
  if (action === 'zapret') {
    const op = String(request?.op || '');
    if (op === 'apply') return zapretApply(request);
    if (op === 'stop') {
      await stopZapret();
      return { ok: true };
    }
    if (op === 'status') return zapretStatus();
    if (op === 'probe-udp') return zapretProbeUdp();
    throw fail("Unknown zapret operation.");
  }
  if (action === 'system') {
    const command = String(request?.system || '');
    if (command === 'config') {
      await run('systemctl', ['restart', 'freedomgate.service']);
      return { ok: true };
    }
    if (['reboot','poweroff'].includes(command) && process.env.FREEDOMGATE_CONTAINER==='1')throw fail("Use Docker to restart or stop the container.");
    if (command === 'reboot') {
      await run('systemctl', ['reboot', '--no-block']);
      return { ok: true };
    }
    if (command === 'poweroff') {
      await run('systemctl', ['poweroff', '--no-block']);
      return { ok: true };
    }
    throw fail("Unknown system action.");
  }
  throw fail(`Unknown action "${action}".`);
}

async function main() {
  await systemUpdates.recover();
  await moduleUpdates.recover();
  await mkdir(RUN_DIR, { recursive: true });
  await strategyDiagnostics.recover();
  await loadCurrent();
  try {
    await unlink(SOCKET);
  } catch {
    // first start, nothing to remove
  }
  const server = createServer({ allowHalfOpen: true }, socket => serveHelperConnection(socket,handle));
  server.listen(SOCKET, async () => {
    try {
      const uid = Number(await run('id', ['-u', SERVICE_USER]));
      const gid = Number(await run('id', ['-g', SERVICE_USER]));
      await chmod(SOCKET, 0o660);
      await chown(SOCKET, uid, gid);
    } catch (error) {
      console.error(`FreedomGate network helper: Failed to set socket permissions: ${error.message}`);
    }
    console.log(`FreedomGate network helper: ${SOCKET}`);
    if(moduleUpdates.interrupted.length)exec('systemctl',['restart','freedomgate.service']).catch(()=>{});
  });
  const shutdown = async () => {
    console.log('FreedomGate network helper: shutting down...');
    await strategyDiagnostics.stop().catch(()=>{});
    await stopOutlineDpi().catch(()=>{});
    await stopNetwork().catch(() => {});
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch(error => {
  console.error(`FreedomGate network helper: ${error.message}`);
  process.exit(1);
});
