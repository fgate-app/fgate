import {isReleaseManagedModule} from '../../../shared/module-policy.js';
import {usePolling} from './usePolling.js';
import {ref,computed,watch,onUnmounted} from 'vue';
import {notify} from '../lib/toasts.js';
import {isInteractive} from '../lib/interactions.js';

export function useModuleManagement({api,status,dnsEngine,dnsFilter,tableLoading,can,run,t,active,userId}) {
const zapretRuntime = ref(null), domainCatalog = ref(null);

const moduleActionErrors=ref({}),updateClock=ref(Date.now());
const updateClockTimer=setInterval(()=>{updateClock.value=Date.now();},1000);
onUnmounted(()=>clearInterval(updateClockTimer));
const moduleUpdates=ref([]),moduleServiceError=ref(''),moduleUpdateDialog=ref(null);
const moduleWorking=computed(()=>moduleUpdates.value.some(row=>['checking','downloading','verifying','installing','restarting'].includes(row.state)));
const releaseManaged=id=>id!=='system' && isReleaseManagedModule(id);
const updateFor=id=>moduleUpdates.value.find(row=>row.id===id);
const moduleStateLabels={checking:'Проверка обновления…',available:'Доступно обновление',downloading:'Загрузка обновления…',verifying:'Проверка файлов…',installing:'Установка обновления…',restarting:'Перезапуск службы…',error:"Update failed"};
function moduleVersionError(row){if(releaseManaged(row.id))return '';return moduleActionErrors.value[row.id] || updateFor(row.id)?.error;}
function moduleVersionNote(row){if(row.id==='system' && updateFor('system')?.supported===false)return t('System updates require a native Linux installation. Rebuild the Docker image externally.');if(releaseManaged(row.id))return ''; if(moduleActionErrors.value[row.id])return t('Update failed');const update=updateFor(row.id);return moduleStateLabels[update?.state]?t(moduleStateLabels[update.state])+(update.state==='available' && update.candidate?.version?' · '+(row.id==='system'?update.candidate.version.slice(0,7):update.candidate.version):''):'';}
const systemStageLabels={source:'Downloading application source',archive:'Checking source archive',cache:'Checking installed modules',torDownload:'Downloading Tor through a gateway',dependencies:'Preparing system dependencies',runtime:'Preparing build tools',reuse:'Checking module reuse',tor:'Preparing Tor / Snowflake',lantern:'Preparing Lantern',outline:'Preparing Outline',backup:'Creating an installation backup',web:'Building the web interface',frp:'Preparing FRP',modules:'Preparing mihomo, Xray, AdGuard and zapret',package:'Preparing the new release',activate:'Activating the new release',restart:'Restarting services',health:'Checking system readiness'};
function moduleProgress(row){const update=updateFor(row.id);if(!['downloading','verifying','installing','restarting'].includes(update?.state))return -1;return row.id==='system'&&Number.isFinite(update.progress)?update.progress:['downloading','verifying','installing','restarting'].indexOf(update.state)*25;}
function moduleProgressDetail(row){const update=updateFor(row.id);if(row.id!=='system'||moduleProgress(row)<0)return '';const label=t(systemStageLabels[update.stage]||moduleStateLabels[update.state]);const action={reuse:'Using verified installed files',download:'Downloading component',build:'Building component'}[update.action];const elapsed=Math.max(0,Math.floor((updateClock.value-(update.startedAt||updateClock.value))/1000));return Math.round(moduleProgress(row))+'% · '+label+(action?' · '+t(action):'')+' · '+Math.floor(elapsed/60)+':'+String(elapsed%60).padStart(2,'0');}
function moduleStatus(row){return row.status;}

const moduleRows = computed(() => {
  const catalogLoaded=domainCatalog.value && (domainCatalog.value.loaded ?? Boolean(domainCatalog.value.updatedAt));
  const versions = {...status.value?.moduleVersions,...Object.fromEntries(moduleUpdates.value.map(row=>[row.id,row.current]))};
  const label = state => ['running','ready','active'].includes(state) ? t('Работает') : state === 'stopped' ? t('Остановлен') : ['error','failed'].includes(state) ? t("Failed") : state === 'unavailable' ? t('Не установлен') : state==='connecting'?t('Подключение'):state==='waiting'?t('Waiting before retrying Tor.'):t('Неизвестно');
  const torStates=Object.values(dnsEngine.value?.tor || {}).map(row=>row.state);
  const torState=dnsEngine.value?.tor==null?'unknown':['unavailable','failed','connecting','waiting','ready'].find(state=>torStates.includes(state)) || 'stopped';

  return [{
    id: 'system',
    name: t('Система (ядро)'),
    version: updateFor('system')?.current && updateFor('system').current!=='—'?updateFor('system').current:status.value?.version || '—',
    status: t('Работает')
  }, {
    id: 'mihomo',
    name: 'mihomo',
    version: versions.mihomo || '—',
    status: label(dnsEngine.value?.state)
  }, {
    id: 'xray',
    name: 'xray',
    version: versions.xray || '—',
    status: label(dnsEngine.value?.xray?.state)
  }, {
    id: 'outline',
    name: 'Shadowsocks Outline SDK',
    version: versions.outline || '—',
    status: label(dnsEngine.value?.ssRelay?.state)
  }, {
    id: 'zapret',
    name: 'zapret2',
    version: versions.zapret || '—',
    status: !zapretRuntime.value?.ok ? t('Неизвестно') : zapretRuntime.value.running && zapretRuntime.value.nftables ? t('Работает') : zapretRuntime.value.running ? t("Failed") : t('Остановлен')
  }, {
    id: 'adguard',
    name: 'adguard',
    version: versions.adguard || '—',
    status: label(dnsFilter.value?.state)
  }, {
    id:'lantern',name:'Lantern',version:versions.lantern || '—',status:label(dnsEngine.value?.lanternInstalled===false?'unavailable':Object.values(dnsEngine.value?.lantern || {}).map(row=>row.state).find(state=>['error','connecting','running'].includes(state)) || 'stopped')
  }, {
    id:'tor',
    name:'Tor / Snowflake',
    version:versions.tor || '—',
    status:label(dnsEngine.value?.torInstalled===false?'unavailable':torState)
  }, {
    id:'frp',
    name:'frp',
    version:versions.frp || '—',
    status:label(updateFor('frp')?.runtimeState)
  }, {
    id: 'domain-lists',
    name: t('Пресеты доменов'),
    version: catalogLoaded?(domainCatalog.value?.ref?.slice(0,7) || versions['domain-lists'] || '—'):'—',
    status: !domainCatalog.value ? t('Неизвестно') : catalogLoaded ? t('Работает') : t('Не загружен')
  }, {
    id:'diagnostic-blocklist',
    name:t('Diagnostic domain list')+' · Re:filter',
    version:versions['diagnostic-blocklist'] || '—',
    status:!updateFor('diagnostic-blocklist')?t('Неизвестно'):t(updateFor('diagnostic-blocklist').loaded?'Работает':'Не загружен')
  }];
});

function moduleActions(module) {
  if(releaseManaged(module.id) || module.id==='system' && !updateFor('system')?.supported)return [];
  const update=updateFor(module.id);
  return [{value:'check',label:t('Проверить обновление'),disabled:moduleWorking.value || !can('users:write')},...(update?.state==='available' && update.supported?[{value:'update',label:t('Обновить'),disabled:moduleWorking.value || !can('users:write')}]:[])];
}
async function checkUpdates(id) {
  if(typeof id==='string')delete moduleActionErrors.value[id];
  try{
    await api('modules',{method:'POST',body:JSON.stringify({op:'check',...(typeof id==='string'?{id}:{})})});
    await loadModuleStatus();return true;
  }catch(error){if(typeof id==='string')moduleActionErrors.value[id]=error.message;else moduleServiceError.value=error.message;return false;}
}
async function onModuleAction(module,value){
  if(value==='check')return checkUpdates(module.id);
  if(value==='update'){moduleUpdateDialog.value=module;return;}
  if(value==='catalog')return run(async()=>{await api('domain-lists/update',{method:'POST',body:'{}'});await loadModuleStatus();notify(t('Каталог обновлён'),'success');});
}
async function installModule(){
 const module=moduleUpdateDialog.value,update=updateFor(module.id);delete moduleActionErrors.value[module.id];
 try{await api('modules',{method:'POST',body:JSON.stringify({op:'update',id:module.id,version:update.candidate.version})});moduleUpdateDialog.value=null;await loadModuleStatus();}
 catch(error){moduleActionErrors.value[module.id]=error.message;moduleUpdateDialog.value=null;}
}
function onModuleRow(module,event){if(isInteractive(event))return;const action=moduleActions(module).find(action=>!action.disabled);if(action)onModuleAction(module,action.value);}

let moduleStatusRequest=0;
async function loadModuleStatus(signal) {
  const request=++moduleStatusRequest,identity=userId();
  const results=await Promise.allSettled([api('zapret/status',{signal}),api('domain-lists',{signal}),api('modules',{signal})]);
  if(request!==moduleStatusRequest || identity!==userId())return;
  tableLoading.value.modules=false;
  zapretRuntime.value=results[0].status==='fulfilled'?results[0].value:null;
  domainCatalog.value=results[1].status==='fulfilled'?results[1].value:null;
  if(results[2].status==='fulfilled'){
    const next=Array.isArray(results[2].value.modules)?results[2].value.modules:[];
    moduleUpdates.value=next.filter(row=>!releaseManaged(row.id));moduleServiceError.value='';
  }else moduleServiceError.value=results[2].reason.message;
}

usePolling(()=>userId() && (moduleWorking.value || active())?userId():null,{
 interval:2000,
 request:signal=>loadModuleStatus(signal),
 onData:()=>{},
 onReset:()=>{moduleStatusRequest++;}
});
onUnmounted(()=>{moduleStatusRequest++;});

function reset(){
 moduleStatusRequest++;
 zapretRuntime.value=null;domainCatalog.value=null;moduleUpdates.value=[];
 moduleServiceError.value='';moduleUpdateDialog.value=null;moduleActionErrors.value={};
}
watch(userId,reset);
return {moduleProgressDetail,moduleProgress,moduleRows,moduleServiceError,moduleWorking,moduleUpdateDialog,updateFor,moduleStatus,moduleVersionNote,moduleVersionError,moduleActions,checkUpdates,onModuleAction,onModuleRow,installModule,loadModuleStatus,reset};
}
