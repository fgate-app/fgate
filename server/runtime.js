import {restoreStartup,runtimeStartupStages} from './startup.js';
import {Store} from './store.js';
import {MihomoSupervisor} from './mihomo.js';
import {AdGuardSupervisor} from './adguard.js';
import {FilterPolicy} from './filter-policy.js';
import {applyNetwork,applyZapret,networkStatus,stopNetwork,stopZapret} from './network-helper.js';
import {applyRoutesIfReady} from './route-runtime.js';
import {probeTarget} from './route-probe.js';
import {startSystemJournal} from './system-journal.js';

export function startRuntime(createServer) {
  const store=new Store(process.env.FREEDOMGATE_DB || '.data/freedomgate.sqlite');

  const supervisor=new MihomoSupervisor({lanSubnets:[store.networkSettings().client?.subnet,store.networkSettings().wired?.enabled?store.networkSettings().wired.subnet:null].filter(Boolean)});
  const filter=new AdGuardSupervisor();
  const zapretProbe=async (strategy,target,candidate)=>{
    let applied=false;
    try {
      const settings=candidate || store.zapretSettings();
      const result=await applyZapret({settings,strategy:strategy?.id||strategy});
      if(!result.ok) return {ok:false,error:result.error};
      applied=true;
      return {ok:await probeTarget(target)};
    } catch(error) {
      return {ok:false,error:error.message};
    } finally {
      if(applied) await applyZapret({settings:store.zapretSettings(),strategy:store.zapretSettings().strategy||null}).catch(()=>{});
    }
  };
  let restartRequested=false;
  const maintenanceRuntime={
    prepare:async()=>{await server.startup;if(process.env.FREEDOMGATE_APPLY_NETWORK_ON_START==='1')await networkStatus();},
    stop:async()=>{await filter.stop();await supervisor.stop();},
    restart:async()=>{
      if(process.env.FREEDOMGATE_APPLY_NETWORK_ON_START==='1'){
        for(const stop of [stopZapret,stopNetwork])try{await stop();}catch{console.error('FreedomGate: network cleanup before configuration restart failed.');}
      }
      restartRequested=true;process.kill(process.pid,'SIGTERM');
    }
  };
  const server=createServer(store,{supervisor,filter,zapretProbe,maintenanceRuntime});
  const systemJournal=process.platform==='linux'?startSystemJournal(store):null;
  server.once('close',()=>systemJournal?.stop());
  const startupAbort=new AbortController();
  server.runtimeReady=false;
  const host=process.env.HOST || '127.0.0.1';
  server.listen(Number(process.env.PORT || 8787),host,()=>{
    console.log('FreedomGate: http://'+host+':'+server.address().port);
    const stages=runtimeStartupStages({store,supervisor,filter,accessPoints:server.accessPoints,
      networkEnabled:process.env.FREEDOMGATE_APPLY_NETWORK_ON_START==='1' && store.settings().topology==='access-point',
      applyNetwork,applyZapret,applyRoutes:applyRoutesIfReady,filterPolicy:new FilterPolicy(store,filter)});
    server.startup=restoreStartup(stages,{signal:startupAbort.signal,onReady:()=>{server.runtimeReady=true;}})
      .catch(()=>{if(!startupAbort.signal.aborted)console.error('FreedomGate: runtime restore failed: startup');});
  });
  let stopping=false;
  for(const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>{
    if(stopping)return;stopping=true;server.runtimeReady=false;startupAbort.abort();
    server.close(async()=>{
      await server.startup;
      const results=await Promise.allSettled([server.cleanup,filter.stop(),supervisor.stop()]);
      for(const result of results)if(result.status==='rejected')console.error('FreedomGate: shutdown failed:',result.reason?.code || 'cleanup');
      store.close();process.exit(restartRequested?1:0);
    });
    server.closeAllConnections();
  });

  return server;
}
