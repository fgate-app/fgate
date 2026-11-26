import {inspectRestoreCloud,detachRestoreCloud} from './cloud-restore.js';
import {ConfigurationBackups,generateBackupSecret,encryptConfiguration,decryptConfiguration} from './configuration-backup.js';
import {GatewaySubscriptions} from './gateway-subscriptions.js';
import {createResourceFetch,downloadGateways} from './resource-fetch.js';
import {collectNetworkArchitecture} from './network-architecture.js';
import {isReleaseManagedModule} from '../shared/module-policy.js';
import {lanternBinary,verifyLantern,waitForLantern} from './lantern/runtime.js';
import {assertNoResolvedAccessPointGateway} from './gateway-recursion.js';
import {waitForTor} from './tor/runtime.js';
import {GatewayDeploymentService} from './gateway-deployments/service.js';
import {probeMtu} from './network-helper.js';
import {DiagnosticBlocklist,diagnosticBlocklistSource} from './diagnostic-blocklist.js';
import {diagnosticGatewaySession} from './diagnostic-gateway-session.js';
import {diagnoseProxyStrategies,proxySnapshotFingerprint} from './proxy-strategies.js';
import {compareProxyPaths} from './proxy-path-comparison.js';
import {gatewayWrapCandidates,gatewayChainAvailable,gatewayUsesTcpOnly,gatewayUsesLantern,gatewayInChain} from '../shared/gateway-wrap.js';
import {normalizeDiagnosticDomains} from '../shared/diagnostic-targets.js';
import {diagnoseDomains} from './domain-diagnostics.js';
import {probeEndpointRoute} from './network-helper.js';
import {probeEndpointDns} from './network-helper.js';
import {diagnosticEnvironment,diagnosticMetadata} from './diagnostic-metadata.js';
import {isLocalDiagnostic,diagnosticContext} from '../shared/diagnostic-context.js';
import {describeConnections} from './connection-presentation.js';
import {HttpError,readJsonBody,sendJson,serveInterface} from './http.js';
import {clientsView} from './clients.js';
import {summarizeSni} from './sni-diagnostics.js';
import {probeSni} from './network-helper.js';
import {compareDnsPaths} from './gateway-dns-matrix.js';
import {dnsMatrixCatalog,dnsMatrixProviders,normalizeDnsMatrixName} from './dns-matrix-catalog.js';
import {probeDnsMatrix} from './network-helper.js';
import {probeUplink} from './network-helper.js';
import {probeGatewayEndpoint} from './network-helper.js';
import {gatewayPeer,diagnoseEndpoint} from './endpoint-diagnostics.js';
import {applyRoutesIfReady,pinDeviceRoute} from './route-runtime.js';
import {isAdminHost} from './admin-host.js';
import {createBlockedJournal} from './blocked-journal.js';
import {groupDnsEntries,adguardDomainRule} from './route-entries.js';
import {createConnectionJournal} from './connection-journal.js';
import {createInterfaceTraffic} from './network-traffic.js';
import {DomainListUpdates} from './domain-list-updates.js';
import {installedModuleVersions} from './module-paths.js';
import {InlineChanges} from './inline-changes.js';
import {gatewayEditor} from './gateway-editor.js';
import {auditAction,moduleAuditDetail} from '../shared/event-log.js';
import {AccessPointService} from './access-points/service.js';
import {AccessPointError} from './access-points/model.js';
import {clientPresence,clientActivity} from './client-status.js';
import {createDashboardTraffic,connectedDeviceCount} from './dashboard.js';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMetricsCollector } from './metrics.js';
import { sshStatus } from './support.js';
import { Auth, AuthError, roles } from './auth.js';
import { bootstrapResolvers, resolvers as dnsResolvers, statusTargets, ValidationError, validateDnsSettings } from './dns-resolvers.js';
import { normalizeTarget, runAutotune } from './zapret.js';
import { statusesFor } from './dns-probe.js';
import { FilterPolicy } from './filter-policy.js';
import { buildNetworkPlan, listInterfaces, NetworkError, validateNetworkSetup } from './network.js';
import { moduleCommand, applyLeases, applyNetwork, applyZapret, NetworkHelperError, networkStatus, stopNetwork, systemAction, zapretStatus } from './network-helper.js';
import { searchDomainPresets,domainListSnapshot,restoreDomainListSnapshot,domainListsStatus, domainListDomains, updateDomainLists } from './domain-lists.js';
export const modules = [
  ['mihomo','TUN и маршрутизация'], ['xray','VLESS / REALITY'], ['outline','Shadowsocks с prefix'], ['zapret','Обход DPI'], ['adguard','Фильтрация DNS'], ['domain-lists','Пресеты доменов'], ['diagnostic-blocklist','Diagnostic domain list'], ['frp','Обратный туннель VPS'],['lantern','Lantern proxy network']
].map(([id,description]) => ({id, description, status:'unknown'}));
const modulesLock = JSON.parse(readFileSync(new URL('../packaging/modules.lock.json', import.meta.url), 'utf8'));
const moduleVersions = Object.fromEntries(modulesLock.modules.map(module => [module.id, module.version]));
moduleVersions.lantern='—';
moduleVersions.tor=JSON.parse(readFileSync(new URL('../packaging/tor.lock.json',import.meta.url),'utf8')).version;
moduleVersions.frp=JSON.parse(readFileSync(new URL('./access-points/assets.json',import.meta.url),'utf8')).version;
moduleVersions.outline = modulesLock.bundledModules?.find(module=>module.id==='outline')?.version || '—';
moduleVersions.zapret = modulesLock.sourceModules?.find(module => module.id === 'zapret2')?.commit?.slice(0, 7) || '—';
moduleVersions['domain-lists'] = modulesLock.sourceModules?.find(module => module.id === 'metacube-rules')?.commit?.slice(0, 7) || '—';
export function createServer(store, { supervisor = null, filter = null, interfaces = listInterfaces, zapretProbe = null, zapretApply = applyZapret, networkApply = applyNetwork, domainListUpdate = updateDomainLists, accessPoints = null, gatewayDeployments = null, inlineDelay = 5000, modulesHelper = moduleCommand, networkTraffic = null, diagnosticUplink = probeUplink, diagnosticEndpoint = probeGatewayEndpoint, diagnosticEndpointDns = probeEndpointDns, diagnosticDns = probeDnsMatrix, diagnosticSni = probeSni, diagnosticStrategies = diagnoseProxyStrategies, diagnosticRoute = probeEndpointRoute, diagnosticMtu = probeMtu, diagnosticComparison = compareProxyPaths, diagnosticBlocklist = null, diagnosticListFetch = null,resourceFetch = null, maintenanceRuntime = null, cloudRestoreCheck = null } = {}) {
  let maintenanceBusy=false,activeWrites=0;
  const backups=new ConfigurationBackups(store);
  const root = resolve('web/dist');
  let diagnosticRunning=false;
  accessPoints ||= new AccessPointService(store,{gateways:()=>downloadGateways(store,supervisor),prepare:async (hosts,users)=>{if(!supervisor || (!supervisor.remoteAccessEnabled && !hosts.length))return;supervisor.accessPointHosts=hosts;supervisor.remoteAccessUsers=users;supervisor.remoteAccessEnabled=hosts.length>0;await applyRoutesIfReady(store,supervisor);}});
  gatewayDeployments ||= new GatewayDeploymentService(store,{apply:()=>applyRoutesIfReady(store,supervisor)});
  supervisor?.setHttpHealthReporter?.(event=>{
    try{const name=(store.profiles().find(profile=>profile.id===event.profileId)?.name || '').replace(/[\x00-\x1f\x7f]/g,'').slice(0,160);store.recordEvent('system',event.failed?'SYSTEM gateway-http-failed':'SYSTEM gateway-http-restored',event.failed?503:200,`${name} (${event.profileId}) · ${event.endpoint} · ${event.reason}`);}catch{}
  });
  const auth = new Auth(store.db);
  filter?.setSettingsResolver?.(()=>store.adGuardSettings());
  const filterPolicy = new FilterPolicy(store,filter);
  const routeChange=action=>filterPolicy.change(action,{apply:()=>applyRoutesIfReady(store,supervisor)});
  const inlineChanges=new InlineChanges(async()=>{await filterPolicy.change(()=>{});await applyRoutesIfReady(store,supervisor);},{delay:inlineDelay});
  const resourceDownload=resourceFetch || createResourceFetch({gateways:()=>downloadGateways(store,supervisor)});
  diagnosticBlocklist ||= new DiagnosticBlocklist({fetchImpl:diagnosticListFetch || resourceDownload});
  const gatewaySubscriptions=new GatewaySubscriptions(store,{fetchImpl:resourceDownload,serialize:action=>inlineChanges.enqueue(action),apply:()=>applyRoutesIfReady(store,supervisor),validate:snapshot=>assertNoResolvedAccessPointGateway([snapshot],()=>accessPoints.repository.all())});
  const subscriptionTimer=setInterval(()=>{if(!maintenanceBusy)gatewaySubscriptions.tick().catch(()=>{});},60000);subscriptionTimer.unref();
  supervisor?.setClientResolver?.(()=>clientsView(store));
  const collectMetrics=createMetricsCollector();
  const collectNetworkTraffic=networkTraffic || createInterfaceTraffic();
  const collectDashboardTraffic=createDashboardTraffic(path=>{if(supervisor?.status().state!=='running' || !supervisor.controller)throw Error('Unavailable');return supervisor.controller(path);},{profiles:()=>store.profiles()});

  const connectionJournal=createConnectionJournal((path,options)=>{
    if(supervisor?.status().state!=='running' || !supervisor.controller)throw Error('Engine unavailable');
    return supervisor.controller(path,options);
  });
  accessPoints.connections=()=>connectionJournal.snapshot();
  const blockedJournal=createBlockedJournal({
    watchLogs:supervisor?.watchLogs?supervisor.watchLogs.bind(supervisor):null,
    rules:()=>supervisor?.blockedRouteRules?.() || [],
    dns:async()=>{
      if(!filter?.blockedQueries)return {data:[]};
      const data=await filter.blockedQueries(),groups=store.routeGroups().filter(group=>group.enabled!==false);
      const managed=new Set(store.filterRuleState().managed);
      const routeRules=Object.fromEntries(groups.filter(group=>group.routeId==='block').flatMap(group=>groupDnsEntries(group).map(entry=>adguardDomainRule(entry)).filter(rule=>rule && managed.has(rule)).map(rule=>[rule,{id:group.id,name:group.name}])));
      return {...data,routeRules};
    }
  });
  const blockedTimer=setInterval(()=>blockedJournal.poll(),5000);blockedTimer.unref();
  blockedJournal.poll();
  const journalTimer=supervisor?setInterval(()=>connectionJournal.poll(),1000):null;
  journalTimer?.unref();
  if(supervisor)connectionJournal.poll();

  let domainRefresh;
  const refreshDomainLists=options=>{
    if(domainRefresh)return domainRefresh;
    let snapshot;
    domainRefresh=routeChange(async()=>{
      snapshot=domainListSnapshot();
      const result=await domainListUpdate({fetchImpl:resourceDownload,...options});store.refreshDomainPresets();return result;
    }).catch(error=>{if(snapshot!==undefined)restoreDomainListSnapshot(snapshot);throw error;}).finally(()=>{domainRefresh=null;});
    return domainRefresh;
  };
  const domainUpdates=new DomainListUpdates({current:()=>{const value=domainListsStatus();return value.loaded && !value.partial && value.repository==='MetaCubeX/meta-rules-dat'?value.ref:null;},fetchImpl:resourceDownload,details:()=>{const value=domainListsStatus();return {loaded:value.loaded,updatedAt:value.updatedAt,presetCount:value.presets.length};},update:ref=>refreshDomainLists({ref})});
  const diagnosticListUpdates=new DomainListUpdates({id:diagnosticBlocklistSource.id,repository:diagnosticBlocklistSource.repository,current:()=>diagnosticBlocklist.status().ref,details:()=>diagnosticBlocklist.status(),update:ref=>diagnosticBlocklist.update(ref),fetchImpl:diagnosticListFetch || resourceDownload});
  const server=http.createServer(async (req,res) => {
    let actor=null, eventDetail,eventMetadata,countedWrite=false;
    const send = (status,data) => {
      if(['POST','PUT','DELETE'].includes(req.method) && req.url.startsWith('/api/')) {
        const action=auditAction(req.method,req.url,eventDetail);
        try{store.recordEvent(actor,action,status,eventMetadata);}catch{}
      }
      sendJson(res,status,data);
    };
    try {
      if (!isAdminHost(req.headers.host)) return send(403,{error:"Only local access is allowed."});
      if (req.headers.origin && !['http://'+req.headers.host,'http://127.0.0.1:5173','http://localhost:5173'].includes(req.headers.origin)) return send(403,{error:"Invalid request origin."});
      const url = new URL(req.url,'http://localhost');
      const key = req.method+' '+url.pathname;
      const token = /(?:^|; )fg_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
      const session=auth.session(token);
      actor=session?.username || null;
      if(url.pathname.startsWith('/api/configuration') && session?.role!=='admin')return send(session?403:401,{error:session?'Insufficient permissions.':'Please sign in.'});
      if(maintenanceBusy && (server.maintenancePending || !['GET','HEAD'].includes(req.method)))return send(503,{error:'System maintenance is in progress.'});
      const body=await readJsonBody(req);
      const cookie=(value,age)=>res.setHeader('Set-Cookie',`fg_session=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${age}${process.env.FREEDOMGATE_SECURE_COOKIE==='1'?'; Secure':''}`);
      if(key==='GET /api/health'){const engine=supervisor?.status(),dns=filter?.status();return send(200,{ready:server.runtimeReady!==false && engine?.state!=='error' && engine?.xray?.state!=='error' && dns?.state!=='error'});}
      if(key==='GET /api/auth/session') return send(200,{setupRequired:auth.needsSetup(),user:session?{id:session.id,username:session.username,role:session.role}:null,csrf:session?.csrf || null,permissions:session?roles[session.role]:[]});
      if(['POST /api/auth/setup','POST /api/auth/login'].includes(key)) {
        if(!req.headers['content-type']?.startsWith('application/json')) return send(415,{error:"The request must use application/json."});
        if(key==='POST /api/auth/setup') await auth.create(body,true);
        const result=await auth.login(body.username,body.password,req.socket.remoteAddress);
        actor=result.user.username;
        cookie(result.token,8*3600);
        return send(200,{user:result.user,csrf:result.csrf,permissions:roles[result.user.role]});
      }
      if(url.pathname.startsWith('/api/')) {
        if(!session) return send(401,{error:"Please sign in."});
        if(!['GET','HEAD'].includes(req.method)) {
          if(req.headers['x-csrf-token']!==session.csrf) return send(403,{error:"Invalid security token. Refresh the page."});
          let permission='settings:write';
          if((url.pathname.startsWith('/api/gateway-subscriptions') || url.pathname.startsWith('/api/profiles') || url.pathname.startsWith('/api/connection-groups') || url.pathname.startsWith('/api/connection-journal'))) permission='profiles:write';
          if(url.pathname.startsWith('/api/users')) permission='users:write';
          if(!url.pathname.startsWith('/api/auth/') && !roles[session.role].includes(permission)) return send(403,{error:"Insufficient permissions."});
        }
      }
      if(url.pathname.startsWith('/api/')){
        if(!['GET','HEAD'].includes(req.method)){activeWrites++;countedWrite=true;}
      }
      if(url.pathname.startsWith('/api/configuration')){
        if(session?.role!=='admin')return send(403,{error:'Insufficient permissions.'});
        const parts=url.pathname.split('/').slice(3),id=parts[1];
        if(key==='GET /api/configuration/backups')return send(200,backups.list());
        if(req.method==='DELETE' && parts[0]==='backups' && parts.length===2){backups.remove(id);return send(200,{ok:true});}
        if(activeWrites!==1 || diagnosticRunning || accessPoints.jobs?.size || gatewayDeployments.jobs?.size || gatewaySubscriptions.tasks.size || domainRefresh)return send(409,{error:'Wait for other operations to finish.'});
        maintenanceBusy=true;
        try{
          if(key==='POST /api/configuration/secret')return send(200,{secret:generateBackupSecret()});
          if(key==='POST /api/configuration/export')return send(200,{file:await encryptConfiguration(backups.capture(),body.secret)});
          if(key==='POST /api/configuration/backups')return send(201,await backups.create());
          if(req.method==='POST' && parts[0]==='backups' && parts[2]==='export' && parts.length===3)return send(200,{file:await encryptConfiguration(await backups.read(id),body.secret)});
          const preview=key==='POST /api/configuration/preview';
          if(preview){
            const snapshot=body.backupId?await backups.read(body.backupId):backups.validate(await decryptConfiguration(body.file,body.secret));
            const network=snapshot.tables.network_settings[0]?JSON.parse(snapshot.tables.network_settings[0].value):null;
            const available=new Set(interfaces().map(row=>row.name));
            const required=[network?.uplink?.interface,network?.client?.interface,network?.wired?.enabled?network.wired.interface:null].filter(Boolean);
            const cloudAccess=await inspectRestoreCloud(snapshot,{accessPoints,gateways:downloadGateways(store,supervisor),...(cloudRestoreCheck?{check:cloudRestoreCheck}:{})});
            return send(200,{cloudAccess,createdAt:snapshot.createdAt,gateways:snapshot.tables.profiles.length,rules:snapshot.tables.route_groups.length,users:snapshot.tables.users.length,network:!!network,missingInterfaces:required.filter(name=>!available.has(name))});
          }
          const factory=key==='POST /api/configuration/reset';
          const restore=key==='POST /api/configuration/restore' || (req.method==='POST' && parts[0]==='backups' && parts[2]==='restore' && parts.length===3);
          if(!factory&&!restore)return send(404,{error:'API method not found.'});
          if(body.confirm!==true)return send(400,{error:'Confirm configuration replacement.'});
          if(!maintenanceRuntime)return send(503,{error:'Configuration replacement is unavailable in this runtime.'});
          let snapshot=factory?backups.factory():key==='POST /api/configuration/restore'?backups.validate(await decryptConfiguration(body.file,body.secret)):await backups.read(id);
          if(!factory){
            if(body.restoreNetwork===false){snapshot.tables.network_settings=backups.capture().tables.network_settings;snapshot.tables.static_leases=backups.capture().tables.static_leases;}
            else if(snapshot.tables.network_settings[0]){
              try{validateNetworkSetup(JSON.parse(snapshot.tables.network_settings[0].value),interfaces());}catch{throw new HttpError(400,'The saved network settings do not match this device. Restore without network settings and configure the network separately.');}
            }
          }
          const cloudAccess=factory?null:await inspectRestoreCloud(snapshot,{accessPoints,gateways:downloadGateways(store,supervisor),...(cloudRestoreCheck?{check:cloudRestoreCheck}:{})});
          if(cloudAccess?.reset && body.acknowledgeCloudReset!==true)return send(409,{error:'Cloud access must be reset before restoring this configuration.',cloudAccess});
          if(cloudAccess)snapshot=detachRestoreCloud(snapshot,cloudAccess);
          await maintenanceRuntime.prepare();
          // Serialize with deferred routing writes before capturing the safety copy.
          await inlineChanges.enqueue(()=>{});
          const safety=await backups.create();
          inlineChanges.close();
          try{
            await Promise.all([gatewaySubscriptions.close(),accessPoints.close(),gatewayDeployments.close()]);
            await maintenanceRuntime.stop();
            backups.apply(snapshot);
            send(200,{ok:true,restarting:true,backup:safety.id,cloudAccess});
          }finally{
            server.runtimeReady=false;server.maintenancePending=true;
            setTimeout(()=>maintenanceRuntime.restart().catch(()=>console.error('FreedomGate: configuration restart failed.')),250).unref();
          }
          return;
        }finally{if(!server.maintenancePending)maintenanceBusy=false;}
      }
      if(url.pathname.startsWith('/api/gateway-deployments')){
        if(session?.role!=='admin')return send(403,{error:'Insufficient permissions.'});
        res.setHeader('Cache-Control','no-store');
        const parts=url.pathname.split('/').slice(3),id=parts[0];
        if(!id && req.method==='GET')return send(200,gatewayDeployments.list());
        if(!id && req.method==='POST')return send(202,gatewayDeployments.create(body));
        if(id==='inspect' && req.method==='POST')return send(200,await gatewayDeployments.inspect(body));
        if(id && parts[1]==='key' && req.method==='GET')return send(200,gatewayDeployments.key(id));
        if(id && parts.length===1 && req.method==='GET')return send(200,gatewayDeployments.get(id));
        if(id && parts[1]==='retry' && req.method==='POST')return send(202,gatewayDeployments.retry(id,body));
        return send(404,{error:'API method not found.'});
      }
      if(url.pathname.startsWith('/api/access-points')){
        if(session?.role!=='admin')return send(403,{error:"Insufficient permissions."});
        const parts=url.pathname.split('/').slice(3),id=parts[0];
        if(!id && req.method==='GET')return send(200,await accessPoints.list());
        if(!id && req.method==='POST')return send(201,accessPoints.create(body));
        if(id==='inspect' && req.method==='POST')return send(200,await accessPoints.inspectHost(body));
        if(id && req.method==='PUT' && parts[1]==='cloud')return send(200,await accessPoints.configureCloud(id,body));
        if(id && req.method==='PUT' && parts[1]==='credentials')return send(200,accessPoints.updateCredentials(id,body));
        if(id && req.method==='POST' && parts[1]==='install')return send(202,accessPoints.installServer(id));
        if(id && req.method==='PUT' && parts.length===1)return send(200,await accessPoints.setEnabled(id,body.enabled===true));
        if(id && req.method==='DELETE' && parts.length===1)return send(200,await accessPoints.remove(id));
        if(id && parts[1]==='clients'){
          if(parts.length===2 && req.method==='PUT')return send(200,await accessPoints.saveClients(id,body));
          if(parts.length===2 && req.method==='POST')return send(201,await accessPoints.addClient(id,body));
          if(parts.length===4 && parts[3]==='config' && req.method==='GET')return send(200,accessPoints.exportClient(id,parts[2]));
          if(parts.length===3 && ['PUT','DELETE'].includes(req.method))return send(200,await accessPoints.changeClient(id,parts[2],body,{remove:req.method==='DELETE'}));
        }
        return send(404,{error:"API method not found."});
      }
      if(key==='POST /api/auth/logout') { auth.logout(token);cookie('',0);return send(200,{ok:true}); }
      if(key==='PUT /api/auth/password') {await auth.changePassword(session.id,body);cookie('',0);return send(200,{ok:true});}
      if(url.pathname==='/api/users' && req.method!=='GET' && !roles[session?.role]?.includes('users:write')) return send(403,{error:"Insufficient permissions."});
      if(key==='GET /api/users') return send(200,roles[session.role].includes('users:write')?auth.users():auth.users().filter(user=>user.id===session.id));
      if(key==='POST /api/users') return send(201,await auth.create(body));
      if(req.method==='PUT' && /^\/api\/users\/[a-f0-9]{32}$/.test(url.pathname)) return send(200,auth.update(url.pathname.split('/').pop(),body));
      if(req.method==='PUT' && /^\/api\/users\/[a-f0-9]{32}\/password$/.test(url.pathname)) { await auth.setPassword(url.pathname.split('/')[3],body); return send(200,{ok:true}); }
      if(['/api/logs','/api/support/ssh'].includes(url.pathname) && session?.role!=='admin')return send(403,{error:"Insufficient permissions."});
      if(key==='GET /api/logs')return send(200,store.events());
      if(key==='GET /api/support/ssh')return send(200,await sshStatus());
      if(key==='GET /api/dashboard/architecture'){
        return send(200,await collectNetworkArchitecture({store,supervisor,filter,interfaces,networkTraffic:collectNetworkTraffic,
          clients:async()=>clientActivity(clientsView(store),await clientPresence(store.networkSettings()),supervisor?.routeTraffic?.()),
          remoteClients:async()=>{await connectionJournal.poll();return accessPoints.remoteClients();},frp:()=>accessPoints.moduleState?.(),zapret:()=>zapretStatus(),versions:installedModuleVersions(moduleVersions),
          describePaths:rows=>accessPoints.describe(rows)
        }));
      }
      if(key==='GET /api/dashboard'){
        const [host,traffic,devices,adguard,points]=await Promise.all([
          collectMetrics(),
          collectDashboardTraffic(),
          connectedDeviceCount(store.networkSettings()),
          filter?.statistics?.() ?? {available:false,samples:[]},
          accessPoints.list()
        ]);
        return send(200,{
          ...host,traffic,adguard,
          counts:{
            gateways:store.profiles().length,
            devices,
            accessPoints:points.filter(point=>point.state==='active').length
          }
        });
      }
      if(url.pathname==='/api/modules' && ['GET','POST'].includes(req.method)){
        if(req.method==='POST' && session.role!=='admin')return send(403,{error:"Insufficient permissions."});
        if(req.method==='POST' && !['check','update'].includes(body.op))return send(400,{error:"Unknown update operation."});
        if(req.method==='POST')eventMetadata=moduleAuditDetail(body);
        if(req.method==='POST' && isReleaseManagedModule(body.id))return send(400,{error:'This module is updated with the application.'});
        if(req.method==='POST' && body.id==='diagnostic-blocklist'){try{return send(202,diagnosticListUpdates.start(body.op,body.version));}catch(error){return send(error.status || 400,{error:error.message});}}
        if(req.method==='POST' && body.id==='domain-lists'){try{return send(202,domainUpdates.start(body.op,body.version));}catch(error){return send(error.status || 400,{error:error.message});}}
        const result=await modulesHelper(req.method==='GET'?'status':body.op,body.id,body.version,req.method==='POST'?downloadGateways(store,supervisor):[]);
        if(!result.ok)return send(result.status || 502,{error:result.error});
        if(req.method==='GET'){
          for(const module of result.modules)if(module.id==='frp')module.runtimeState=await accessPoints.moduleState?.() || 'unknown';
          result.modules.push(domainUpdates.snapshot(),diagnosticListUpdates.snapshot());
        }
        else if(body.op==='check' && !body.id){if(!domainUpdates.task)domainUpdates.start('check');if(!diagnosticListUpdates.task)diagnosticListUpdates.start('check');}
        return send(req.method==='POST'?202:200,result);
      }
      if(key==='GET /api/system') return send(200,{...await collectMetrics(),modules,moduleVersions:installedModuleVersions(moduleVersions)});
      if(key==='GET /api/status') return send(200,{version:'0.1.0', mode:'development', networkActive:false, modules, moduleVersions:installedModuleVersions(moduleVersions)});
      if(key==='GET /api/connection-journal'){
        const data=await connectionJournal.poll();const client=url.searchParams.get('client');
        const blocked=blockedJournal.snapshot();
        const presence=await clientPresence(store.networkSettings());
        const clients=clientActivity(clientsView(store),presence,null);
        const connections=accessPoints.describe(describeConnections([...data.connections,...blocked.connections],{clients}));
        return send(200,{...data,blockedSources:blocked.sources,connections:client?connections.filter(row=>row.sourceIP===client):connections});
      }
      if(req.method==='DELETE' && url.pathname.startsWith('/api/connection-journal/')){
        const id=decodeURIComponent(url.pathname.slice('/api/connection-journal/'.length));
        try{return await connectionJournal.close(id)?send(200,{ok:true}):send(404,{error:"Connection is already closed."});}
        catch{return send(502,{error:"Could not close the connection."});}
      }
      if(key==='GET /api/clients') {const presence=await clientPresence(store.networkSettings());return send(200,{clients:[...clientActivity(clientsView(store),presence,supervisor?.routeTraffic?.()),...await accessPoints.remoteClients()]});}
      if(key==='POST /api/clients/static') { try { const lease=await filterPolicy.mutate(()=>store.pinStaticLease(body)); await applyLeases(store.staticLeases()).catch(error=>console.error('FreedomGate: leases apply failed:', error.message)); return send(200,lease); } catch(error) { return send(400,{error:error.message}); } }
      if(req.method==='DELETE' && /^\/api\/clients\/static\/[0-9a-f:]+$/i.test(url.pathname)) { const mac=decodeURIComponent(url.pathname.split('/').pop()); const ok=await filterPolicy.mutate(()=>store.unpinStaticLease(mac)); await applyLeases(store.staticLeases()).catch(error=>console.error('FreedomGate: leases apply failed:', error.message)); return send(ok?200:404,{ok}); }
      if(key==='GET /api/domain-lists/search') return send(200,{presets:searchDomainPresets(url.searchParams.get('q'))});
      if(key==='GET /api/domain-lists') return send(200,domainListsStatus());
      if(key==='POST /api/domain-lists/update') { try { return send(200,await refreshDomainLists()); } catch(error) { return send(502,{error:error.message}); } }
      if(req.method==='GET' && /^\/api\/domain-lists\/[\w!@%-]+$/.test(url.pathname)) { const id=decodeURIComponent(url.pathname.split('/').pop()); const domains=domainListDomains(id); return domains===null ? send(404,{error:"Preset not found."}) : send(200,{id,domains}); }
      if(key==='GET /api/zapret') return send(200,store.zapretSettings());
      if(key==='PUT /api/zapret') {
        if(!session.csrf) return send(401,{error:"Authentication is required."});
        let saved;
        try{saved=store.updateZapretSettings(body);}catch(error){return send(400,{error:error.message});}
        try {
          const applied=await zapretApply({settings:saved,strategy:saved.strategy||null});
          if(!applied.ok)return send(502,{...saved,error:applied.error || "Failed to apply the strategy."});
          return send(200,{...saved,applied});
        } catch(error) {
          return send(502,{...saved,error:error.message});
        }
      }
      if(key==='GET /api/zapret/status') { try { return send(200,await zapretStatus()); } catch(error) { return send(200,{ok:false,error:error.message}); } }
      if(key==='POST /api/zapret/autotune') {
        if(!session.csrf) return send(401,{error:"Authentication is required."});
        let target;
        try { target=normalizeTarget(body.target); } catch(error) { return send(400,{error:error.message}); }
        const current=store.zapretSettings();
        const candidate={...current,...body};
        const plan=await runAutotune(candidate,{target,probe:zapretProbe ? (strategy,target)=>zapretProbe(strategy,target,candidate) : null});
        if(!plan.ok) return send(503,{error:plan.results[0]?.error || "Failed to find a working strategy.",results:plan.results,target});
        const winner={...candidate,mode:plan.mode,strategy:plan.strategy};
        const applied=await zapretApply({settings:winner,strategy:plan.strategy});
        if(!applied.ok)return send(502,{error:applied.error || "Failed to apply the strategy."});
        const settings=store.updateZapretSettings(winner);
        return send(200,{settings,plan});
      }
      if(url.pathname.startsWith('/api/gateway-subscriptions')){
        res.setHeader('Cache-Control','no-store');
        if(!roles[session.role].includes('profiles:write'))return send(403,{error:'Insufficient permissions.'});
        try{
          if(key==='GET /api/gateway-subscriptions')return send(200,gatewaySubscriptions.list());
          if(key==='POST /api/gateway-subscriptions/preview'){const controller=new AbortController(),abort=()=>controller.abort();res.once('close',abort);try{return send(200,await gatewaySubscriptions.preview(body,{signal:controller.signal}));}finally{res.removeListener('close',abort);}}
          if(key==='POST /api/gateway-subscriptions')return send(201,await gatewaySubscriptions.save(null,body));
          const match=/^\/api\/gateway-subscriptions\/([\w-]+)(?:\/(refresh|settings))?$/.exec(url.pathname);
          if(match){const id=match[1];if(req.method==='GET' && !match[2])return send(200,gatewaySubscriptions.details(id));
            if(req.method==='PUT' && match[2]==='settings')return send(200,await gatewaySubscriptions.configure(id,body));
            if(req.method==='POST' && match[2]==='refresh')return send(200,await gatewaySubscriptions.refresh(id,{profileId:body.profileId}));
            if(req.method==='PUT' && !match[2])return send(200,await gatewaySubscriptions.save(id,body));
            if(req.method==='DELETE' && !match[2])return send(200,gatewaySubscriptions.remove(id));}
          return send(404,{error:'Subscription not found.'});
        }catch(error){return send(error.status || 400,{error:error.message,...(error.code?{code:error.code,inUse:error.inUse}: {})});}
      }
      if(key==='GET /api/connection-groups') return send(200,store.connectionGroups());
      if(req.method==='POST' && /^\/api\/profiles\/[\w-]+\/diagnostics$/.test(url.pathname)) {
        const id=url.pathname.split('/')[3];
        let diagnosticProfile=store.profiles().find(profile=>profile.id===id);
        if(!diagnosticProfile)return send(404,{error:'Gateway not found.'});
        diagnosticProfile={...diagnosticProfile,enabled:true};
        const localDiagnostic=isLocalDiagnostic(diagnosticProfile);
        if(!supervisor?.diagnoseGateway)return send(503,{error:'Diagnostics are unavailable.'});
        if(diagnosticRunning)return send(409,{error:'Diagnostics are already running.'});
        if(body.domains!==undefined){
          let domains,providers,endpointDns,dnsFamily;
          try{
            domains=normalizeDiagnosticDomains(body.domains);
            dnsFamily=body.dnsFamily ?? 4;if(![4,6].includes(dnsFamily))throw Error('Invalid DNS transport family.');
            providers=dnsMatrixProviders(body.dnsProviders).map(row=>row.id);
            const source=body.endpointDnsSource ?? 'doh';
            if(!localDiagnostic && body.endpoint===true && !['system','doh'].includes(source))throw Error('Invalid endpoint DNS parameters.');
            endpointDns={source,provider:dnsMatrixProviders([!localDiagnostic && body.endpoint===true?(body.endpointDnsProvider ?? providers[0]):providers[0]])[0].id};
          }catch(error){return send(400,{error:error.message});}
          const controller=new AbortController(),abort=()=>controller.abort();
          const streaming=req.headers.accept==='application/x-ndjson';
          const checks={https:true,endpoint:!localDiagnostic && !['tor','lantern'].includes(diagnosticProfile.engine) && body.endpoint===true,uplink:!localDiagnostic && body.uplink===true,dns:body.dns===true,sni:body.sni===true,transfer:body.transfer===true,tlsVersions:body.tlsVersions===true,http3:body.http3===true && !gatewayUsesTcpOnly(store.profiles(),id),mtu:!localDiagnostic && !['tor','lantern'].includes(diagnosticProfile.engine) && body.endpoint===true && body.mtu===true,pairedTransfer:!localDiagnostic && body.pairedTransfer===true,speedtest:body.speedtest===true,protocols:body.protocols===true};
          const parameters={domains,...(checks.tlsVersions || checks.http3?{protocolDns:{provider:providers[0],family:4}}:{}),...(checks.dns?{dns:{providers,family:dnsFamily}}:{}),...(checks.endpoint?{endpoint:{...endpointDns,providers:[...new Set([endpointDns.provider,...(body.dnsProviders?providers:[])])].slice(0,2),tcpCapture:body.tcpCapture===true}}:{})};
          const startedAt=new Date().toISOString();let environment;
          const identity=()=>{let value;try{value=supervisor.gatewayLocations?.get(diagnosticProfile);}catch{}return {state:value?.status==='ok'?'available':'unavailable',observation:'cached-gateway-location',...(value?.status==='ok'?Object.fromEntries(['ip','country','countryCode','city','provider','asn','source','checkedAt'].map(key=>[key,value[key] ?? null])):{})};};
          const decorate=(report,finishedAt=null)=>diagnosticMetadata(report,{environment,startedAt,finishedAt,checks,parameters:(report.torConnection && report.torConnection.outcome!=='ok' || report.lanternConnection && report.lanternConnection.outcome!=='ok')?Object.fromEntries(Object.entries(parameters).filter(([key])=>key!=='domains')):parameters});
          const event=value=>{if(streaming && !res.destroyed)res.write(JSON.stringify(value)+'\n');};
          res.once('close',abort);diagnosticRunning=true;let releaseGateway;
          try{
            if(streaming){res.writeHead(200,{'Content-Type':'application/x-ndjson; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Accel-Buffering':'no'});res.flushHeaders();}
            event({type:'progress',progress:{state:'running',startedAt,steps:[{id:'preparing',state:'running'}]}});
            releaseGateway=await diagnosticGatewaySession(store,supervisor,id,{signal:controller.signal});
            if(!gatewayUsesTcpOnly(store.profiles(),id))await supervisor.checkGatewayConnection?.(id,{signal:controller.signal});
            const fakeIpRanges=[store.dnsSettings(),supervisor._lastSettings].filter(settings=>settings?.enhancedMode==='fake-ip').map(settings=>settings.fakeIpRange).filter(Boolean);
            const blocklistLookup=diagnosticBlocklist.snapshot();
            const result=await diagnoseDomains({domains,checks,...(diagnosticProfile.engine==='tor'?{budgetMs:420000}:{}),profile:diagnosticProfile,local:localDiagnostic,signal:controller.signal,
              onProgress:value=>event({...value,report:decorate({...value.report,egressIdentity:identity()})}),
              services:{
                ...(gatewayUsesLantern(store.profiles(),id)?{lantern:async options=>{const lanternId=gatewayInChain(store.profiles(),id,'lantern')?.id;const result=await waitForLantern(supervisor.lantern?.entries.get(lanternId),options);if(result.outcome==='ok')await supervisor.checkGatewayConnection?.(id,{signal:options.signal});return result;}}:{}),
                ...(gatewayInChain(store.profiles(),id,'tor')?{tor:async options=>{const torId=gatewayInChain(store.profiles(),id,'tor')?.id;const result=await waitForTor(supervisor.tor?.entries.get(torId),options);if(result.outcome==='ok')await supervisor.checkGatewayConnection?.(id,{signal:options.signal});return result;}}:{}),
                prepare:async()=>{let engines=[];try{engines=supervisor.diagnosticEngines?.(id) || [];}catch{}environment=await diagnosticEnvironment({engines,python:true,zapret:checks.endpoint || diagnosticProfile.engine==='zapret'});return environment;},
                identity,
                blocklist:domain=>blocklistLookup(domain),
                gateway:options=>supervisor.diagnoseGateway(id,options),
                direct:options=>{const direct=store.profiles().find(row=>row.engine==='direct');if(!direct)throw Error('Direct connection is unavailable.');return supervisor.diagnoseGateway(direct.id,options);},
                endpoint:signal=>diagnoseEndpoint(gatewayPeer(store.profileSnapshot(id)),{signal,probe:diagnosticEndpoint,dnsSource:endpointDns.source,dohProvider:endpointDns.provider,dohProviders:[...new Set([endpointDns.provider,...(body.dnsProviders?providers:[])])].slice(0,2),resolveDoh:diagnosticEndpointDns,capture:body.tcpCapture===true,fakeIpRanges}),
                mtu:({endpoint,signal})=>diagnosticProfile.gatewayId || diagnosticProfile.gateway_id?Promise.resolve({state:'unavailable',outcome:'unavailable',reason:'wrapped-route',attempts:[]}):endpoint?.addresses?.length?diagnosticMtu({address:endpoint.addresses[0]},{signal}):Promise.resolve({state:'unavailable',outcome:'unavailable',reason:'endpoint-address-unavailable',attempts:[]}),
                endpointRoute:({endpoint,signal})=>endpoint?.addresses?.length?diagnosticRoute({addresses:endpoint.addresses.slice(0,2),port:endpoint.port},{signal}):Promise.resolve({state:'unavailable',reason:'endpoint-address-unavailable',results:[]}),
                endpointDetailed:signal=>diagnoseEndpoint(gatewayPeer(store.profileSnapshot(id)),{signal,probe:diagnosticEndpoint,dnsSource:endpointDns.source,dohProvider:endpointDns.provider,dohProviders:[...new Set([endpointDns.provider,...(body.dnsProviders?providers:[])])].slice(0,2),resolveDoh:diagnosticEndpointDns,capture:true,fakeIpRanges}),
                pathComparison:({signal,onProgress,endpoint})=>{
                  if(body.comparePaths===false)return Promise.resolve({state:'completed',outcome:'unavailable',reason:'comparison-disabled',results:[]});
                  const snapshot=store.profileSnapshot(id),initial=proxySnapshotFingerprint(snapshot),profiles=store.profiles();
                  return diagnosticComparison({snapshot,endpoint,signal,onProgress,
                    candidates:gatewayWrapCandidates(profiles,id).filter(row=>gatewayChainAvailable(profiles,row.id)),
                    verifyControl:(controlId,options)=>supervisor.diagnoseGateway(controlId,options),
                    getControl:controlId=>supervisor.diagnosticControl?.(controlId),
                    isCurrent:()=>proxySnapshotFingerprint(store.profileSnapshot(id))===initial});
                },
                strategies:({signal,onProgress,endpoint,domain})=>{const snapshot=store.profileSnapshot(id),initial=proxySnapshotFingerprint(snapshot);return diagnosticStrategies({snapshot,endpoint,domain,signal,onProgress,isCurrent:()=>proxySnapshotFingerprint(store.profileSnapshot(id))===initial});},
                dnsDirect:(request,options)=>diagnosticDns({...request,providers,family:dnsFamily},options),
                dnsGateway:options=>supervisor.diagnoseGatewayDns(id,{...options,providers,family:dnsFamily}),
                sniDirect:(request,options)=>Promise.resolve(diagnosticSni({...request,fakeIpRanges},options)).then(summarizeSni),
                sniGateway:options=>supervisor.diagnoseGatewaySni(id,{...options,fakeIpRanges}),
                tlsVersions:options=>supervisor.diagnoseTlsVersions?.(id,{...options,provider:providers[0]}) || Promise.resolve({state:'completed',outcome:'unavailable',attempts:[]}),
                http3:options=>supervisor.diagnoseHttp3?.(id,{...options,provider:providers[0]}) || Promise.resolve({state:'completed',outcome:'unavailable',attempts:[]}),
                transfer:options=>supervisor.diagnoseTransfer(id,options),
                pairedTransfer:options=>supervisor.compareTransfer?.(id,options) || Promise.resolve({state:'completed',outcome:'unavailable',reason:'probe-unavailable',results:[]}),
                protocols:options=>supervisor.diagnoseProtocols?supervisor.diagnoseProtocols(id,{...options,provider:providers[0]}):Promise.resolve({state:'completed',outcome:'unavailable',protocols:{},attempts:[]}),
                speedtest:options=>supervisor.diagnoseSpeed?supervisor.diagnoseSpeed(id,options):Promise.resolve({state:'completed',outcome:'unavailable',attempts:[],metrics:{}})
              }});
            delete result.environment;
            const report=decorate(result,result.finishedAt);
            await releaseGateway?.();
            if(streaming){event({type:'result',report});res.end();try{store.recordEvent(actor,auditAction(req.method,req.url,eventDetail),200);}catch{}return;}
            return send(200,report);
          }catch{
            const error=controller.signal.aborted?'Diagnostic cancelled.':'Failed to run gateway diagnostics.';
            if(streaming){event({type:'error',error});res.end();try{store.recordEvent(actor,auditAction(req.method,req.url,eventDetail),503);}catch{}return;}
            return send(503,{error});
          }finally{try{await releaseGateway?.();}catch{console.error('FreedomGate: failed to restore gateway after diagnostics.');}diagnosticRunning=false;res.removeListener('close',abort);}
        }
        let dnsRequest,sniName,endpointDns;
        if(!localDiagnostic && body.endpoint===true){
          try{const source=body.endpointDnsSource ?? 'doh';if(!['system','doh'].includes(source))throw Error();endpointDns={source,...(source==='doh'?{provider:dnsMatrixProviders([body.endpointDnsProvider ?? dnsMatrixProviders()[0].id])[0].id}:{}),...(body.tcpCapture===true?{tcpCapture:true}:{})};}
          catch{return send(400,{error:'Invalid endpoint DNS parameters.'});}
        }
        if(body.sni===true){try{sniName=normalizeDnsMatrixName(body.sniName);}catch{return send(400,{error:'Invalid SNI diagnostic parameters.'});}}
        if(body.dns===true){
          try{dnsRequest={name:normalizeDnsMatrixName(body.dnsName),providers:dnsMatrixProviders(body.dnsProviders).map(row=>row.id)};}
          catch{return send(400,{error:'Invalid DNS matrix parameters.'});}
        }
        const controller=new AbortController(),abort=()=>controller.abort();
        res.once('close',abort);diagnosticRunning=true;let releaseGateway;
        const streaming=req.headers.accept==='application/x-ndjson';
        const steps=['preparing','websites',...(!localDiagnostic && body.endpoint===true?['server']:[]),...(!localDiagnostic && body.uplink===true?['internet']:[]),...(dnsRequest?(localDiagnostic?['dns-gateway']:['dns-direct','dns-gateway']):[]),...(sniName?(localDiagnostic?['sni-gateway']:['sni-direct','sni-gateway']):[]),...(body.transfer===true?['downloads']:[])].map(id=>({id,state:'pending'}));
        const measurementStartedAt=new Date().toISOString();
        let report,environment,checks,parameters;
        const event=value=>{if(streaming && !res.destroyed)res.write(JSON.stringify(value)+'\n');};
        const snapshot=()=>report?diagnosticMetadata(diagnosticContext(structuredClone({...report,progress:{state:'running',startedAt:measurementStartedAt,steps}}),diagnosticProfile),{environment,startedAt:measurementStartedAt,finishedAt:null,checks,parameters}):null;
        const progress=(id,done=false)=>{
          const step=steps.find(row=>row.id===id);step.state=done?'finished':'running';
          event({type:'progress',progress:{state:'running',startedAt:measurementStartedAt,steps:structuredClone(steps)},...(done && report?{report:snapshot()}:{})});
        };
        if(streaming){res.writeHead(200,{'Content-Type':'application/x-ndjson; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Accel-Buffering':'no','Referrer-Policy':'same-origin'});res.flushHeaders();}
        try{
          progress('preparing');
          releaseGateway=await diagnosticGatewaySession(store,supervisor,id,{signal:controller.signal});
          await supervisor.checkGatewayConnection?.(id,{signal:controller.signal});
          checks={https:true,endpoint:!localDiagnostic && !['tor','lantern'].includes(diagnosticProfile.engine) && body.endpoint===true,uplink:!localDiagnostic && body.uplink===true,dns:!!dnsRequest,sni:!!sniName,transfer:body.transfer===true};
          parameters={...(endpointDns?{endpoint: endpointDns}:{}),...(dnsRequest?{dns:dnsRequest}:{}),...(sniName?{sni:{name:sniName}}:{})};
          let engines=[];try{engines=supervisor.diagnosticEngines?.(id) || [];}catch{}
          environment=await diagnosticEnvironment({engines,python:true,zapret:checks.endpoint || diagnosticProfile.engine==='zapret' || (diagnosticProfile.engine==='outline' && diagnosticProfile.dpiBypass && !diagnosticProfile.gatewayId)});
          if(controller.signal.aborted)throw Error('Diagnostic cancelled.');
          progress('preparing',true);progress('websites');
          report=await supervisor.diagnoseGateway(id,{signal:controller.signal});
          // A separately observed cached exit identity is context, not proof of this run's path.
          let identity;try{identity=supervisor.gatewayLocations?.get(diagnosticProfile);}catch{}
          report.egressIdentity={state:identity?.status==='ok'?'available':'unavailable',observation:'cached-gateway-location',...(identity?.status==='ok'?Object.fromEntries(['ip','country','countryCode','city','provider','asn','source','checkedAt'].map(key=>[key,identity[key] ?? null])):{})};
          progress('websites',true);
          if(!localDiagnostic && body.endpoint===true && !controller.signal.aborted){
            progress('server');
            try{report.endpointControl=await diagnoseEndpoint(gatewayPeer(store.profileSnapshot(id)),{signal:controller.signal,probe:diagnosticEndpoint,dnsSource:endpointDns.source,dohProvider:endpointDns.provider,resolveDoh:diagnosticEndpointDns,capture:body.tcpCapture===true,fakeIpRanges:[store.dnsSettings(),supervisor._lastSettings].filter(settings=>settings?.enhancedMode==='fake-ip').map(settings=>settings.fakeIpRange)});}
            catch{report.endpointControl={state:'unavailable',reason:'endpoint-probe-unavailable'};}
            progress('server',true);
          }
          // Separate controls: a successful uplink does not verify the gateway's path.
          if(!localDiagnostic && body.uplink===true && !controller.signal.aborted){
            progress('internet');
            try{report.uplinkControl=await diagnosticUplink({signal:controller.signal});}
            catch{report.uplinkControl={ok:false,error:'Uplink diagnostics are unavailable.'};}
            progress('internet',true);
          }
          if(dnsRequest && !controller.signal.aborted){
            if(!localDiagnostic){progress('dns-direct');try{report.dnsMatrix=await diagnosticDns(dnsRequest,{signal:controller.signal});}
            catch{report.dnsMatrix={ok:false,state:'unavailable',error:'DNS matrix is unavailable.'};}progress('dns-direct',true);}
            if(!controller.signal.aborted){
              progress('dns-gateway');
              try{report.gatewayDnsMatrix=supervisor.diagnoseGatewayDns?await supervisor.diagnoseGatewayDns(id,{...dnsRequest,signal:controller.signal}):{ok:false,state:'unavailable'};}
              catch{report.gatewayDnsMatrix={ok:false,state:'unavailable'};}
              progress('dns-gateway',true);
              if(!localDiagnostic)report.dnsPathComparisons=compareDnsPaths(report.dnsMatrix,report.gatewayDnsMatrix);
            }
          }
          if(sniName && !controller.signal.aborted){
            const fakeIpRanges=[store.dnsSettings(),supervisor._lastSettings].filter(settings=>settings?.enhancedMode==='fake-ip').map(settings=>settings.fakeIpRange).filter(Boolean);
            if(!localDiagnostic){progress('sni-direct');try{report.sniControl=summarizeSni(await diagnosticSni({name:sniName,fakeIpRanges},{signal:controller.signal}));}
            catch{report.sniControl={ok:false,state:'unavailable'};}progress('sni-direct',true);}
            if(!controller.signal.aborted){
              progress('sni-gateway');
              try{report.gatewaySniControl=supervisor.diagnoseGatewaySni?await supervisor.diagnoseGatewaySni(id,{name:sniName,fakeIpRanges,signal:controller.signal}):{ok:false,state:'unavailable'};}
              catch{report.gatewaySniControl={ok:false,state:'unavailable'};}
              progress('sni-gateway',true);
            }
          }
          if(body.transfer===true && !controller.signal.aborted){
            progress('downloads');
            try{report.transfer=supervisor.diagnoseTransfer?await supervisor.diagnoseTransfer(id,{signal:controller.signal}):{ok:false,outcome:'unavailable'};}
            catch{report.transfer={ok:false,outcome:'unavailable'};}
            progress('downloads',true);
          }
          if(controller.signal.aborted)throw Error('Diagnostic cancelled.');
          diagnosticContext(report,diagnosticProfile);
          report.progress={state:'completed',startedAt:measurementStartedAt,steps};
          const result=diagnosticMetadata(report,{environment,startedAt:measurementStartedAt,finishedAt:new Date().toISOString(),checks,parameters});
          await releaseGateway?.();
          if(streaming){event({type:'result',report:result});res.end();try{store.recordEvent(actor,auditAction(req.method,req.url,eventDetail),200);}catch{}return;}
          return send(200,result);
        }
        catch{
          const error=controller.signal.aborted?'Diagnostic cancelled.':'Failed to run gateway diagnostics.';
          if(streaming){event({type:'error',error});res.end();try{store.recordEvent(actor,auditAction(req.method,req.url,eventDetail),503);}catch{}return;}
          return send(503,{error});
        }
        finally{try{await releaseGateway?.();}catch{console.error('FreedomGate: failed to restore gateway after diagnostics.');}diagnosticRunning=false;res.removeListener('close',abort);}
      }
      if(key==='GET /api/profiles/telemetry') return send(200,supervisor?.telemetry ? await supervisor.telemetry(store.profiles(),store.connectionGroups()) : {available:false,profiles:{},groups:{}});
      if(key==='POST /api/connection-groups') {
        try {const group=store.saveConnectionGroup(null,body);await applyRoutesIfReady(store,supervisor);return send(201,group);}
        catch(error){return send(400,{error:error.message});}
      }
      if(/^\/api\/connection-groups\/[\w-]+$/.test(url.pathname) && ['PUT','DELETE'].includes(req.method)) {
        try {
          const id=url.pathname.split('/').pop();
          const result=req.method==='PUT' ? store.saveConnectionGroup(id,body) : store.removeConnectionGroup(id);
          if(!result)return send(404,{error:"Group not found."});
          await applyRoutesIfReady(store,supervisor);
          return send(200,req.method==='PUT' ? result : {ok:true});
        } catch(error){return send(400,{error:error.message});}
      }
      if(req.method==='GET' && /^\/api\/profiles\/[\w-]+\/config$/.test(url.pathname)) {
        res.setHeader('Cache-Control','no-store');
        if(!roles[session.role].includes('profiles:write'))return send(403,{error:"Insufficient permissions."});
        const snapshot=store.profileSnapshot(url.pathname.split('/')[3]);
        if(!snapshot)return send(404,{error:"Connection not found."});
        try{return send(200,gatewayEditor(snapshot));}catch(error){return send(400,{error:error.message});}
      }
      if(key==='GET /api/changes/status')return send(200,inlineChanges.status());
      if(key==='GET /api/profiles') {
        const subscriptionMembership=gatewaySubscriptions.membership();
        const managedIds=new Set(gatewayDeployments.list().map(row=>row.profileId).filter(Boolean));
        return send(200,store.profiles().map(profile=>({...profile,...subscriptionMembership.get(profile.id),managed:managedIds.has(profile.id),...(profile.engine==='lantern'?{lantern:supervisor?.lantern?.status()?.[profile.id] || {state:'stopped'}}:{}),...(profile.engine==='tor'?{tor:supervisor?.tor?.status()?.[profile.id] || {state:'stopped'}}:{})})));
      }
      if(req.method==='PUT' && /^\/api\/profiles\/[\w-]+$/.test(url.pathname)) {
        const id=url.pathname.split('/').pop(),previous=store.profileSnapshot(id);
        if(gatewaySubscriptions.isBusy(id))return send(409,{error:'This subscription is already updating.'});
        if(!previous)return send(404,{error:"Connection not found."});
        if(previous.profile.engine==='lantern' && body.enabled===true){try{verifyLantern(lanternBinary());}catch(error){return send(400,{error:error.message});}}
        if(Object.keys(body).length===1 && Object.hasOwn(body,'enabled')){
          try{if(body.enabled!==false)await assertNoResolvedAccessPointGateway(store.previewGatewayChange(body,id),()=>accessPoints.repository.all());const updated=await inlineChanges.change(()=>store.updateProfile(id,body));return send(200,{...updated,apply:inlineChanges.status()});}
          catch(error){return send(400,{error:error.message});}
        }
        try {if(!(body.enabled===false && body.value===undefined && body.editor===undefined))await assertNoResolvedAccessPointGateway(store.previewGatewayChange(body,id),()=>accessPoints.repository.all());}catch(error){return send(400,{error:error.message});}
        try {const updated=store.updateProfile(id,body);await applyRoutesIfReady(store,supervisor);return send(200,updated);}
        catch(error){store.restoreProfile(previous);await applyRoutesIfReady(store,supervisor).catch(()=>{});return send(400,{error:error.message});}
      }
      if(key==='POST /api/profiles') return send(201,store.addProfile(body));
      if(key==='POST /api/profiles/import') {
        let profile;
        try {await assertNoResolvedAccessPointGateway(store.previewGatewayChange(body),()=>accessPoints.repository.all());profile=store.importProfiles(body);await applyRoutesIfReady(store,supervisor);return send(201,profile.length===1?profile[0]:{profiles:profile});}
        catch(error){
          if(profile){for(const row of profile)store.removeProfile(row.id);await applyRoutesIfReady(store,supervisor).catch(()=>{});}
          return send(400,{error:error.message});
        }
      }
      if(req.method==='PUT' && /^\/api\/routes\/(groups|devices|locals)\/[\w-]+\/enabled$/.test(url.pathname)) {
        const [, , ,kind,id]=url.pathname.split('/');
        const rows=kind==='groups'?store.routeGroups():kind==='devices'?store.deviceRoutes():store.localRoutes();
        const previous=rows.find(row=>row.id===id);
        if(!previous)return send(404,{error:"Rule not found."});
        try {
          const result=await inlineChanges.change(async()=>{return filterPolicy.mutate(()=>store.setRouteEnabled(kind,id,body.enabled));});
          return send(200,{...result,apply:inlineChanges.status()});
        }catch(error){return send(400,{error:error.message});}
      }
      if(key==='GET /api/routes/usage') return send(200,{groups:store.db.prepare('SELECT id,route_id AS routeId FROM route_groups').all(),devices:store.db.prepare('SELECT id,route_id AS routeId FROM device_routes').all()});
      if(key==='GET /api/routes/traffic')return send(200,supervisor?.routeTraffic ? supervisor.routeTraffic() : {available:false,groups:{},devices:{}});
      if(key==='GET /api/routes') {await filterPolicy.load();return send(200,{groups:store.routeGroups(),subscriptions:store.adGuardSettings()?.subscriptions || [],devices:store.deviceRoutes(),locals:store.localRoutes()});}
      if(req.method==='POST' && /^\/api\/routes\/groups\/[\w-]+\/move$/.test(url.pathname)) {try {await inlineChanges.change(async()=>{return filterPolicy.mutate(()=>store.moveRouteGroup(url.pathname.split('/')[4],body.direction));});return send(200,{ok:true,apply:inlineChanges.status()});}catch(error){return send(400,{error:error.message});}}
      if(key==='POST /api/routes/groups') { try { const group=await routeChange(()=>store.addRouteGroup(body)); return send(201,group); } catch(error) { return send(400,{error:error.message}); } }
      if(req.method==='PUT' && /^\/api\/routes\/groups\/[\w-]+$/.test(url.pathname)) { try { const group=await routeChange(()=>store.updateRouteGroup(url.pathname.split('/').pop(),body)); if(!group) return send(404,{error:"Group not found."}); return send(200,group); } catch(error) { return send(400,{error:error.message}); } }
      if(req.method==='DELETE' && /^\/api\/routes\/groups\/[\w-]+$/.test(url.pathname)) { const ok=await routeChange(()=>store.removeRouteGroup(url.pathname.split('/').pop())); return send(ok?200:404,{ok}); }
      if(key==='POST /api/routes/devices') { try { const device=await routeChange(()=>{const row=store.addDeviceRoute(body);pinDeviceRoute(store,row);return row;}); await applyLeases(store.staticLeases()).catch(error=>console.error('FreedomGate: leases apply failed:', error.message)); return send(201,device); } catch(error) { return send(400,{error:error.message}); } }
      if(key==='POST /api/routes/locals') { try { return send(201,await routeChange(()=>store.addLocalRoute(body))); } catch(error) { return send(400,{error:error.message}); } }
      if(req.method==='PUT' && /^\/api\/routes\/locals\/[\w-]+$/.test(url.pathname)) { try { const local=await routeChange(()=>store.updateLocalRoute(url.pathname.split('/').pop(),body)); return local?send(200,local):send(404,{error:"Alias not found."}); } catch(error) { return send(400,{error:error.message}); } }
      if(req.method==='DELETE' && /^\/api\/routes\/locals\/[\w-]+$/.test(url.pathname)) return send(await routeChange(()=>store.removeLocalRoute(url.pathname.split('/').pop()))?200:404,{ok:true});
      if(req.method==='PUT' && /^\/api\/routes\/devices\/[\w-]+$/.test(url.pathname)) { try { const device=await routeChange(()=>{const row=store.updateDeviceRoute(url.pathname.split('/').pop(),body);if(row)pinDeviceRoute(store,row);return row;}); if(!device) return send(404,{error:"Device not found."}); await applyLeases(store.staticLeases()).catch(error=>console.error('FreedomGate: leases apply failed:', error.message)); return send(200,device); } catch(error) { return send(400,{error:error.message}); } }
      if(req.method==='DELETE' && /^\/api\/routes\/devices\/[\w-]+$/.test(url.pathname)) { const ok=await routeChange(()=>store.removeDeviceRoute(url.pathname.split('/').pop())); return send(ok?200:404,{ok}); }
      if(key==='GET /api/settings') return send(200,store.settings());
      if(key==='PUT /api/settings') return send(200,store.updateSettings(body));
      if(key==='GET /api/dns/adguard'){
        if(!filter?.configuration)return send(503,{error:"AdGuard Home is unavailable."});
        await filterPolicy.load();return send(200,{...await filter.configuration(),subscriptions:store.adGuardSettings()?.subscriptions || []});
      }
      if(key==='PUT /api/dns/adguard'){
        if(!filter?.configure)return send(503,{error:"AdGuard Home is unavailable."});
        await filterPolicy.load();const previous=store.adGuardSettings() || await filter.configuration(),value=await filter.configure({...previous,...body});try{await filterPolicy.change(()=>store.saveAdGuardSettings(value));}catch(error){if(previous){store.saveAdGuardSettings(previous);await filter.configure(previous).catch(()=>{});}throw error;}return send(200,value);
      }
      if(key==='GET /api/diagnostics/dns/providers')return send(200,dnsMatrixCatalog());
      if(key==='GET /api/dns') return send(200,{settings:store.dnsSettings(),resolvers:dnsResolvers,bootstrap:bootstrapResolvers,engine:supervisor?supervisor.status():{state:'unavailable'},filter:filter?filter.status():{state:'unavailable'}});
      if(key==='GET /api/network/traffic') return send(200,await collectNetworkTraffic());
      if(key==='GET /api/network') {
        const available=interfaces();
        const stored=store.networkSettings(available);
        if(!available.length) return send(200,{interfaces:[],setup:stored,plan:[],warnings:['No network interfaces were found on this host.']});
        try {
          const setup=validateNetworkSetup(stored,available);
          return send(200,{interfaces:available,setup,plan:buildNetworkPlan(setup),warnings:setup.warnings||[]});
        } catch(error) {
          return send(200,{interfaces:available,setup:stored,plan:[],warnings:[error.message]});
        }
      }
      if(key==='PUT /api/network') { const available=interfaces(); const setup=store.updateNetworkSettings(body,available); return send(200,{setup,plan:buildNetworkPlan(setup),interfaces:available}); }
      if(key==='POST /api/network/plan') { const setup=validateNetworkSetup(body,interfaces()); return send(200,{setup,plan:buildNetworkPlan(setup)}); }
      if(key==='GET /api/network/status') { try { return send(200,await networkStatus()); } catch(error) { return send(200,{ok:false,error:error.message,unavailable:true}); } }
      if(key==='POST /api/network/apply') {
        const available=interfaces();
        const setup=validateNetworkSetup(body,available);
        const result=await networkApply({...setup, staticLeases: store.staticLeases()});
        if(!result.ok) return send(502,{error:result.error,setup,plan:buildNetworkPlan(setup)});
        // Persist only a successfully applied configuration for the next startup.
        store.updateNetworkSettings(setup,available);
        if(supervisor) {
          supervisor.lanSubnets=[setup.client.subnet,...(setup.wired?.enabled?[setup.wired.subnet]:[])];
          await applyRoutesIfReady(store,supervisor);
        }
        try { await zapretApply({settings:store.zapretSettings(),strategy:store.zapretSettings().strategy||null}); }
        catch(error) { console.error('FreedomGate: zapret apply after network failed:', error.message); }
        return send(200,{setup,plan:buildNetworkPlan(setup),result});
      }
      if(key==='POST /api/network/stop') { const result=await stopNetwork(); return send(200,{ok:true,result}); }
      if(key==='POST /api/system/action') {
        const action=String(body?.action||'');
        eventDetail=action;
        if(!['config','reboot','poweroff'].includes(action)) return send(400,{error:"Unknown action."});
        try { await networkStatus(); } catch(error) { return send(503,{error:"Privileged helper is unavailable."}); }
        send(200,{ok:true});
        setTimeout(()=>{ systemAction(action).catch(()=>{}); },150);
        return;
      }
      if(key==='GET /api/dns/engine') return send(200,{engine:supervisor?supervisor.status():{state:'unavailable'},filter:filter?filter.status():{state:'unavailable'}});
      if(key==='PUT /api/dns') {
        const settings=validateDnsSettings(body);
        if(supervisor && supervisor.status().state!=='unavailable'){
          const applied=await supervisor.apply(settings);
          if(!applied.ok) return send(502,{error:"Failed to apply settings: "+applied.error,engine:supervisor.status(),filter:filter?filter.status():{state:'unavailable'}});
        }
        const saved=store.updateDnsSettings(settings);
        if(filter && filter.status().state!=='unavailable') await filter.ensure();
        return send(200,{settings:saved,engine:supervisor?supervisor.status():{state:'unavailable'},filter:filter?filter.status():{state:'unavailable'}});
      }
      if(key==='POST /api/dns/apply') {
        if(!supervisor || supervisor.status().state==='unavailable') return send(503,{error:"The mihomo engine is not installed.",engine:supervisor?supervisor.status():{state:'unavailable'}});
        const settings=store.dnsSettings();
        const applied=await supervisor.apply(settings);
        if(!applied.ok) return send(502,{error:"Failed to apply settings: "+applied.error,engine:supervisor.status(),filter:filter?filter.status():{state:'unavailable'}});
        if(filter && filter.status().state!=='unavailable') await filter.ensure();
        return send(200,{engine:supervisor.status(),filter:filter?filter.status():{state:'unavailable'}});
      }
      if(key==='GET /api/dns/status') {
        const settings=store.dnsSettings();
        return send(200,{statuses:await statusesFor(statusTargets(settings),{refresh:url.searchParams.get('refresh')==='1' && session.role==='admin'})});
      }
      if(req.method==='DELETE' && /^\/api\/profiles\/[\w-]+$/.test(url.pathname)) { if(gatewaySubscriptions.isBusy(url.pathname.split('/').pop()))return send(409,{error:'This subscription is already updating.'});try { const removed=store.removeProfile(url.pathname.split('/').pop());if(removed)gatewaySubscriptions.forgetProfile(url.pathname.split('/').pop()); await applyRoutesIfReady(store,supervisor); return send(removed?200:404,{ok:true}); } catch(error) { return send(400,{error:error.message}); } }
      if(url.pathname.startsWith('/api/')) return send(404,{error:"API method not found."});
      await serveInterface(req,res,url,root);
    } catch(error) {
      if(error instanceof HttpError)return send(error.status,{error:error.message});
      if(error instanceof AccessPointError)return send(error.status,{error:error.message});
      if(error instanceof AuthError) return send(error.status,{error:error.message});
      if(error instanceof ValidationError) return send(400,{error:error.message});
      if(error instanceof NetworkError) return send(400,{error:error.message});
      if(error instanceof NetworkHelperError) return send(error.unavailable ? 503 : 502,{error:error.message});
      if(error.code==='ENOENT') return send(503,{error:"Build the interface: npm run build"});
      send(400,{error: error.message?.startsWith("Specify") || error.message==="Unknown network topology." ? error.message:"The request could not be completed."});
    } finally {if(countedWrite)activeWrites--;}
  });
  server.accessPoints=accessPoints;
  server.once('close',()=>{clearInterval(journalTimer);clearInterval(blockedTimer);clearInterval(subscriptionTimer);gatewaySubscriptions.close();blockedJournal.stop();});
  server.once('close',()=>inlineChanges.close());
  server.cleanup=Promise.resolve();
  server.once('close',()=>{server.cleanup=Promise.allSettled([accessPoints.close(),gatewayDeployments.close(),gatewaySubscriptions.close()]);});
  return server;
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const {startRuntime}=await import('./runtime.js');
  startRuntime(createServer);
}
