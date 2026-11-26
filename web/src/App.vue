<script setup>
import {gatewayActions as sharedGatewayActions,routeActions as sharedRouteActions,clientActions as sharedClientActions,connectionGroupActions,moduleArchitectureActions,moduleConfigTypes,architectureCreateActions,architectureToggleActions} from './lib/entity-actions.js';
import {architectureClientId} from './lib/network-architecture.js';
import TorGatewayDialog from './components/TorGatewayDialog.vue';
import GatewayDeployDialog from './components/GatewayDeployDialog.vue';
import {useModuleManagement} from './composables/useModuleManagement.js';
import UsersPage from './pages/UsersPage.vue';
import SystemPage from './pages/SystemPage.vue';
import ModulesPage from './pages/ModulesPage.vue';
import GatewaySubscriptions from './components/GatewaySubscriptions.vue';
import GatewaysPage from './pages/GatewaysPage.vue';
import AppPasswordInput from './components/AppPasswordInput.vue';
import AppTable from './components/AppTable.vue';
import {useDashboardMetrics} from './composables/useDashboardMetrics.js';
import {useConnectionTelemetry} from './composables/useConnectionTelemetry.js';
import {useInlineChanges} from './composables/useInlineChanges.js';
import {useMobileNavigation} from './composables/useMobileNavigation.js';
import AppNavigation from './components/AppNavigation.vue';
import MobileNavigation from './components/MobileNavigation.vue';
import AdGuardSettings from './components/AdGuardSettings.vue';
import { ref, reactive, computed, onMounted, onUnmounted, watch, nextTick } from 'vue';
import {countConnectionRoutes,routeUsesConnection} from './lib/route-usage.js';
import { useBrowserRoutes } from './browser-routes.js';
import AppTabBar from './components/AppTabBar.vue';
import AppTab from './components/AppTab.vue';
import AppInput from './components/AppInput.vue';
import UserMenu from './components/UserMenu.vue';
import AppSelect from './components/AppSelect.vue';
import AppSwitch from './components/AppSwitch.vue';
import BrandLogo from './components/BrandLogo.vue';
import OverviewDashboard from './components/OverviewDashboard.vue';
import {useNetworkArchitecture} from './composables/useNetworkArchitecture.js';
import ResolverTable from './components/ResolverTable.vue';
import ResolverStatus from './components/ResolverStatus.vue';
import ResolverDialog from './components/ResolverDialog.vue';
import BootstrapDialog from './components/BootstrapDialog.vue';
import ExitDialog from './components/ExitDialog.vue';
import GatewayDiagnosticsDialog from './components/GatewayDiagnosticsDialog.vue';
import AppToast from './components/AppToast.vue';
import { notify } from './lib/toasts.js';
import {validUsername,validPassword} from '../../shared/account-validation.js';
import {useFormFeedback} from './composables/useFormFeedback.js';
import AppDataCard from './components/AppDataCard.vue';
import UserDialog from './components/UserDialog.vue';
import PasswordDialog from './components/PasswordDialog.vue';
import AppRowMenu from './components/AppRowMenu.vue';
import ConfirmDialog from './components/ConfirmDialog.vue';
import SystemDialog from './components/SystemDialog.vue';
import ZapretSettings from './components/ZapretSettings.vue';
import AppButton from './components/AppButton.vue';
import AppIcon from './components/AppIcon.vue';
import { createApiClient } from './lib/api.js';
import { isInteractive } from './lib/interactions.js';
import RoutesPage from './pages/RoutesPage.vue';
import ConnectionGroupsPage from './pages/ConnectionGroupsPage.vue';
import ConnectionJournalPage from './pages/ConnectionJournalPage.vue';
import ClientsSection from './pages/ClientsSection.vue';
import IncomingConnectionsPage from './pages/IncomingConnectionsPage.vue';
import NetworkPage from './pages/NetworkPage.vue';
import LogsPage from './pages/LogsPage.vue';
import { usePreferences } from './preferences.js';
const {reportError,validate}=useFormFeedback();

function navigateMobile(value){page.value=value;notice.value='';error.value='';}
const {
  locale,
  theme,
  sidebarCollapsed,
  languageOptions,
  t
} = usePreferences();

const sidebarAnimating=ref(false);
let sidebarMotionTimer;
function toggleSidebar(){
 clearTimeout(sidebarMotionTimer);sidebarAnimating.value=true;sidebarCollapsed.value=!sidebarCollapsed.value;
 sidebarMotionTimer=setTimeout(()=>{sidebarAnimating.value=false;},280);
}
onUnmounted(()=>clearTimeout(sidebarMotionTimer));
const page = ref('Обзор'), status = ref(null), profiles = ref([]), settings = ref(null), error = ref(''), notice = ref(''), busy = ref(false);
const gatewayFilterOpen=ref(false),gatewayFilter=ref({query:'',status:'',type:''});

const tableLoading=ref({profiles:true,groups:true,users:true,modules:true});
const mobileNavigationOpen=useMobileNavigation(page);
const clientSection=ref('Устройства');
const auth = ref(null), users = ref([]), login = ref(''), password = ref(''), userDialog = ref(false);
const subscriptionManager=ref(),subscriptionCount=ref(0);
function subscriptionCountChanged(count){subscriptionCount.value=count;if(!count && connectionSection.value==='Подписки')connectionSection.value='Подключения';}
const connectionSection = ref('Подключения'), connectionGroups = ref([]);
const connectionTelemetry=useConnectionTelemetry((...args)=>api(...args),()=>page.value==='Подключения' && auth.value?.user?.id);
async function loadConnectionGroups(){try{connectionGroups.value=await api('connection-groups');}finally{tableLoading.value.groups=false;}}
async function loadUsers(){try{users.value=await api('users');}finally{tableLoading.value.users=false;}}


const adGuardDialog=ref(false);
const gatewayDeployDialog=ref(false),torGatewayDialog=ref(false);
const exitDialog = ref(false), systemDialog = ref(false);
const diagnosticProfile=ref(null);

const confirmDialog = ref({
  open: false,
  title: '',
  message: '',
  action: null
});

const routeFilter=ref({connection:'',query:''}), routeUsage=ref({groups:[],devices:[]});
async function loadRouteUsage(){routeUsage.value=await api('routes/usage');}
const connectionRouteCount=id=>countConnectionRoutes(routeUsage.value,id,connectionGroups.value);
function showConnectionRoutes(id){routeSection.value=routeUsage.value.groups.some(route=>routeUsesConnection(route,id,connectionGroups.value))?'Домены и IP':routeUsage.value.devices.some(route=>routeUsesConnection(route,id,connectionGroups.value))?'Устройства':'Домены и IP';routeFilter.value={connection:id,query:''};page.value='Маршруты';}
watch(()=>page.value==='Подключения' && !!auth.value?.user,active=>{if(active)run(loadRouteUsage);});
const editingExit = ref(null),mapExitInitialType=ref('');
const mapRoutesPage=ref(),mapClientsPage=ref(),mapGroupsPage=ref(),architectureContext=ref(null),pendingMapUpdate=ref(null);
const zapretDialog = ref(false);
const zapretSettings = ref(null);

const roleNames = {
  admin: 'Администратор',
  operator: 'Оператор',
  viewer: 'Наблюдатель'
};

const can = permission => auth.value?.permissions?.includes(permission);
watch(()=>[auth.value?.user?.role,connectionSection.value],([role,section])=>{if(role && section==='Подписки' && !can('profiles:write'))connectionSection.value='Подключения';});
const {graph:architectureGraph,refresh:refreshArchitecture}=useNetworkArchitecture((...args)=>api(...args),()=>page.value==='Обзор'?auth.value?.user?.id:null);
const {metrics,samples:metricSamples}=useDashboardMetrics((...args)=>api(...args),()=>auth.value?.user?.id);

const pages = ['Обзор', 'Точки доступа', 'Подключения', 'Клиенты', 'Маршруты', 'Журнал', 'Настройки'];
const journalFilter=ref({client:'',query:'',status:'',network:'',route:''});
function showGatewayJournal(profile){journalFilter.value={client:'',query:'',status:'',network:'',route:profile.engine==='direct'?'DIRECT':`p-${profile.id.slice(0,8)}-grp`};page.value='Журнал';}
const clientFilter=ref({query:'',status:'',address:'',accessPoint:''});
function showClientJournal(client){journalFilter.value={client:client.remote?'':client.ip,accessPoint:client.accessPointId || '',accessClient:client.remote?client.id:'',query:'',status:'',network:'',route:''};page.value='Журнал';}
function showAccessJournal(point){journalFilter.value={client:'',accessPoint:point.id,accessClient:'',query:'',status:'',network:'',route:''};page.value='Журнал';}
function showAccessClients(point){clientFilter.value={query:'',status:'online',address:'',accessPoint:point.id};page.value='Клиенты';}
const routeSection = ref('Домены и IP');
const settingsSection = ref('Система');
const settingsSections = computed(() => [
  'Система',
  'Сеть',
  'DNS',
  'Модули и интеграции',
  'Интерфейс',
  'Пользователи',
  ...(can('users:write') ? ['Логи'] : [])
]);

async function loadAuth() {
  auth.value = await api('auth/session');

  if (auth.value.user) {
    if (page.value === 'Настройки' && !settingsSections.value.includes(settingsSection.value))
      settingsSection.value = 'Система';

    await refresh();
  }
}

function signIn() {
  if(busy.value)return;
  if(!validate([
    [validUsername(login.value),"Username: 3–40 Latin letters, digits, or _ . -"],
    [auth.value?.setupRequired?validPassword(password.value):!!password.value,"Password must be 12–256 characters."]
  ]))return;
  run(async () => {
    auth.value = await api(auth.value?.setupRequired ? 'auth/setup' : 'auth/login', {
      method: 'POST',

      body: JSON.stringify({
        username: login.value,
        password: password.value
      })
    });

    password.value = '';
    await loadAuth();
  });
}

function systemAction(action) {
  run(async () => {
    await api('system/action', {
      method: 'POST',

      body: JSON.stringify({
        action
      })
    });

    systemDialog.value = false;

    notify(t(
      action === 'config' ? 'Конфигурация перезагружается.' : action === 'reboot' ? 'Система перезагружается.' : 'Система выключается.'
    ), 'info');
  });
}

function logout() {
  run(async () => {
    await api('auth/logout', {
      method: 'POST',
      body: '{}'
    });

    auth.value = null;
    profiles.value = [];
    users.value = [];
    page.value = 'Обзор';
    await loadAuth();
  });
}

function addUser(payload) {
  run(async () => {
    await api('users', {
      method: 'POST',
      body: JSON.stringify(payload)
    });

    users.value = await api('users');
    userDialog.value = false;
    notice.value = 'Пользователь создан.';
  });
}

function updateUser(user, patch) {
  run(async () => {
    try {
      await api('users/' + user.id, {
        method: 'PUT',
        body: JSON.stringify(patch)
      });

      if (user.id === auth.value.user.id) {
        await loadAuth();
        page.value = 'Обзор';
      } else
        users.value = await api('users');
    } catch (e) {
      if (e.message === "You cannot disable or demote the last administrator.") {
        notify(t(e.message), 'error');
        return;
      }

      throw e;
    }
  });
}

const inlineApplyState=ref(null);
const api = createApiClient({
  translate:t,
  onResponse:data=>{if(data?.apply)inlineApplyState.value=data.apply;},
  getSession: () => auth.value,

  onUnauthorized() {
    auth.value = {
      user: null,
      setupRequired: false
    };

    profiles.value = [];
    users.value = [];
  }
});

useInlineChanges(api,inlineApplyState,()=>auth.value?.user);

async function run(action) {
  busy.value = true;
  error.value = '';
  notice.value = '';

  try {
    await action();
  } catch (e) {
    error.value = e.message;
    reportError(e);
  } finally {
    busy.value = false;
  }
}

async function refresh() {
  await Promise.all([
    (async()=>{try{[status.value,profiles.value,settings.value]=await Promise.all(['status','profiles','settings'].map(p=>api(p)));}finally{tableLoading.value.profiles=false;}})(),
    loadZapret(),loadConnectionGroups(),loadRouteUsage(),loadUsers()
  ]);
}

async function loadZapret() {
  try {
    zapretSettings.value = await api('zapret');
  } catch {}
}

function closeZapret() {
  zapretDialog.value = false;
  loadZapret();
}

const zapretStrategyLabels = {
  '': 'Стандартная',
  md5sum: 'Подмена контрольной суммы',
  autottl: 'Автоподбор TTL',
  ipid: 'Подмена IP ID',
  nfqws2: 'Перехват пакетов, версия 2',
  tpws2: 'Прозрачный прокси, версия 2',
  youtube: 'YouTube (TLS + QUIC)',
  custom: 'Своя стратегия'
};

const zapretStrategyLabel = computed(() => {
  const value = zapretSettings.value?.strategy || '';
  return t(zapretStrategyLabels[value] || value);
});

function exitActions(profile){return sharedGatewayActions(profile,{t,can});}

function askConfirm(title, message, action, confirmLabel='Удалить') {
  confirmDialog.value = {
    open: true,
    title,
    message,
    action,
    confirmLabel
  };
}

function runConfirm() {
  const action = confirmDialog.value.action;

  confirmDialog.value = {
    open: false,
    title: '',
    message: '',
    action: null
  };

  action?.();
}

async function setExitEnabled(profile,enabled){const previous=profile.enabled;profile.enabled=enabled;try{await api('profiles/'+profile.id,{method:'PUT',body:JSON.stringify({enabled})});profiles.value=await api('profiles');}catch(error){profile.enabled=previous;throw error;}}
function toggleExit(profile,enabled){return run(()=>setExitEnabled(profile,enabled));}

function onExitAction(profile, value) {
  if(value==='subscription-refresh'){run(async()=>{await api('gateway-subscriptions/'+profile.subscriptionId+'/refresh',{method:'POST',body:JSON.stringify({profileId:profile.id})});profiles.value=await api('profiles');});return;}
  if(value==='diagnostics'){diagnosticProfile.value=profile;return;}
  if(value==='journal'){showGatewayJournal(profile);return;}
  if(value==='routes'){showConnectionRoutes(profile.id);return;}
  if(value==='edit'){mapExitInitialType.value='';editingExit.value=profile;if(profile.engine==='zapret')zapretDialog.value=true;else if(profile.engine==='tor')torGatewayDialog.value=true;else exitDialog.value=true;return;}
  if (value === 'settings') {
    zapretDialog.value = true;
    return;
  }

  if (value === 'delete')
    askConfirm(t('Удалить точку выхода?'), profile.name, () => remove(profile.id));
}

function onExitRow(profile, event) {
  if (isInteractive(event) || busy.value)
    return;

  const action = exitActions(profile).find(item => item.value === 'edit');

  if (action)
    onExitAction(profile, action.value);
}

const passwordDialog = ref({
  open: false,
  user: null,
  self: false
});

function userActions(user) {
  const actions = [];

  if (can('users:write')) actions.push({
    value: 'toggle',
    label: user.disabled ? t('Включить') : t('Отключить')
  });

  if (can('users:write') || user.id === auth.value?.user?.id) actions.push({
    value: 'password',
    label: t('Сменить пароль')
  });

  return actions;
}

function onUserAction(user, value) {
  if (value === 'toggle') {
    updateUser(user, {
      disabled: !user.disabled
    });

    return;
  }

  if (value === 'password') {
    passwordDialog.value = {
      open: true,
      user,
      self: user.id === auth.value?.user?.id
    };
  }
}

function onUserRow(user, event) {
  if (isInteractive(event))
    return;

  const actions = userActions(user);

  if (actions.length)
    onUserAction(user, actions[0].value);
}

function savePassword(payload) {
  run(async () => {
    const {
      user,
      self
    } = passwordDialog.value;

    if (self) {
      await api('auth/password', {
        method: 'PUT',
        body: JSON.stringify(payload)
      });

      passwordDialog.value.open = false;
      auth.value = await api('auth/session');
      notice.value = 'Пароль изменён. Войдите снова.';
    } else {
      await api('users/' + user.id + '/password', {
        method: 'PUT',

        body: JSON.stringify({
          password: payload.password
        })
      });

      passwordDialog.value.open = false;
      users.value = await api('users');
    }
  });
}

function exitType(profile) {
  if(profile.engine==='lantern')return 'Lantern · TCP';
  if (profile.engine === 'zapret')
    return zapretSettings.value ? zapretStrategyLabel.value : `${profile.protocol.toUpperCase()} · ${t('по умолчанию')}`;

  if (profile.engine === 'direct')
    return t('прямой выход');

  return profile.protocol==='ss'?'Outline/Shadowsocks':profile.protocol.toUpperCase();
}

function addExit(entry) {
  run(async () => {
    await api(editingExit.value ? 'profiles/'+editingExit.value.id : 'profiles/import', {
      method: editingExit.value ? 'PUT' : 'POST',
      body: JSON.stringify(entry)
    });

    profiles.value = await api('profiles');
    exitDialog.value = false;
    notice.value = editingExit.value ? 'Подключение сохранено.' : 'Точка выхода добавлена.';
    editingExit.value=null;
  });
}

function remove(id) {
  run(async () => {
    await api('profiles/' + id, {
      method: 'DELETE'
    });

    profiles.value = await api('profiles');
  });
}

const dns = ref(null), dnsLibrary = ref([]), dnsStatuses = ref({}), dnsChecking = ref(false), bootstrapDialog = ref(false), bootstrapCatalog = ref([]), dnsEngine = ref(null), dnsFilter = ref(null);

const moduleManagement=reactive(useModuleManagement({
 api:(...args)=>api(...args),status,dnsEngine,dnsFilter,tableLoading,can,run,t,
 active:()=>page.value==='Настройки' && settingsSection.value==='Модули и интеграции',
 userId:()=>auth.value?.user?.id
}));

watch(()=>auth.value?.user?.id,()=>{architectureContext.value=null;pendingMapUpdate.value=null;});
async function architectureActions(node){
 const identity=auth.value?.user?.id;
 const done=(kind,entity,actions,extra={})=>{if(identity!==auth.value?.user?.id)return [];architectureContext.value={kind,entity,nodeId:node.id,...extra};return actions;};
 try{
  if(node.kind==='port')return done('network',null,[{value:'configure',label:t('Настроить')}]);
  if(['module','filter'].includes(node.kind)){
   const id=node.id.split(':').at(-1);await moduleManagement.loadModuleStatus();
   const row=moduleManagement.moduleRows.find(row=>row.id===id);if(!row)return [];
   return done('module',row,moduleArchitectureActions(id,{t,can,supported:moduleManagement.updateFor(id)?.supported===true,working:moduleManagement.moduleWorking,installed:node.statusKey!=='architecture.notInstalled'}));
  }
  if(node.kind==='gateway'){
   profiles.value=await api('profiles');const row=profiles.value.find(row=>'gateway:'+row.id===node.id);
   if(row)return done('gateway',row,[...exitActions(row),...architectureToggleActions(row,{t,can,kind:'gateway'})]);
  }
  if(node.kind==='gatewayGroup'){
   await loadConnectionGroups();const row=connectionGroups.value.find(row=>'group:'+row.id===node.id);
   if(row)return done('group',row,connectionGroupActions({t,can}));
  }
  if(node.kind==='rule'){
   const [,collection,...parts]=node.id.split(':');
   if(!['groups','devices'].includes(collection))return done('rules',null,[{value:'routes',label:t('Маршруты')}]);
   const rows=await api('routes'),row=rows[collection]?.find(row=>row.id===parts.join(':'));
   if(row)return done('rule',row,[...sharedRouteActions(row,{t,can}),...architectureToggleActions(row,{t,can,kind:'rule'})],{collection});
  }
  if(node.kind==='device'){
   const data=await api('clients'),row=data.clients?.find(row=>architectureClientId(row)===node.id);
   if(row)return done('client',row,sharedClientActions(row,{t,can}));
  }
  notify(t('architecture.itemUnavailable'),'error');return [];
 }catch(error){if(identity===auth.value?.user?.id)notify(t(error.message),'error');return [];}
}
const mapCreateActions=computed(()=>architectureCreateActions({t,can}));
async function onArchitectureCreate(value){
 if(busy.value||!mapCreateActions.value.some(action=>action.value===value))return;
 if(value==='gateway'){connectionSection.value='Подключения';page.value='Подключения';mapExitInitialType.value='';editingExit.value=null;await nextTick();exitDialog.value=true;}
 else if(value==='group'){connectionSection.value='Группы';page.value='Подключения';await nextTick();mapGroupsPage.value?.createEntity();}
 else if(value==='rule'){routeSection.value='Домены и IP';page.value='Маршруты';await nextTick();mapRoutesPage.value?.createEntity();}
}
function onArchitectureAction({node,value}){return run(async()=>{
 const actions=await architectureActions(node),context=architectureContext.value;
 if(!context || context.nodeId!==node.id || !actions.some(action=>action.value===value&&!action.disabled))return;
 const row=context.entity;
 if(context.kind==='network'){settingsSection.value='Сеть';page.value='Настройки';return;}
 if(context.kind==='module'){
  if(value==='add'){connectionSection.value='Подключения';page.value='Подключения';mapExitInitialType.value=moduleConfigTypes[row.id];editingExit.value=null;await nextTick();exitDialog.value=true;return;}
  settingsSection.value='Модули и интеграции';page.value='Настройки';
  if(value==='update'){
   const before=moduleManagement.updateFor(row.id);
   const pending={id:row.id,previousState:before?.state,previousCheckedAt:before?.checkedAt,armed:false,sawChecking:false};pendingMapUpdate.value=pending;
   const ok=await moduleManagement.checkUpdates(row.id);
   if(pendingMapUpdate.value?.id===row.id){if(ok&&page.value==='Настройки'&&settingsSection.value==='Модули и интеграции')pendingMapUpdate.value.armed=true;else pendingMapUpdate.value=null;}
  }
  return;
 }
 if(context.kind==='gateway'){
  if(['enable','disable'].includes(value)){await setExitEnabled(row,value==='enable');refreshArchitecture();return;}
  if(value==='routes')await loadRouteUsage();
  if(['routes','journal','diagnostics','delete'].includes(value)){onExitAction(row,value);return;}
  connectionSection.value='Подключения';page.value='Подключения';await nextTick();onExitAction(row,value);return;
 }
 if(context.kind==='group'){
  if(value==='routes'){await loadRouteUsage();showConnectionRoutes(row.id);return;}
  connectionSection.value='Группы';page.value='Подключения';await nextTick();return mapGroupsPage.value?.performEntityAction(row.id,value);
 }
 if(context.kind==='rules'){routeSection.value='Домены и IP';routeFilter.value={connection:'',query:''};page.value='Маршруты';return;}
 if(context.kind==='rule'){
  if(['enable','disable'].includes(value)){await api('routes/'+context.collection+'/'+row.id+'/enabled',{method:'PUT',body:JSON.stringify({enabled:value==='enable'})});refreshArchitecture();return;}
  routeSection.value=context.collection==='groups'?'Домены и IP':'Устройства';routeFilter.value={connection:'',query:''};page.value='Маршруты';await nextTick();
  return mapRoutesPage.value?.performEntityAction(context.collection,row.id,value);
 }
 if(context.kind==='client'){
  if(value==='journal'){showClientJournal(row);return;}
  clientFilter.value={query:'',status:'',address:'',accessPoint:''};page.value='Клиенты';await nextTick();return mapClientsPage.value?.performEntityAction(node.id,value);
 }
});}
watch([page,settingsSection,()=>auth.value?.user?.id],()=>{if(page.value!=='Настройки' || settingsSection.value!=='Модули и интеграции' || !auth.value?.user)pendingMapUpdate.value=null;});
watch(()=>{
 const pending=pendingMapUpdate.value,update=pending&&moduleManagement.updateFor(pending.id);
 return [pending?.id,pending?.armed,update?.state,update?.checkedAt];
},([id,armed,state,checkedAt])=>{
 const pending=pendingMapUpdate.value;if(!pending||pending.id!==id)return;
 if(state==='checking')pending.sawChecking=true;
 if(!armed||!['available','current','error'].includes(state))return;
 if(state!=='error'&&!pending.sawChecking&&state===pending.previousState&&checkedAt===pending.previousCheckedAt)return;
 const row=moduleManagement.moduleRows.find(row=>row.id===id);pendingMapUpdate.value=null;
 if(state==='available'&&moduleManagement.updateFor(id)?.supported&&can('users:write')&&row)moduleManagement.onModuleAction(row,'update');
 if(state==='current')notify(t('architecture.moduleCurrent'),'success');
});

const displayName = profile => profile.builtin ? t(profile.name) : profile.name;

const resolverDialog = ref({
  open: false,
  list: 'nameservers',
  title: ''
});

const resolverDialogTitles = {
  nameservers: 'Добавить резолвер',
  fallback: 'Добавить резервный резолвер',
  proxyServerNameservers: 'Добавить резолвер адресов прокси'
};

const dnsRouteOptions = computed(() => profiles.value.filter(profile => ['zapret','socks5'].includes(profile.engine)).map(profile => ({value:`p-${profile.id.slice(0,8)}-grp`,label:displayName(profile)})));


const engineTitles = {
  warning: 'mihomo работает, но DNS-резолверы не отвечают',
  stopped: 'mihomo остановлен',
  error: "Failed to apply settings",
  unavailable: 'Движок mihomo не установлен'
};

const engineHints = {
  stopped: 'Настройки сохранены, но движок не запущен. Нажмите «Применить снова».',
  error: "Check the configuration and try again.",
  unavailable: 'Установите mihomo или проверьте путь к бинарнику.'
};

const engineDisplayState = computed(() => {
  const engine = dnsEngine.value;

  if (!engine)
    return null;

  if (engine.state === 'running')
    return engine.error ? 'warning' : null;

  if (engine.state === 'unavailable')
    return null;

  return engine.state;
});

const engineTitle = computed(() => t(engineTitles[engineDisplayState.value] || 'Состояние mihomo неизвестно'));
const engineHint = computed(() => dnsEngine.value?.error || t(engineHints[engineDisplayState.value] || ''));

const filterDisplayState = computed(() => {
  const filter = dnsFilter.value;

  if (!filter)
    return null;

  if (filter.state === 'running')
    return filter.filtering ? null : 'warning';

  return filter.state === 'error' ? 'error' : null;
});

const bannerState = computed(() => engineDisplayState.value || filterDisplayState.value);
const bannerTitle = computed(() => engineDisplayState.value ? engineTitle.value : t('AdGuard не работает'));

const bannerHint = computed(
  () => engineDisplayState.value ? engineHint.value : (dnsFilter.value?.error || t('Фильтрация не подтверждена.'))
);

async function loadDns() {
  const data = await api('dns');
  dns.value = data.settings;
  dnsLibrary.value = data.resolvers;
  dnsEngine.value = data.engine;
  dnsFilter.value = data.filter;
  bootstrapCatalog.value = data.bootstrap || [];
  await checkDns(false);
}

async function checkDns(refresh = false) {
  dnsChecking.value = true;

  try {
    const data = await api('dns/status' + (refresh ? '?refresh=1' : ''));
    dnsStatuses.value = data.statuses || {};
  } catch (e) {
    reportError(e);
  } finally {
    dnsChecking.value = false;
  }
}

function saveDns() {
  run(async () => {
    try {
      const data = await api('dns', {
        method: 'PUT',
        body: JSON.stringify(dns.value)
      });

      dns.value = data.settings;
      dnsEngine.value = data.engine;
      dnsFilter.value = data.filter;
      notice.value = data.engine?.state === 'running' ? '' : 'Настройки сохранены. Движок mihomo не установлен.';
      await checkDns(true);
    } catch (failure) {
      if (failure.data?.engine)
        dnsEngine.value = failure.data.engine;

      if (failure.data?.filter)
        dnsFilter.value = failure.data.filter;

      throw failure;
    }
  });
}

function applyDns() {
  run(async () => {
    try {
      const data = await api('dns/apply', {
        method: 'POST',
        body: '{}'
      });

      dnsEngine.value = data.engine;
      dnsFilter.value = data.filter;
      notice.value = data.engine?.state === 'running' ? '' : 'Настройки сохранены. Движок mihomo не установлен.';
    } catch (failure) {
      if (failure.data?.engine)
        dnsEngine.value = failure.data.engine;

      if (failure.data?.filter)
        dnsFilter.value = failure.data.filter;

      throw failure;
    }
  });
}

function addDnsEntry(list, item) {
  if (!dns.value)
    return;

  const url = typeof item === 'string' ? item.trim() : item?.url;
  const via = typeof item === 'object' && item?.via ? item.via : '';

  if (!url)
    return;

  if (dns.value[list].some(entry => entry.url === url)) {
    reportError('This resolver is already in the list.');
    return;
  }

  error.value = '';

  dns.value[list].push({
    url,
    via
  });
}

function removeDnsEntry(list, index) {
  if (!dns.value)
    return;

  dns.value[list].splice(index, 1);
}

function askRemoveDnsEntry(list, index) {
  const entry = dns.value?.[list]?.[index];

  if (!entry)
    return;

  askConfirm(t('Удалить резолвер?'), entry.url, () => removeDnsEntry(list, index));
}

function addBootstrapIp(ip) {
  if (!dns.value || !ip)
    return;

  if (dns.value.defaultNameservers.includes(ip))
    return;

  dns.value.defaultNameservers.push(ip);
}

function removeBootstrap(index) {
  dns.value.defaultNameservers.splice(index, 1);
}

function askRemoveBootstrap(index) {
  const ip = dns.value?.defaultNameservers?.[index];

  if (!ip)
    return;

  askConfirm(t('Удалить bootstrap-резолвер?'), ip, () => removeBootstrap(index));
}

function setDnsVia(list, payload) {
  const entry = dns.value?.[list]?.[payload.index];

  if (!entry)
    return;

  entry.via = payload.via;
}

function openResolverDialog(list) {
  resolverDialog.value = {
    open: true,
    list,
    title: t(resolverDialogTitles[list] || 'Добавить резолвер')
  };
}

function closeResolverDialog() {
  resolverDialog.value = {
    ...resolverDialog.value,
    open: false
  };
}

function dialogAdd(entry) {
  addDnsEntry(resolverDialog.value.list, entry);
  closeResolverDialog();
}

watch(
  () => page.value === 'Настройки' && settingsSection.value === 'DNS' && !!auth.value?.user,
  active => {
    if (active)
      run(loadDns);
  }
);

let engineTimer;

async function loadEngine() {
  if(page.value==='Настройки' && settingsSection.value==='Модули и интеграции') moduleManagement.loadModuleStatus();
  try {
    const data = await api('dns/engine');
    dnsEngine.value = data.engine;
    dnsFilter.value = data.filter;
  } catch {}
}

watch(() => auth.value?.user?.id || null, id => {
  clearInterval(engineTimer);

  if (id) {
    loadEngine();
    engineTimer = setInterval(loadEngine, 15000);
  } else {
    tableLoading.value={profiles:true,groups:true,users:true,modules:true};
    dnsEngine.value = null;
    dnsFilter.value = null;
    moduleManagement.reset();
  }
}, {
  immediate: true
});

onUnmounted(() => clearInterval(engineTimer));
useBrowserRoutes(page, routeSection, settingsSection, connectionSection,routeFilter,clientSection,journalFilter,clientFilter);

watch([page, settingsSection, () => auth.value?.user], () => {
  if (auth.value?.user && page.value === 'Настройки' && !settingsSections.value.includes(settingsSection.value))
    settingsSection.value = 'Система';
});

onMounted(() => run(loadAuth));
</script>
<template>
  <div v-if="!auth" class="session-loading" data-testid="session-loading" :aria-busy="busy">
    <template v-if="error">

      <AppButton :disabled="busy" variant="secondary" @click="run(loadAuth)">{{t('Повторить')}}</AppButton>
    </template>
    <p v-else role="status">{{t('Загрузка службы…')}}</p>
  </div>
  <div v-else-if="!auth.user" class="auth-shell">
    <section class="panel auth-panel" aria-label="FreedomGate">
      <div class="brand auth-brand">
        <BrandLogo />
        <span class="brand-wordmark">FreedomGate</span>
      </div>
      <div v-if="auth.setupRequired" class="auth-intro"><h1>{{t('Первый запуск')}}</h1><p class="muted">{{t('Создайте первого администратора. Он сможет добавлять пользователей и назначать роли.')}}</p></div>
      <div v-if="notice" role="status" class="alert">{{t(notice)}}</div>
      <form v-if="auth" class="auth-form form-section" :aria-label="auth.setupRequired?t('Создать администратора'):t('Войти')" novalidate @submit.prevent="signIn">
        <label>
          {{t("Логин")}}
          <AppInput v-model="login" autocomplete="username" required minlength="3" maxlength="40" pattern="[a-zA-Z0-9_.-]+" />
        </label>
        <label>
          {{t("Пароль")}}
          <AppPasswordInput v-model="password" :autocomplete="auth.setupRequired?'new-password':'current-password'" required :minlength="auth.setupRequired?12:1" maxlength="256" />
        </label>
        <small v-if="auth.setupRequired" class="muted">{{t("От 12 до 256 символов. Пароля по умолчанию нет.")}}</small>
        <div class="preferences auth-preferences" role="group" :aria-label="t('Язык и тема')">
          <label>
            <span>{{t('Язык')}}</span>
            <AppSelect v-model="locale" data-testid="language" :label="t('Язык')" :options="languageOptions" />
          </label>
          <label>
            <span>{{t('Тема')}}</span>
            <AppSelect v-model="theme" data-testid="theme" :label="t('Тема')" :options="[{value:'dark',label:t('Тёмная')},{value:'light',label:t('Светлая')}]" />
          </label>
        </div>
        <AppButton :disabled="busy" type="submit">{{auth.setupRequired?t('Создать администратора'):t('Войти')}}</AppButton>
      </form>
      <p v-else class="muted">{{t("Загрузка службы…")}}</p>
    </section>
  </div>
  <div v-else class="shell" :class="{'sidebar-collapsed':sidebarCollapsed,'sidebar-animating':sidebarAnimating}">
    <div v-if="bannerState" class="engine-banner" :class="'is-'+bannerState" role="alert">
      <AppIcon name="warning" />
      <div class="engine-banner-text">
        <strong>{{bannerTitle}}</strong>
        <small v-if="bannerHint">{{bannerHint}}</small>
      </div>
      <AppButton v-if="can('settings:write') && (bannerState==='error' || bannerState==='stopped')" size="s" variant="secondary" :disabled="busy" @click="applyDns">{{t("Применить снова")}}</AppButton>
    </div>
    <aside>
      <a class="brand" href="/overview" aria-label="FreedomGate" @click.prevent="page='Обзор'">
        <BrandLogo />
        <span class="brand-wordmark">
          FreedomGate
        </span>
      </a>
      <AppButton variant="outline" size="s" icon-only class="sidebar-toggle" type="button" data-testid="sidebar-toggle" :aria-label="t(sidebarCollapsed?'Развернуть меню':'Свернуть меню')" :title="t(sidebarCollapsed?'Развернуть меню':'Свернуть меню')" :aria-expanded="!sidebarCollapsed" @click="toggleSidebar">
        <AppIcon :name="sidebarCollapsed?'expand':'collapse'" />
      </AppButton>
      <AppNavigation :pages="pages" v-model="page" @update:model-value="notice='';error=''" />
      <div class="aside-bottom">
        <UserMenu :user="auth.user" :role-label="t(roleNames[auth.user.role])" :disabled="busy" :can-system="can('settings:write')" @logout="logout" @system="systemDialog=true" />
      </div>
    </aside>
    <header class="mobile-topbar">
      <AppButton variant="blanc" icon-only data-testid="mobile-navigation-toggle" :aria-label="t('Открыть меню')" :aria-expanded="mobileNavigationOpen" @click="mobileNavigationOpen=true"><AppIcon name="menu" /></AppButton>
      <a class="mobile-brand" href="/overview" aria-label="FreedomGate" @click.prevent="page='Обзор'"><BrandLogo /><span>FreedomGate</span></a>
      <UserMenu compact :user="auth.user" :role-label="t(roleNames[auth.user.role])" :disabled="busy" :can-system="can('settings:write')" @logout="logout" @system="systemDialog=true" />
    </header>
    <MobileNavigation :open="mobileNavigationOpen" :pages="pages" :page="page" :user="auth.user" :role-label="t(roleNames[auth.user.role])" :can-system="can('settings:write')" :disabled="busy" @close="mobileNavigationOpen=false" @navigate="navigateMobile" @logout="logout" @system="systemDialog=true" />
    <main>
      <header>
        <div>
          <h1>{{t(page)}}</h1>
        </div>
      </header>
      <div v-if="notice" role="status" class="alert">{{t(notice)}}</div>
      <AppTabBar v-if="page==='Настройки'" id="settings-tabs" class="settings-tabs" v-model="settingsSection" :label="t('Разделы настроек')" @update:model-value="notice='';error=''">
        <AppTab v-for="section in settingsSections" :key="section" :value="section" controls="settings-content">{{t(section)}}</AppTab>
      </AppTabBar>
      <OverviewDashboard v-if="page==='Обзор'" :metrics="metrics" :samples="metricSamples" :architecture-graph="architectureGraph" :create-actions="mapCreateActions" @create="onArchitectureCreate" :node-actions="architectureActions" :actions-busy="busy" @node-action="onArchitectureAction" />
      <template v-if="page==='Подключения'">
        <AppTabBar id="connection-tabs" class="settings-tabs" v-model="connectionSection" :label="t('Подключения')">
          <AppTab value="Подключения">{{t('Подключения')}}</AppTab><AppTab v-if="subscriptionCount>0 && can('profiles:write')" value="Подписки">{{t('Подписки')}}</AppTab><AppTab value="Группы">{{t('Группы')}}</AppTab>
        </AppTabBar>
        <ConnectionGroupsPage ref="mapGroupsPage" :loading="tableLoading.groups" v-if="connectionSection==='Группы'" :groups="connectionGroups" :profiles="profiles" :telemetry="connectionTelemetry" :api="api" :run="run" :can="can" :ask-confirm="askConfirm" :busy="busy" :route-count="connectionRouteCount" @routes="showConnectionRoutes" @changed="loadConnectionGroups" />
        <GatewaysPage v-else-if="connectionSection==='Подключения'" @subscription="subscriptionManager.add()" :api="api" @changed="async()=>{profiles=await api('profiles')}" v-model:filter="gatewayFilter" v-model:filter-open="gatewayFilterOpen" :profiles="profiles" :loading="tableLoading.profiles" :busy="busy" :can="can" :telemetry="connectionTelemetry" :route-count="connectionRouteCount" :actions="exitActions" :display-name="displayName" :exit-type="exitType" @add="mapExitInitialType='';editingExit=null;exitDialog=true" @deploy="gatewayDeployDialog=true" @row="onExitRow" @toggle="toggleExit" @action="onExitAction" />
        <GatewaySubscriptions v-if="can('profiles:write')" ref="subscriptionManager" :api="api" :revision="profiles" :active="connectionSection==='Подписки'" @count="subscriptionCountChanged" @created="connectionSection='Подписки'" @changed="async()=>{profiles=await api('profiles')}" />
        <TorGatewayDialog :open="torGatewayDialog" :profile="editingExit" :api="api" @close="torGatewayDialog=false" @saved="async()=>{profiles=await api('profiles')}" />
        <GatewayDeployDialog :open="gatewayDeployDialog" :api="api" @close="gatewayDeployDialog=false" @created="async()=>{profiles=await api('profiles')}" />
        <ExitDialog :initial-type="mapExitInitialType" :profiles="profiles" :load-config="id=>api('profiles/'+id+'/config')" :open="exitDialog" :profile="editingExit" :disabled="busy" @close="exitDialog=false" @add="addExit" />
        <ZapretSettings :open="zapretDialog" :profile="editingExit" @saved="profiles=$event" :disabled="busy" :csrf="auth?.csrf" @close="closeZapret" />
      </template>
      <NetworkPage v-if="page==='Настройки' && settingsSection==='Сеть'" :api="api" :run="run" :can="can" :busy="busy" @notice="notice=$event" />
      <ConnectionJournalPage v-if="page==='Журнал'" v-model="journalFilter" :api="api" :can="can" :ask-confirm="askConfirm" />
      <ClientsSection ref="mapClientsPage" v-model="clientFilter" @journal="showClientJournal" v-if="page==='Клиенты'" :api="api" :run="run" :can="can" :busy="busy" />
      <IncomingConnectionsPage @journal="showAccessJournal" @clients="showAccessClients" v-if="page==='Точки доступа'" :api="api" :can="can" :ask-confirm="askConfirm" />
      <RoutesPage ref="mapRoutesPage" @dns-settings="page='Настройки';settingsSection='DNS';adGuardDialog=true" v-if="page==='Маршруты'" v-model="routeSection" v-model:filter="routeFilter" :api="api" :run="run" :can="can" :ask-confirm="askConfirm" :profiles="profiles" :connection-groups="connectionGroups" :zapret-strategy="zapretSettings?.strategy" :busy="busy" @notice="notice=$event" />
      <div v-if="page==='Настройки' && settingsSection!=='Сеть'" id="settings-content" role="tabpanel" :aria-labelledby="'settings-tabs-tab-'+encodeURIComponent(settingsSection)">
        <template v-if="page==='Настройки' && settingsSection==='DNS'">
          <div v-if="!dns" class="card-stack">
            <AppDataCard v-for="title in ['Пул резолверов','Резервные резолверы','Bootstrap-резолверы','Резолверы адресов прокси']" :key="title" :title="t(title)"><div v-if="title==='Bootstrap-резолверы'" class="table-wrap"><AppTable loading class="data-table"><thead><tr><th>{{t('Адрес')}}</th><th>{{t('Статус')}}</th><th class="actions-col"></th></tr></thead><tbody /></AppTable></div><ResolverTable v-else loading :label="t(title)" /></AppDataCard>
          </div>
          <template v-else>
            <div class="card-stack">

              <AppDataCard :title="t('Пул резолверов')" :count="dns.nameservers.length">
                <template #actions>
                  <AppButton v-if="can('settings:write')" variant="secondary" size="m" icon-only data-testid="add-resolver" :aria-label="t('Добавить резолвер')" :title="t('Добавить резолвер')" :disabled="busy" @click="openResolverDialog('nameservers')">
                    <AppIcon name="plus" />
                  </AppButton>
                  <AppButton variant="secondary" :disabled="busy || dnsChecking" @click="checkDns(true)">{{dnsChecking?t('Проверка…'):t('Проверить доступность')}}</AppButton>
                </template>
                <ResolverTable :routes="dnsRouteOptions" data-testid="resolver-pool" :entries="dns.nameservers" :statuses="dnsStatuses" :resolvers="dnsLibrary" :disabled="!can('settings:write')" :label="t('Пул резолверов')" @remove="askRemoveDnsEntry('nameservers',$event)" @via="setDnsVia('nameservers',$event)" />
              </AppDataCard>
              <AppDataCard :title="t('Резервные резолверы')" :count="dns.fallback.length">
                <template #actions>
                  <AppButton v-if="can('settings:write')" variant="secondary" size="m" icon-only :aria-label="t('Добавить резервный резолвер')" :title="t('Добавить резервный резолвер')" :disabled="busy" @click="openResolverDialog('fallback')">
                    <AppIcon name="plus" />
                  </AppButton>
                </template>
                <template #filters>
                  <div class="dns-switches">
                    <AppSwitch :model-value="dns.fallbackGeoip" :label="t('Гео-фильтр резервных')" :disabled="!can('settings:write')" @update:model-value="dns.fallbackGeoip=$event" />
                    <label v-if="dns.fallbackGeoip" class="dns-inline">
                      {{t("Код страны")}}
                      <AppInput :model-value="dns.fallbackGeoipCode" maxlength="2" @update:model-value="dns.fallbackGeoipCode=$event" />
                    </label>
                  </div>
                </template>
                <ResolverTable :routes="dnsRouteOptions" data-testid="resolver-fallback" :entries="dns.fallback" :statuses="dnsStatuses" :resolvers="dnsLibrary" :disabled="!can('settings:write')" :label="t('Резервные резолверы')" @remove="askRemoveDnsEntry('fallback',$event)" @via="setDnsVia('fallback',$event)" />
              </AppDataCard>
              <AppDataCard :title="t('Bootstrap-резолверы')" :count="dns.defaultNameservers.length">
                <template #actions>
                  <AppButton v-if="can('settings:write')" variant="secondary" size="m" icon-only :aria-label="t('Добавить bootstrap-резолвер')" :title="t('Добавить bootstrap-резолвер')" :disabled="busy" @click="bootstrapDialog=true">
                    <AppIcon name="plus" />
                  </AppButton>
                </template>
                <div class="table-wrap">
                  <AppTable class="data-table" data-testid="resolver-bootstrap" :aria-label="t('Bootstrap-резолверы')">
                    <thead>
                      <tr>
                        <th>{{t("Адрес")}}</th>
                        <th>{{t("Статус")}}</th>
                        <th class="actions-col" :aria-label="t('Действия')"></th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr v-for="(ip,index) in dns.defaultNameservers" :key="ip">
                        <td>
                          <code>{{ip}}</code>
                        </td>
                        <td>
                          <ResolverStatus :status="dnsStatuses[ip]" />
                        </td>
                        <td class="actions-cell">
                          <AppRowMenu :actions="[{value:'remove',label:t('Удалить'),danger:true}]" :label="t('Действия')" :disabled="busy || !can('settings:write')" @select="askRemoveBootstrap(index)" />
                        </td>
                      </tr>
                      <tr v-if="!dns.defaultNameservers.length">
                        <td colspan="3" class="table-empty">{{t("Пока нет резолверов")}}</td>
                      </tr>
                    </tbody>
                  </AppTable>
                </div>
              </AppDataCard>
              <AppDataCard :title="t('Резолверы адресов прокси')" :count="dns.proxyServerNameservers.length">
                <template #actions>
                  <AppButton v-if="can('settings:write')" variant="secondary" size="m" icon-only :aria-label="t('Добавить резолвер адресов прокси')" :title="t('Добавить резолвер адресов прокси')" :disabled="busy" @click="openResolverDialog('proxyServerNameservers')">
                    <AppIcon name="plus" />
                  </AppButton>
                </template>
                <ResolverTable :routes="dnsRouteOptions" data-testid="resolver-proxy" :entries="dns.proxyServerNameservers" :statuses="dnsStatuses" :resolvers="dnsLibrary" :disabled="!can('settings:write')" :label="t('Резолверы адресов прокси')" @remove="askRemoveDnsEntry('proxyServerNameservers',$event)" @via="setDnsVia('proxyServerNameservers',$event)" />
              </AppDataCard>
              <section class="panel">
                <h3>{{t("Параметры mihomo")}}</h3>
                <div class="dns-options">
                  <label>
                    {{t("Режим")}}
                    <AppSelect :model-value="dns.enhancedMode" :label="t('Режим DNS')" :options="[{value:'redir-host',label:'redir-host'},{value:'fake-ip',label:'fake-ip'}]" :disabled="!can('settings:write')" @update:model-value="dns.enhancedMode=$event" />
                  </label>
                  <label v-if="dns.enhancedMode==='fake-ip'">
                    {{t("Диапазон fake-ip")}}
                    <AppInput :model-value="dns.fakeIpRange" @update:model-value="dns.fakeIpRange=$event" />
                  </label>
                  <label>
                    {{t("Кэш")}}
                    <AppSelect :model-value="dns.cacheAlgorithm" :label="t('Кэш')" :options="[{value:'lru',label:'LRU'},{value:'arc',label:'ARC'}]" :disabled="!can('settings:write')" @update:model-value="dns.cacheAlgorithm=$event" />
                  </label>
                </div>
                <div class="dns-switches">
                  <AppSwitch :model-value="dns.ipv6" :label="t('IPv6')" :disabled="!can('settings:write')" @update:model-value="dns.ipv6=$event" />
                  <AppSwitch :model-value="dns.preferH3" :label="t('Предпочитать HTTP/3')" :disabled="!can('settings:write')" @update:model-value="dns.preferH3=$event" />
                  <AppSwitch :model-value="dns.respectRules" :label="t('DNS подчиняется правилам')" :disabled="!can('settings:write')" @update:model-value="dns.respectRules=$event" />
                  <AppSwitch :model-value="dns.useHosts" :label="t('Использовать hosts')" :disabled="!can('settings:write')" @update:model-value="dns.useHosts=$event" />
                </div>
                <div v-if="dns.respectRules && !dns.proxyServerNameservers.length" class="alert">{{t("Для respect-rules нужен резолвер адресов прокси, иначе получится замкнутый круг.")}}</div>
                <div class="dns-actions">
                  <AppButton data-testid="save-dns" :disabled="busy || !can('settings:write')" @click="saveDns">{{t("Сохранить и применить")}}</AppButton>
                  <AppButton v-if="can('settings:write') && (dnsEngine?.state==='error' || dnsEngine?.state==='stopped')" variant="secondary" :disabled="busy" @click="applyDns">{{t("Применить снова")}}</AppButton>
                </div>
              </section>
              <AppDataCard title="AdGuard Home">
                <div class="table-wrap"><AppTable class="data-table"><thead><tr><th>{{t('Модуль')}}</th><th>{{t('Статус')}}</th><th class="actions-col"></th></tr></thead><tbody><tr @click="!isInteractive($event) && (adGuardDialog=true)"><td><strong>AdGuard Home</strong></td><td>{{t(dnsFilter?.state==='running'?'Работает':'Недоступен')}}</td><td class="actions-cell"><AppRowMenu :actions="[{value:'settings',label:t('Настройки')}]" :label="t('Действия')" @select="adGuardDialog=true" /></td></tr></tbody></AppTable></div>
              </AppDataCard>
            </div>
          </template>
          <AdGuardSettings :open="adGuardDialog" :api="api" :readonly="!can('settings:write')" @close="adGuardDialog=false" />
          <BootstrapDialog :open="bootstrapDialog" :catalog="bootstrapCatalog" :existing="dns?dns.defaultNameservers:[]" :disabled="busy" @close="bootstrapDialog=false" @add="addBootstrapIp" />
          <ResolverDialog :open="resolverDialog.open" :title="resolverDialog.title" :resolvers="dnsLibrary" :existing="(dns?.[resolverDialog.list] || []).map(entry=>entry.url)" :disabled="busy" @close="closeResolverDialog" @add="dialogAdd" />
        </template>
        <SystemPage v-if="settingsSection==='Система'" :api="api" :can="can" />
        <ModulesPage v-if="page==='Настройки' && settingsSection==='Модули и интеграции'" :management="moduleManagement" :busy="busy" :loading="tableLoading.modules" :can="can" />
        <template v-if="page==='Настройки' && settingsSection==='Интерфейс'">
          <section class="panel">
            <h3>{{t("Интерфейс")}}</h3>
            <div class="form-section" data-testid="interface-preferences">
              <label>{{t('Язык')}}<AppSelect v-model="locale" data-testid="interface-language" :label="t('Язык')" :options="languageOptions" /></label>
              <label>{{t('Тема')}}<AppSelect v-model="theme" data-testid="interface-theme" :label="t('Тема')" :options="[{value:'dark',label:t('Тёмная')},{value:'light',label:t('Светлая')}]" /></label>
            </div>
          </section>
        </template>
        <template v-if="page==='Настройки' && settingsSection==='Пользователи'">
          <UsersPage :users="users" :current-user="auth.user" :role-names="roleNames" :actions="userActions" :can="can" :loading="tableLoading.users" :busy="busy" @add="userDialog=true" @row="onUserRow" @action="onUserAction" @update-role="(user,role)=>updateUser(user,{role})" />
          <UserDialog :open="userDialog" :disabled="busy" @close="userDialog=false" @add="addUser" />
          <PasswordDialog :open="passwordDialog.open" :disabled="busy" :user="passwordDialog.user" :self="passwordDialog.self" @close="passwordDialog.open=false" @save="savePassword" />
        </template>
        <LogsPage v-if="page==='Настройки' && settingsSection==='Логи' && can('users:write')" :api="api" />
      </div>
    </main>
  </div>
  <AppToast />
  <ConfirmDialog :open="confirmDialog.open" :title="confirmDialog.title" :message="confirmDialog.message" :confirm-label="confirmDialog.confirmLabel" :disabled="busy" @confirm="runConfirm" @close="confirmDialog.open=false" />
  <SystemDialog :open="systemDialog" :disabled="busy" @close="systemDialog=false" @action="systemAction" />
  <GatewayDiagnosticsDialog :open="!!diagnosticProfile" :profile="diagnosticProfile" :profiles="profiles" :api="api" @close="diagnosticProfile=null" />
</template>

<style scoped>
.session-loading{min-height:100dvh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:var(--space-4);padding:var(--space-6);color:var(--color-text-secondary);font-size:var(--font-size-body)}
.session-loading p{margin:0}
</style>
