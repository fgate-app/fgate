import {expandConnectionGroup} from '../shared/connection-groups.js';
import {readRoutePresets,bindRoutePresets,expandRoutePresets,presentRoutePresets} from './route-presets.js';
import {normalizeTorSettings} from '../shared/tor.js';
import {normalizeMihomoProxy,parseMihomoLink,nativeLinkPattern,mihomoTypes} from '../shared/mihomo-proxy.js';
import {parseHysteria2} from '../shared/hysteria2.js';
import {validateGatewayWrap,gatewayUsesTor,gatewayUsesLantern} from '../shared/gateway-wrap.js';
import {transaction,pruneEvents} from './database.js';
import {normalizeDnsPolicy,hasDnsPolicy,normalizeAdGuardSettings} from '../shared/adguard-policy.js';
import {normalizeNetworkSetup} from '../shared/network.js';
import {createRouteValidation} from '../shared/route-validation.js';
import {normalizeUdpSettings} from './zapret.js';
import {ZAPRET_UDP_DEFAULTS} from '../shared/zapret.js';
import {editGatewayConfig} from './gateway-editor.js';
import {parseWireGuard,parseOpenVPN,normalizeNativeProxy} from './gateway-config.js';
import {configRecords,configKind} from '../shared/gateway-config.js';
import {normalizeSsProfile} from './ss-profile.js';
import {normalizeRouteEntries} from './route-entries.js';
import {profileLinkName,normalizeImportedName} from '../shared/profile-name.js';
import { decodeAmnezia, normalizeXrayProfile } from './xray-profile.js';
import { normalizeZapretStrategy, ZAPRET_PRESETS } from '../shared/zapret.js';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { isIP } from 'node:net';
import { randomUUID } from 'node:crypto';
import { defaultDnsSettings, validateDnsSettings } from './dns-resolvers.js';
import { defaultNetworkSetup, listInterfaces, validateNetworkSetup } from './network.js';

const MAC_PATTERN = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i;
const {normalizeLocalRoute,validDeviceIdentifier}=createRouteValidation(isIP);
export class Store {
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS profiles (id TEXT PRIMARY KEY, name TEXT NOT NULL, protocol TEXT NOT NULL, created_at TEXT NOT NULL, engine TEXT, builtin INTEGER NOT NULL DEFAULT 0); CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS profile_configs (profile_id TEXT PRIMARY KEY, engine TEXT NOT NULL, config TEXT NOT NULL);`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS dns_settings (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS zapret_settings (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);`);
    this.db.exec('CREATE TABLE IF NOT EXISTS filter_rule_state (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)');
    this.db.exec(`CREATE TABLE IF NOT EXISTS network_settings (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);`);
    this.db.exec('CREATE TABLE IF NOT EXISTS system_journal_state (id INTEGER PRIMARY KEY CHECK(id=1), cursor TEXT NOT NULL)');
    this.db.exec(`CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL, actor TEXT, action TEXT NOT NULL, status INTEGER NOT NULL);`);
    if(!this.db.prepare('PRAGMA table_info(events)').all().some(column=>column.name==='detail'))this.db.exec("ALTER TABLE events ADD COLUMN detail TEXT NOT NULL DEFAULT ''");
    this.db.exec(`CREATE TABLE IF NOT EXISTS route_groups (id TEXT PRIMARY KEY, name TEXT NOT NULL, entries TEXT NOT NULL, route_id TEXT, created_at TEXT NOT NULL);`);
    if(!this.db.prepare('PRAGMA table_info(route_groups)').all().some(column=>column.name==='position')) {
      this.db.exec('ALTER TABLE route_groups ADD COLUMN position INTEGER NOT NULL DEFAULT 0');
      // Keep the previous effective priority: explicit blocks, then newest rules.
      this.db.prepare("SELECT id FROM route_groups ORDER BY (route_id='block') DESC,created_at DESC,rowid DESC").all().forEach((row,index)=>this.db.prepare('UPDATE route_groups SET position=? WHERE id=?').run(index,row.id));
    }
    if(!this.db.prepare('PRAGMA table_info(route_groups)').all().some(column=>column.name==='zapret_strategy'))this.db.exec('ALTER TABLE route_groups ADD COLUMN zapret_strategy TEXT');
    this.db.exec(`CREATE TABLE IF NOT EXISTS device_routes (id TEXT PRIMARY KEY, name TEXT NOT NULL, identifier TEXT NOT NULL, route_id TEXT, created_at TEXT NOT NULL);`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS local_routes (id TEXT PRIMARY KEY, alias TEXT NOT NULL UNIQUE, target TEXT NOT NULL, created_at TEXT NOT NULL);`);
    for(const table of ['route_groups','device_routes','local_routes']) {
      if(!this.db.prepare('PRAGMA table_info('+table+')').all().some(column=>column.name==='enabled'))this.db.exec('ALTER TABLE '+table+' ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1');
    }
    if(!this.db.prepare('PRAGMA table_info(route_groups)').all().some(column=>column.name==='dns_policy'))this.db.exec("ALTER TABLE route_groups ADD COLUMN dns_policy TEXT NOT NULL DEFAULT '{}'");
    if(!this.db.prepare('PRAGMA table_info(route_groups)').all().some(column=>column.name==='domain_presets'))this.db.exec("ALTER TABLE route_groups ADD COLUMN domain_presets TEXT NOT NULL DEFAULT '[]'");
    this.db.exec('CREATE TABLE IF NOT EXISTS adguard_settings (id INTEGER PRIMARY KEY CHECK(id=1),value TEXT NOT NULL)');
    if(!this.filterRuleState().bottomPriority){const rows=this.routeGroups(),ordered=[...rows.filter(row=>row.routeId!=='block').reverse(),...rows.filter(row=>row.routeId==='block')];ordered.forEach((row,index)=>this.db.prepare('UPDATE route_groups SET position=? WHERE id=?').run(index,row.id));this.saveFilterRuleState({...this.filterRuleState(),bottomPriority:true});}
    this.pinBlockGroups();
    this.db.exec(`CREATE TABLE IF NOT EXISTS static_leases (mac TEXT PRIMARY KEY, ip TEXT NOT NULL UNIQUE, hostname TEXT, created_at TEXT NOT NULL);`);
    this.db.exec('CREATE TABLE IF NOT EXISTS connection_groups (id TEXT PRIMARY KEY, name TEXT NOT NULL, members TEXT NOT NULL, created_at TEXT NOT NULL)');
    // Migrate databases created before engines existed.
    const columns = this.db.prepare('PRAGMA table_info(profiles)').all().map(column => column.name);
    if (!columns.includes('gateway_id')) this.db.exec('ALTER TABLE profiles ADD COLUMN gateway_id TEXT');
    if (!columns.includes('dpi_bypass')) this.db.exec('ALTER TABLE profiles ADD COLUMN dpi_bypass INTEGER NOT NULL DEFAULT 0');
    if (!columns.includes('enabled')) this.db.exec('ALTER TABLE profiles ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1');
    if (!columns.includes('engine')) this.db.exec('ALTER TABLE profiles ADD COLUMN engine TEXT');
    this.db.prepare("UPDATE profiles SET enabled=1 WHERE engine='direct'").run();
    if (!columns.includes('builtin')) this.db.exec('ALTER TABLE profiles ADD COLUMN builtin INTEGER NOT NULL DEFAULT 0');
    this.db.prepare('INSERT OR IGNORE INTO settings VALUES (1, ?)').run(JSON.stringify({ topology: 'access-point', failurePolicy: 'direct', bootstrapDns: 'uplink', updates: 'confirm', admin: 'local' }));
    // Built-in exits exist by default, are shown in the common list and cannot be deleted.
    const ensureBuiltin = (engine, name, protocol, config) => {
      if (this.db.prepare('SELECT 1 FROM profiles WHERE builtin=1 AND engine=?').get(engine)) return;
      const id = randomUUID();
      this.db.prepare('INSERT INTO profiles (id,name,protocol,created_at,engine,builtin) VALUES (?,?,?,?,?,1)').run(id, name, protocol, new Date().toISOString(), engine);
      if (config) this.db.prepare('INSERT INTO profile_configs VALUES (?,?,?)').run(id, engine, config);
    };
    for(const [engine,name,config] of [['tor','Tor',JSON.stringify(normalizeTorSettings())],['lantern','Lantern','{}']]){
      const existing=this.db.prepare('SELECT id FROM profiles WHERE engine=? ORDER BY builtin DESC,created_at ASC LIMIT 1').get(engine);
      if(existing){this.db.prepare('UPDATE profiles SET builtin=1,name=? WHERE id=?').run(name,existing.id);this.db.prepare('INSERT OR IGNORE INTO profile_configs VALUES (?,?,?)').run(existing.id,engine,config);}
      else{const id=randomUUID();this.db.prepare('INSERT INTO profiles (id,name,protocol,created_at,engine,builtin,enabled) VALUES (?,?,?,?,?,1,0)').run(id,name,engine,new Date().toISOString(),engine);this.db.prepare('INSERT INTO profile_configs VALUES (?,?,?)').run(id,engine,config);}
    }
    ensureBuiltin('zapret', 'Обход DPI', 'socks5', 'socks5://127.0.0.1:1080');
    ensureBuiltin('direct', 'Direct', 'direct', null);
    this.db.prepare("UPDATE profiles SET name='Обход DPI' WHERE builtin=1 AND engine='zapret' AND name='zapret'").run();
    this.refreshDomainPresets({strict:false});
  }
  profiles() { return this.db.prepare("SELECT p.id,p.name,p.protocol,p.created_at AS createdAt,COALESCE(p.engine,c.engine) AS engine,p.builtin,p.enabled,p.dpi_bypass AS dpiBypass,p.gateway_id AS gatewayId FROM profiles p LEFT JOIN profile_configs c ON c.profile_id=p.id ORDER BY p.builtin DESC, CASE p.engine WHEN 'direct' THEN 0 WHEN 'tor' THEN 1 WHEN 'lantern' THEN 2 WHEN 'zapret' THEN 3 ELSE 4 END, p.created_at DESC").all().map(row=>({...row,enabled:row.enabled!==0,dpiBypass:row.engine==='outline' && row.dpiBypass===1})); }
  addProfile(input) {
    if(input.engine==='lantern' || input.protocol==='lantern')throw Error('Lantern is a built-in gateway.');
    if(input.engine==='tor')throw Error('Tor is a built-in gateway.');
    const protocols = [...mihomoTypes, 'sstp', 'lantern', 'other'];
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 100 || !protocols.includes(input.protocol)) throw new Error("Enter a name up to 100 characters and a connection type.");
    const item = { id: randomUUID(), name: input.name.trim(), protocol: input.protocol, createdAt: new Date().toISOString(), engine: input.engine || null, builtin: 0 };
    this.db.prepare('INSERT INTO profiles (id,name,protocol,created_at,engine,builtin) VALUES (?,?,?,?,?,?)').run(item.id, item.name, item.protocol, item.createdAt, item.engine, item.builtin);
    return item;
  }
  previewGatewayChange(input,id=null) {
    const temp=new Store(':memory:');
    try{
      if(id){
        temp.db.exec('DELETE FROM profile_configs; DELETE FROM profiles');
        for(const profile of this.profiles())temp.restoreProfile(this.profileSnapshot(profile.id));
        temp.updateProfile(id,input);
        return [temp.profileSnapshot(id)];
      }
      return temp.importProfiles(input).map(profile=>temp.profileSnapshot(profile.id));
    }finally{temp.close();}
  }
  importProfiles(input) {
    const records=configRecords(input.value);
    const created=[];
    try {
      for(const value of records)created.push(this.importProfile({...input,value,name:records.length===1?input.name:''}));
      return created;
    }catch(error){for(const row of created)this.removeProfile(row.id);throw error;}
  }
  importNativeProfile(input, config) {
    const proxy=normalizeNativeProxy(config);
    this.validateGateway?.({profile:{builtin:0},config:{engine:'mihomo',config:JSON.stringify(proxy)}});
    return transaction(this.db,()=>{
      const item=this.addProfile({name:input.name || proxy.type,protocol:proxy.type,engine:'mihomo'});
      this.db.prepare('INSERT INTO profile_configs VALUES (?,?,?)').run(item.id,'mihomo',JSON.stringify(proxy));
      return item;
    });
  }
  importMihomoProfile(input, node) {
    const proxy=normalizeMihomoProxy(node);
    const config=JSON.stringify({mihomo:proxy});
    this.validateGateway?.({profile:{builtin:0},config:{engine:'mihomo',config}});
    return transaction(this.db,()=>{
      const item=this.addProfile({name:normalizeImportedName(input.name) || normalizeImportedName(node.name) || proxy.type,protocol:proxy.type,engine:'mihomo'});
      this.db.prepare('INSERT INTO profile_configs VALUES (?,?,?)').run(item.id,'mihomo',config);
      return item;
    });
  }
  importProfile(input) {
    const value = typeof input?.value === 'string' ? input.value.trim() : '';
    if (!value) throw new Error("Specify a configuration or link.");
    if (value.length > 262144) throw new Error("The configuration is too large.");
    if(nativeLinkPattern.test(value))return this.importMihomoProfile(input,parseMihomoLink(value));
    const explicitName = typeof input.name === 'string' ? input.name.trim() : '';
    let name = explicitName || profileLinkName(value);
    if (!name && value.startsWith('vpn://')) {
      const metadata=decodeAmnezia(value);
      name=normalizeImportedName(metadata.description) || normalizeImportedName(metadata.name);
    }
    if(configKind(value)==='Hysteria 2')return this.importNativeProfile({...input,name:name || 'Hysteria 2'},parseHysteria2(value));
    if(configKind(value)==='WireGuard')return this.importNativeProfile(input,parseWireGuard(value));
    if(configKind(value)==='OpenVPN')return this.importNativeProfile(input,parseOpenVPN(value,input));
    let engine, protocol, label;
    if (value.startsWith('ss://')) { normalizeSsProfile(value); engine = 'outline'; protocol = 'ss'; label = 'Outline'; }
    else if (/^socks5?:\/\//i.test(value)) { engine = 'socks5'; protocol = 'socks5'; label = 'SOCKS5'; }
    else if (value.startsWith('vless://')) { engine = 'xray'; protocol = 'vless'; label = 'VLESS'; }
    else if (value.startsWith('vpn://')) { engine = 'xray'; protocol = 'vless'; label = 'Amnezia'; }
    else {
      let config;
      try { config = JSON.parse(value); } catch { throw new Error("Unknown format. Supported: proxy links, OpenVPN, WireGuard and Xray JSON."); }
      if(config?.mihomo)return this.importMihomoProfile(input,config.mihomo);
      if(config?.type && !['wireguard','openvpn','hysteria2'].includes(config.type))return this.importMihomoProfile(input,config);
      if(['wireguard','openvpn','hysteria2'].includes(config?.type))return this.importNativeProfile(input,config);
      return this.importXrayProfile({ ...input, name: name || 'VPN' }, config);
    }
    if(engine==='xray')return this.importXrayProfile({name:name || label},normalizeXrayProfile(value));
    this.validateGateway?.({profile:{builtin:0},config:{engine,config:value}});
    return transaction(this.db,()=>{
      const item = this.addProfile({ name: name || label, protocol, engine });
      this.db.prepare('INSERT INTO profile_configs VALUES (?,?,?)').run(item.id, engine, value);
      return { ...item, engine };
    });
  }
  importXrayProfile(input, config) {
    const value=JSON.stringify(normalizeXrayProfile(config));
    if(value.length>262144)throw new Error('Configuration too large.');
    this.validateGateway?.({profile:{builtin:0},config:{engine:'xray',config:value}});
    return transaction(this.db,()=>{
      const item=this.addProfile({...input,protocol:'vless',engine:'xray'});
      this.db.prepare('INSERT INTO profile_configs VALUES (?,?,?)').run(item.id,'xray',value);
      return {...item,engine:'xray'};
    });
  }
  profileSnapshot(id) {
    const profile=this.db.prepare('SELECT * FROM profiles WHERE id=?').get(id);
    return profile ? {profile,config:this.db.prepare('SELECT * FROM profile_configs WHERE profile_id=?').get(id)} : null;
  }
  restoreProfile(snapshot) {
    const {profile,config}=snapshot;
    return transaction(this.db,()=>{
      this.db.prepare('UPDATE profiles SET name=?,protocol=?,engine=?,enabled=?,dpi_bypass=?,gateway_id=? WHERE id=?').run(profile.name,profile.protocol,profile.engine,profile.enabled,profile.engine==='outline' && profile.dpi_bypass===1?1:0,profile.gateway_id || null,profile.id);
      this.db.prepare('DELETE FROM profile_configs WHERE profile_id=?').run(profile.id);
      if(config)this.db.prepare('INSERT INTO profile_configs VALUES (?,?,?)').run(profile.id,config.engine,config.config);
    });
  }
  updateProfile(id,input) {
    if(this.profileSnapshot(id)?.config?.engine==='tor') {
      const old=this.profileSnapshot(id);
      if(input.enabled===true && old.profile.enabled===0 && this.profiles().filter(row=>row.engine==='tor' && row.enabled).length>=4)throw Error('At most four Tor gateways can be enabled.');
      if(input.enabled!==undefined && typeof input.enabled!=='boolean')throw Error('Invalid connection state.');
      if(input.gatewayId)throw Error('Tor cannot be wrapped in another gateway.');
      if(input.value!==undefined || input.fields!==undefined || input.editor!==undefined)throw Error('Invalid Tor settings.');
      const name=input.name===undefined?old.profile.name:input.name;
      if(old.profile.builtin && name!=='Tor')throw Error('Built-in gateway names cannot be changed.');
      if(typeof name!=='string' || !name.trim() || name.length>100)throw Error('Enter a name up to 100 characters and a connection type.');
      const settings=normalizeTorSettings(input.settings ?? JSON.parse(old.config.config));
      this.restoreProfile({profile:{...old.profile,name:name.trim(),enabled:input.enabled===undefined?old.profile.enabled:Number(input.enabled)},config:{...old.config,config:JSON.stringify(settings)}});
      return this.profiles().find(row=>row.id===id);
    }

    const old=this.profileSnapshot(id);if(!old)return null;
    if(old.profile.engine==='lantern'){
      if(input.name!==undefined && input.name!=='Lantern')throw Error('Built-in gateway names cannot be changed.');
      if(input.value!==undefined || input.fields!==undefined || input.editor!==undefined || input.settings!==undefined)throw Error('Lantern routing is managed automatically.');
    }
    if(old.profile.engine==='direct')throw new Error("Direct cannot be edited or disabled.");
    const name=input.name===undefined?old.profile.name:input.name;
    if(typeof name!=='string' || !name.trim() || name.length>100)throw new Error("Specify a name of up to 100 characters.");
    if(input.enabled!==undefined && typeof input.enabled!=='boolean')throw new Error("Invalid connection state.");
    if(input.dpiBypass!==undefined && typeof input.dpiBypass!=='boolean')throw new Error("Invalid DPI bypass state.");
    if(input.editor!==undefined){if(input.value!==undefined)throw new Error("Choose one method of editing the configuration.");input={...input,value:editGatewayConfig(old,input.editor)};}
    let profile=old.profile,config=old.config;
    if(input.value!==undefined && (typeof input.value!=='string' || input.value.trim())) {
      if(old.profile.builtin)throw new Error("The system connection configuration is protected.");
      const temp=new Store(':memory:');
      try {const parsed=temp.importProfile({name,value:input.value,username:input.username,password:input.password});const snapshot=temp.profileSnapshot(parsed.id);profile=snapshot.profile;config=snapshot.config;}
      finally{temp.close();}
    }
    if(!old.profile.builtin && !(input.enabled===false && input.value===undefined && input.editor===undefined))this.validateGateway?.({profile,config});
    if(input.dpiBypass===true && profile.engine!=='outline')throw new Error("DPI bypass is only available for Shadowsocks.");
    const gatewayId=input.gatewayId===undefined?(old.profile.gateway_id || null):input.gatewayId;
    const candidateProfiles=this.profiles().map(p=>p.id===id?{...p,protocol:profile.protocol,engine:profile.engine || config?.engine,gatewayId}:p);
    const affected=new Set([id]);
    for(let size=-1;size!==affected.size;){size=affected.size;for(const row of candidateProfiles)if(affected.has(row.gatewayId))affected.add(row.id);}
    for(const candidate of candidateProfiles.filter(row=>affected.has(row.id))){
      validateGatewayWrap(candidateProfiles,candidate.id,candidate.gatewayId===undefined?null:candidate.gatewayId);
      const candidateConfig=candidate.id===id?config:this.profileSnapshot(candidate.id)?.config;
      if(candidate.gatewayId && candidateConfig?.engine==='mihomo' && candidate.protocol==='openvpn'){
        const native=JSON.parse(candidateConfig.config);
        if((native.mihomo || native).proto!=='tcp' && (gatewayUsesTor(candidateProfiles,candidate.gatewayId)||gatewayUsesLantern(candidateProfiles,candidate.gatewayId)))throw Error('This UDP-only proxy cannot use a TCP-only gateway.');
      }
    }
    this.restoreProfile({profile:{...old.profile,gateway_id:gatewayId,dpi_bypass:profile.engine==='outline'?Number(input.dpiBypass ?? old.profile.dpi_bypass===1):0,name:name.trim(),protocol:profile.protocol,engine:profile.engine,enabled:input.enabled===undefined?old.profile.enabled:Number(input.enabled)},config});
    return this.profiles().find(row=>row.id===id);
  }
  removeProfile(id) {
    const row = this.db.prepare('SELECT builtin FROM profiles WHERE id=?').get(id);
    if (!row) return false;
    if (row.builtin) throw new Error("Built-in gateways cannot be deleted.");
    if(this.db.prepare('SELECT 1 FROM profiles WHERE gateway_id=? LIMIT 1').get(id))throw new Error("This gateway wraps other connections. Update those connections first.");
    if (this.connectionGroups().some(group => group.members.includes(id))) throw new Error("This connection is used by a group. Update the group first.");
    if (this.db.prepare('SELECT 1 FROM route_groups WHERE route_id=? UNION ALL SELECT 1 FROM device_routes WHERE route_id=? LIMIT 1').get(id,id)) throw new Error("This gateway is used by routes. Update or remove those routes first.");
    return transaction(this.db,()=>{
      this.db.prepare('DELETE FROM profile_configs WHERE profile_id=?').run(id);
      const removed=this.db.prepare('DELETE FROM profiles WHERE id=?').run(id).changes>0;
      return removed;
    });
  }

  connectionGroups() {
    return this.db.prepare('SELECT id,name,members,created_at AS createdAt FROM connection_groups ORDER BY created_at DESC').all()
      .map(row => ({...row, members: JSON.parse(row.members)}));
  }
  saveConnectionGroup(id, input) {
    const groups=this.connectionGroups();
    const current = id ? groups.find(group => group.id === id) : null;
    if (id && !current) return null;
    const name = String(input?.name ?? current?.name ?? '').trim();
    if (!name || name.length > 100) throw new Error("Specify a group name of up to 100 characters.");
    const raw = input?.members ?? current?.members;
    if (!Array.isArray(raw) || !raw.length || raw.length > 100 || raw.some(member => typeof member !== 'string')) throw new Error("Select between 1 and 100 connections.");
    const members = [...new Set(raw)];
    const profiles = new Set(this.profiles().map(profile => profile.id));
    const known=new Set([...profiles,...groups.map(group=>group.id)]);
    if (members.some(member => !known.has(member))) throw new Error("Connection or gateway group not found.");
    const group = {id: current?.id || randomUUID(), name, members, createdAt: current?.createdAt || new Date().toISOString()};
    expandConnectionGroup([...groups.filter(row=>row.id!==group.id),group],group.id,{rejectCycles:true});
    this.db.prepare('INSERT INTO connection_groups (id,name,members,created_at) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,members=excluded.members').run(group.id,name,JSON.stringify(members),group.createdAt);
    return group;
  }
  removeConnectionGroup(id) {
    if(this.connectionGroups().some(group=>group.id!==id && group.members.includes(id)))throw new Error('This group is used by another group. Update the parent group first.');
    if (this.db.prepare('SELECT 1 FROM route_groups WHERE route_id=? UNION ALL SELECT 1 FROM device_routes WHERE route_id=? LIMIT 1').get(id,id)) throw new Error("This group is used by routes. Update those routes first.");
    return this.db.prepare('DELETE FROM connection_groups WHERE id=?').run(id).changes > 0;
  }
  hasRoute(id) {
    return Boolean(this.db.prepare('SELECT 1 FROM profiles WHERE id=? UNION ALL SELECT 1 FROM connection_groups WHERE id=?').get(id,id));
  }

  adGuardSettings(){const raw=this.db.prepare('SELECT value FROM adguard_settings WHERE id=1').get()?.value;if(!raw)return null;try{return normalizeAdGuardSettings(JSON.parse(raw));}catch{return normalizeAdGuardSettings();}}
  saveAdGuardSettings(input){const value=normalizeAdGuardSettings(input);this.db.prepare('INSERT INTO adguard_settings VALUES (1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(JSON.stringify(value));return value;}
  readDnsPolicy(row){try{return normalizeDnsPolicy({...JSON.parse(row.dnsPolicy || '{}'),routeId:row.routeId});}catch{return {dnsFilters:[],dnsRules:[]};}}
  pinBlockGroups(){const rows=this.routeGroups();rows.sort((a,b)=>Number(a.routeId==='block')-Number(b.routeId==='block'));rows.forEach((row,index)=>this.db.prepare('UPDATE route_groups SET position=? WHERE id=?').run(index,row.id));}
  filterRuleState() {
    const value=this.db.prepare('SELECT value FROM filter_rule_state WHERE id=1').get()?.value;
    return value ? {...{imported:false,managed:[]},...JSON.parse(value)} : {imported:false,managed:[]};
  }
  saveFilterRuleState(value) {
    this.db.prepare('INSERT INTO filter_rule_state VALUES (1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(JSON.stringify(value));
  }
  groupZapretStrategy(value,routeId) {
    const strategy=normalizeZapretStrategy(value);
    return this.db.prepare('SELECT engine FROM profiles WHERE id=?').get(routeId)?.engine==='zapret' ? strategy : null;
  }
  moveRouteGroup(id, direction) {
    if (!['up','down'].includes(direction)) throw new Error("Invalid direction.");
    const rows=this.routeGroups(), index=rows.findIndex(row=>row.id===id);
    if(index<0) throw new Error("Group not found.");
    const next=index+(direction==='up'?-1:1);
    if(next<0 || next>=rows.length)return;
    if(rows[index].routeId==='block' || rows[next].routeId==='block')throw Error("Blocking rules cannot be reordered.");
    [rows[index],rows[next]]=[rows[next],rows[index]];
    return transaction(this.db,()=>{rows.forEach((row,position)=>this.db.prepare('UPDATE route_groups SET position=? WHERE id=?').run(position,row.id));});
  }
  setRouteEnabled(kind,id,enabled) {
    const table={groups:'route_groups',devices:'device_routes',locals:'local_routes'}[kind];
    if(!table || typeof enabled!=='boolean')throw new Error("Invalid rule state.");
    const current=this.db.prepare('SELECT enabled FROM '+table+' WHERE id=?').get(id);
    if(!current)return null;
    this.db.prepare('UPDATE '+table+' SET enabled=? WHERE id=?').run(Number(enabled),id);
    return {id,enabled};
  }
  routeGroups() {
    return this.db.prepare('SELECT id,name,entries,route_id AS routeId,zapret_strategy AS zapretStrategy,dns_policy AS dnsPolicy,domain_presets AS domainPresets,enabled,created_at AS createdAt FROM route_groups ORDER BY position ASC,created_at DESC,rowid DESC').all()
      .map(row => ({ ...presentRoutePresets(row), ...this.readDnsPolicy(row), enabled:row.enabled!==0, zapretStrategy: ZAPRET_PRESETS.some(preset=>preset.id===row.zapretStrategy) ? row.zapretStrategy : null }));
  }
  routeGroup(id) {
    const row = this.db.prepare('SELECT id,name,entries,route_id AS routeId,zapret_strategy AS zapretStrategy,dns_policy AS dnsPolicy,domain_presets AS domainPresets,enabled,created_at AS createdAt FROM route_groups WHERE id=?').get(id);
    return row ? { ...presentRoutePresets(row), ...this.readDnsPolicy(row), enabled:row.enabled!==0, zapretStrategy: ZAPRET_PRESETS.some(preset=>preset.id===row.zapretStrategy) ? row.zapretStrategy : null } : null;
  }
  refreshDomainPresets({strict=true}={}){
    for(const row of this.db.prepare('SELECT id,entries,domain_presets FROM route_groups').all()){
      const previous=readRoutePresets(row.domain_presets);if(!previous.length)continue;
      try{
        const refs=bindRoutePresets(previous.map(ref=>ref.id),previous);
        expandRoutePresets(JSON.parse(row.entries),refs);
        this.db.prepare('UPDATE route_groups SET domain_presets=? WHERE id=?').run(JSON.stringify(refs),row.id);
      }catch(error){if(strict)throw error;}
    }
  }
  validateRouteExclusions(entries,refs,policy){
    if(!entries.some(entry=>entry.startsWith('exclude:')))return;
    if(policy.dnsRules.length || policy.dnsFilters.length)throw Error('Domain exclusions cannot be combined with custom DNS rules or filters.');
    if(!refs.length && entries.every(entry=>entry.startsWith('exclude:')))throw Error('Add an included address or a domain preset before exclusions.');
  }
  addRouteGroup(input) {
    const name = String(input?.name ?? '').trim();
    if (!name || name.length > 100) throw new Error("Specify a group name of up to 100 characters.");
    const policy=normalizeDnsPolicy(input);
    const refs=bindRoutePresets(input?.presetIds ?? []);
    const rawEntries=input?.entries;
    const entries = (hasDnsPolicy(policy) || refs.length) && (!rawEntries || (Array.isArray(rawEntries)?!rawEntries.length:!String(rawEntries).trim()))?[]:normalizeRouteEntries(rawEntries);
    this.validateRouteExclusions(entries,refs,policy);
    expandRoutePresets(entries,refs);
    const routeId = input?.routeId ? String(input.routeId) : null;
    if (routeId !== 'block' && (!routeId || !this.hasRoute(routeId))) throw new Error("Select a route from the connections list.");
    const zapretStrategy=this.groupZapretStrategy(input?.zapretStrategy,routeId);
    const item = { id: randomUUID(), name, entries, routeId, zapretStrategy,...policy, createdAt: new Date().toISOString() };
    this.db.prepare('INSERT INTO route_groups (id,name,entries,route_id,created_at,zapret_strategy,position,dns_policy,domain_presets) VALUES (?,?,?,?,?,?,?,?,?)').run(item.id, item.name, JSON.stringify(item.entries), item.routeId, item.createdAt,item.zapretStrategy,this.db.prepare('SELECT COALESCE(MAX(position),-1)+1 AS position FROM route_groups').get().position,JSON.stringify(policy),JSON.stringify(refs));
    if(routeId==='block'){this.db.prepare("UPDATE route_groups SET position=-1 WHERE id=?").run(item.id);}
    this.pinBlockGroups();
    return this.routeGroup(item.id);
  }
  updateRouteGroup(id, input) {
    const current = this.routeGroup(id);
    if (!current) return null;
    const name = String(input?.name ?? current.name).trim();
    if (!name || name.length > 100) throw new Error("Specify a group name of up to 100 characters.");
    const policy=normalizeDnsPolicy({...current,...input});
    const previous=readRoutePresets(this.db.prepare('SELECT domain_presets FROM route_groups WHERE id=?').get(id).domain_presets);
    const refs=bindRoutePresets(input?.presetIds ?? current.presetIds,previous);
    const rawEntries=input?.entries ?? current.manualEntries;
    const entries = (hasDnsPolicy(policy) || refs.length) && (Array.isArray(rawEntries)?!rawEntries.length:!String(rawEntries).trim())?[]:normalizeRouteEntries(rawEntries);
    this.validateRouteExclusions(entries,refs,policy);
    expandRoutePresets(entries,refs);
    const routeId = input?.routeId === undefined ? current.routeId : (input.routeId ? String(input.routeId) : null);
    if (routeId !== 'block' && (!routeId || !this.hasRoute(routeId))) throw new Error("Select a route from the connections list.");
    const zapretStrategy=this.groupZapretStrategy(input?.zapretStrategy===undefined?current.zapretStrategy:input.zapretStrategy,routeId);
    this.db.prepare('UPDATE route_groups SET name=?,entries=?,route_id=?,zapret_strategy=?,dns_policy=?,domain_presets=? WHERE id=?').run(name, JSON.stringify(entries), routeId,zapretStrategy,JSON.stringify(policy),JSON.stringify(refs), id);
    this.pinBlockGroups();
    return this.routeGroup(id);
  }
  removeRouteGroup(id) {
    return this.db.prepare('DELETE FROM route_groups WHERE id=?').run(id).changes > 0;
  }
  deviceRoutes() {
    return this.db.prepare('SELECT id,name,identifier,route_id AS routeId,enabled,created_at AS createdAt FROM device_routes ORDER BY created_at DESC').all().map(row=>({...row,enabled:row.enabled!==0}));
  }
  addDeviceRoute(input) {
    const name = String(input?.name ?? '').trim();
    if (!name || name.length > 100) throw new Error("Specify a device name of up to 100 characters.");
    const identifier = String(input?.identifier ?? '').trim();
    if (!validDeviceIdentifier(identifier)) throw new Error("Enter the device IP or MAC address.");
    const routeId = input?.routeId ? String(input.routeId) : null;
    if (!routeId || !this.hasRoute(routeId)) throw new Error("Select a route from the connections list.");
    const item = { id: randomUUID(), name, identifier, routeId, createdAt: new Date().toISOString() };
    this.db.prepare('INSERT INTO device_routes (id,name,identifier,route_id,created_at) VALUES (?,?,?,?,?)').run(item.id, item.name, item.identifier, item.routeId, item.createdAt);
    return item;
  }
  updateDeviceRoute(id, input) {
    const current = this.db.prepare('SELECT id,name,identifier,route_id AS routeId,enabled,created_at AS createdAt FROM device_routes WHERE id=?').get(id);
    if (!current) return null;
    const name = String(input?.name ?? current.name).trim();
    if (!name || name.length > 100) throw new Error("Specify a device name of up to 100 characters.");
    const identifier = String(input?.identifier ?? current.identifier).trim();
    if (!validDeviceIdentifier(identifier)) throw new Error("Enter the device IP or MAC address.");
    const routeId = input?.routeId === undefined ? current.routeId : (input.routeId ? String(input.routeId) : null);
    if (!routeId || !this.hasRoute(routeId)) throw new Error("Select a route from the connections list.");
    this.db.prepare('UPDATE device_routes SET name=?,identifier=?,route_id=? WHERE id=?').run(name, identifier, routeId, id);
    return { ...current, name, identifier, routeId,enabled:current.enabled!==0 };
  }
  removeDeviceRoute(id) {
    return this.db.prepare('DELETE FROM device_routes WHERE id=?').run(id).changes > 0;
  }

  staticLeases() {
    return this.db.prepare('SELECT mac,ip,hostname,created_at AS createdAt FROM static_leases ORDER BY ip').all();
  }
  staticLease(mac) {
    return this.db.prepare('SELECT mac,ip,hostname,created_at AS createdAt FROM static_leases WHERE mac=?').get(String(mac || '').trim().toLowerCase()) || null;
  }
  pinStaticLease(input) {
    const mac = String(input?.mac ?? '').trim().toLowerCase();
    if (!MAC_PATTERN.test(mac)) throw new Error("Specify the client MAC address.");
    const ip = String(input?.ip ?? '').trim();
    if (!isIP(ip)) throw new Error("Specify the client IP address.");
    const hostname = String(input?.hostname ?? '').trim().slice(0, 100);
    const taken = this.db.prepare('SELECT mac FROM static_leases WHERE ip=? AND mac<>?').get(ip, mac);
    if (taken) throw new Error("This IP address is already assigned to another client.");
    this.db.prepare('INSERT INTO static_leases (mac,ip,hostname,created_at) VALUES (?,?,?,?) ON CONFLICT(mac) DO UPDATE SET ip=excluded.ip,hostname=excluded.hostname').run(mac, ip, hostname, new Date().toISOString());
    return this.staticLease(mac);
  }
  unpinStaticLease(mac) {
    return this.db.prepare('DELETE FROM static_leases WHERE mac=?').run(String(mac || '').trim().toLowerCase()).changes > 0;
  }

  localRoutes() {
    return this.db.prepare('SELECT id,alias,target,enabled,created_at AS createdAt FROM local_routes ORDER BY created_at DESC').all().map(row=>({...row,enabled:row.enabled!==0}));
  }
  addLocalRoute(input) {
    const value = normalizeLocalRoute(input);
    const item = { id: randomUUID(), ...value, createdAt: new Date().toISOString() };
    try {
      this.db.prepare('INSERT INTO local_routes (id,alias,target,created_at) VALUES (?,?,?,?)').run(item.id, item.alias, item.target, item.createdAt);
    } catch (error) {
      if (String(error.code).includes('CONSTRAINT') || String(error.message).includes('UNIQUE constraint')) throw new Error("This alias already exists.");
      throw error;
    }
    return item;
  }
  updateLocalRoute(id, input) {
    const current = this.db.prepare('SELECT id,alias,target,enabled,created_at AS createdAt FROM local_routes WHERE id=?').get(id);
    if (!current) return null;
    const value = normalizeLocalRoute({ alias: input?.alias ?? current.alias, target: input?.target ?? current.target });
    try {
      this.db.prepare('UPDATE local_routes SET alias=?,target=? WHERE id=?').run(value.alias, value.target, id);
    } catch (error) {
      if (String(error.code).includes('CONSTRAINT') || String(error.message).includes('UNIQUE constraint')) throw new Error("This alias already exists.");
      throw error;
    }
    return { ...current, ...value,enabled:current.enabled!==0 };
  }
  removeLocalRoute(id) {
    return this.db.prepare('DELETE FROM local_routes WHERE id=?').run(id).changes > 0;
  }

  settings() { return JSON.parse(this.db.prepare('SELECT value FROM settings WHERE id=1').get().value); }
  dnsSettings() {
    const row = this.db.prepare('SELECT value FROM dns_settings WHERE id=1').get();
    // Normalise on read: settings saved by older releases may miss newer fields.
    return validateDnsSettings(row ? JSON.parse(row.value) : structuredClone(defaultDnsSettings));
  }
  updateDnsSettings(input) {
    const value = validateDnsSettings(input);
    this.db.prepare('INSERT INTO dns_settings VALUES (1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(JSON.stringify(value));
    return value;
  }
  hasNetworkSettings() {return !!this.db.prepare('SELECT 1 FROM network_settings WHERE id=1').get();}
  networkSettings(interfaces) {
    const row = this.db.prepare('SELECT value FROM network_settings WHERE id=1').get();
    return normalizeNetworkSetup(row ? JSON.parse(row.value) : defaultNetworkSetup(interfaces || listInterfaces()));
  }
  updateNetworkSettings(input, interfaces = listInterfaces()) {
    const value = validateNetworkSetup(input, interfaces);
    this.db.prepare('INSERT INTO network_settings VALUES (1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(JSON.stringify(value));
    return value;
  }

  zapretSettings() {
    const row = this.db.prepare('SELECT value FROM zapret_settings WHERE id=1').get();
    const defaults = {
      mode: 'auto',
      strategy: '',
      customStrategy: '',
      http: true,
      https: true,
      quic: true,
      ...ZAPRET_UDP_DEFAULTS,
      tcpPorts: '80,443',
      udpPorts: '443',
      windowSize: 0,
      ttl: 0,
      hostlist: false,
      hostlistUrl: '',
      autoUpdate: false,
      autoUpdateInterval: 'daily',
    };
    if (!row) return defaults;
    const parsed = JSON.parse(row.value);
    return { ...defaults, ...parsed };
  }
  updateZapretSettings(input) {
    const defaults = this.zapretSettings();
    const value = {
      mode: input.mode || defaults.mode,
      strategy: input.strategy || defaults.strategy,
      customStrategy: input.customStrategy || defaults.customStrategy,
      http: input.http !== undefined ? input.http : defaults.http,
      https: input.https !== undefined ? input.https : defaults.https,
      quic: input.quic !== undefined ? input.quic : defaults.quic,
      tcpPorts: input.tcpPorts || defaults.tcpPorts,
      udpPorts: input.udpPorts || defaults.udpPorts,
      ...normalizeUdpSettings(input,defaults),
      windowSize: input.windowSize !== undefined ? input.windowSize : defaults.windowSize,
      ttl: input.ttl !== undefined ? input.ttl : defaults.ttl,
      hostlist: input.hostlist !== undefined ? input.hostlist : defaults.hostlist,
      hostlistUrl: input.hostlistUrl || defaults.hostlistUrl,
      autoUpdate: input.autoUpdate !== undefined ? input.autoUpdate : defaults.autoUpdate,
      autoUpdateInterval: input.autoUpdateInterval || defaults.autoUpdateInterval,
    };
    this.db.prepare('INSERT INTO zapret_settings VALUES (1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(JSON.stringify(value));
    return value;
  }

  updateSettings(input) {
    if (!['access-point','router-uplink','advanced-routing'].includes(input.topology)) throw new Error("Unknown network topology.");
    const value = { ...this.settings(), topology: input.topology };
    this.db.prepare('UPDATE settings SET value=? WHERE id=1').run(JSON.stringify(value));
    return value;
  }
  recordEvent(actor, action, status, detail='') {
    this.db.prepare('INSERT INTO events(timestamp,actor,action,status,detail) VALUES (?,?,?,?,?)').run(new Date().toISOString(),actor || null,action,status,detail);
    pruneEvents(this.db);
  }
  journalCursor() {
    return this.db.prepare('SELECT cursor FROM system_journal_state WHERE id=1').get()?.cursor || '';
  }
  recordJournalEntry(entry,event) {
    if(!entry.__CURSOR)return;
    return transaction(this.db,()=>{
      if(event){
        const timestamp=new Date(Number(entry.__REALTIME_TIMESTAMP)/1000);
        const time=Number.isFinite(timestamp.getTime())?timestamp.toISOString():new Date().toISOString();
        const detail=event[2]?JSON.stringify(event[2]):String(entry.MESSAGE || '').match(/STA ((?:[a-f0-9]{2}:){5}[a-f0-9]{2})/i)?.[1] || '';
        const duplicate=this.db.prepare('SELECT id FROM events WHERE action=? AND detail=? AND substr(timestamp,1,19)=? LIMIT 1').get(event[0],detail,time.slice(0,19));
        if(!duplicate)this.db.prepare('INSERT INTO events(timestamp,actor,action,status,detail) VALUES (?,?,?,?,?)').run(time,'system',event[0],event[1],detail);
        pruneEvents(this.db);
      }
      this.db.prepare('INSERT INTO system_journal_state VALUES (1,?) ON CONFLICT(id) DO UPDATE SET cursor=excluded.cursor').run(entry.__CURSOR);
    },{immediate:false});
  }
  events() {
    return this.db.prepare(`
      SELECT e.id,e.timestamp,COALESCE(u.username,e.actor) AS actor,e.action,e.status,e.detail,
        (length(e.actor)=32 AND e.actor NOT GLOB '*[^0-9a-f]*'
          AND u.id IS NULL AND known.id IS NULL) AS actorDeleted
      FROM events e
      LEFT JOIN users u ON u.id=e.actor
      LEFT JOIN users known ON known.username=e.actor
      ORDER BY e.id DESC LIMIT 100
    `).all();
  }
  close() { this.db.close(); }
}
