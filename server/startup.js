import {appendFileSync,existsSync,mkdirSync,renameSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

// Only controlled fields are logged: engine errors may contain credentials.
export function startupLogger({directory=process.env.FREEDOMGATE_STATE_DIR || '/var/lib/freedomgate',output=console.log}={}) {
  const path=join(directory,'startup.jsonl');let warned=false;
  return event=>{
    const line=JSON.stringify(event);output('FreedomGate startup: '+line);
    try {
      mkdirSync(directory,{recursive:true,mode:0o700});
      if(existsSync(path) && statSync(path).size>=1024*1024)renameSync(path,path+'.previous');
      appendFileSync(path,line+'\n',{mode:0o600});
    }catch{if(!warned){output('FreedomGate: startup journal persistence failed.');warned=true;}}
  };
}

export async function restoreStartup(stages,{signal,log=startupLogger(),wait=delay,retryDelays=[2000,5000],now=Date.now,onReady=()=>{}}={}) {
  const started=now();
  const emit=(stage,state,extra={})=>log({time:new Date(now()).toISOString(),stage,state,...extra});
  emit('runtime','started');
  for(const {name,run} of stages){
    for(let attempt=1;;attempt++){
      signal?.throwIfAborted();const begin=now();emit(name,'started',{attempt});
      try {
        const result=await run();signal?.throwIfAborted();
        if(result?.ok===false)throw Object.assign(new Error('Startup stage failed.'),{code:'RESULT_FAILED'});
        emit(name,'completed',{attempt,durationMs:now()-begin});break;
      }catch(error){
        if(signal?.aborted){emit('runtime','cancelled',{durationMs:now()-started});throw signal.reason;}
        // Do not serialize arbitrary codes supplied by engines or external helpers.
        const code=['ENOENT','EACCES','ECONNREFUSED','ETIMEDOUT','RESULT_FAILED'].includes(error?.code)?error.code:'STAGE_FAILED';
        const retryMs=retryDelays[attempt-1];
        emit(name,'failed',{attempt,durationMs:now()-begin,code,retryMs:retryMs??null});
        if(retryMs===undefined){emit('runtime','failed',{stageFailed:name,durationMs:now()-started});return {ok:false,stage:name};}
        try{await wait(retryMs,undefined,{signal});}
        catch(error){if(signal?.aborted)emit('runtime','cancelled',{durationMs:now()-started});throw error;}
      }
    }
  }
  signal?.throwIfAborted();onReady();emit('runtime','completed',{durationMs:now()-started});return {ok:true};
}

export function runtimeStartupStages({store,supervisor,filter,accessPoints,networkEnabled,applyNetwork,applyZapret,applyRoutes,filterPolicy}) {
  return [
    ...(networkEnabled && (store.hasNetworkSettings?.() ?? true)?[
      {name:'network',run:()=>applyNetwork({...store.networkSettings(),staticLeases:store.staticLeases()})},
      {name:'zapret',run:()=>applyZapret({settings:store.zapretSettings()})},
    ]:[]),
    {name:'routes-prepare',run:()=>applyRoutes(store,supervisor)},
    {name:'mihomo',run:()=>supervisor.restore(store.dnsSettings())},
    {name:'access-points',run:()=>accessPoints.restore()},
    {name:'adguard',run:()=>filter.restore()},
    {name:'filter-policy',run:()=>filterPolicy.change(()=>{})},
    {name:'routes-apply',run:()=>applyRoutes(store,supervisor)},
    {name:'runtime-verify',run:()=>{
      const engine=supervisor.status();
      return {ok:engine.state==='running' && filter.status().state==='running' && engine.xray?.state!=='error' && engine.ssRelay?.state!=='error'};
    }},
  ];
}
