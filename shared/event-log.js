// Only these static action templates may enter the audit log. Never log bodies,
// query strings, arbitrary paths, profile links or exported client credentials.
export const eventLabels = {
  'POST /api/telegram/chats':'Detecting Telegram chats',
  'PUT /api/telegram':'Saving Telegram settings',
  'POST /api/telegram/test':'Sending a Telegram test notification',
  'POST /api/configuration/backups':'Creating a configuration backup',
  'SYSTEM telegram-delivered':'Telegram notification delivered',
  'SYSTEM telegram-delivery-failed':'Telegram notification delivery failed',
  'SYSTEM gateway-http-failed':'Узел HTTP-проверки шлюза недоступен',
  'SYSTEM gateway-http-restored':'Доступ к узлу HTTP-проверки шлюза восстановлен',
  'SYSTEM restore-failed':'Не удалось восстановить работу службы',
  'SYSTEM wifi-connected':'Устройство подключилось к Wi-Fi',
  'SYSTEM dhcp-failed':'Ошибка службы DHCP',
  'SYSTEM dhcp-started':'Служба DHCP запущена',
  'SYSTEM wifi-disconnected':'Устройство отключилось от Wi-Fi',
  'SYSTEM wifi-failed':'Сбой точки доступа Wi-Fi',
  'SYSTEM wifi-started':'Точка доступа Wi-Fi запущена',
  'SYSTEM dhcp-stopped':'Служба DHCP остановлена',
  'SYSTEM hardware-failed':'Ошибка оборудования или нехватка памяти',
  'SYSTEM service-failed':'Аварийное завершение службы FreedomGate',
  'SYSTEM network-failed':'Не удалось применить сетевую конфигурацию',
  'SYSTEM journal-unavailable':'Системный журнал недоступен', 
  'POST /api/auth/setup':'Создание администратора',
  'POST /api/auth/login':'Вход в админку',
  'POST /api/auth/logout':'Выход из админки',
  'PUT /api/auth/password':'Смена своего пароля',
  'POST /api/users':'Создание пользователя',
  'PUT /api/users/:id':'Изменение пользователя',
  'PUT /api/users/:id/password':'Смена пароля пользователя',
  'POST /api/profiles':'Создание шлюза',
  'POST /api/profiles/import':'Импорт шлюза',
  'PUT /api/profiles/:id':'Изменение шлюза',
  'DELETE /api/profiles/:id':'Удаление шлюза',
  'POST /api/connection-groups':'Создание группы шлюзов',
  'PUT /api/connection-groups/:id':'Изменение группы шлюзов',
  'DELETE /api/connection-groups/:id':'Удаление группы шлюзов',
  'POST /api/routes/groups':'Создание правила для доменов и IP',
  'PUT /api/routes/groups/:id':'Изменение правила для доменов и IP',
  'DELETE /api/routes/groups/:id':'Удаление правила для доменов и IP',
  'POST /api/routes/groups/:id/move':'Изменение порядка правил',
  'POST /api/routes/devices':'Создание правила устройства',
  'PUT /api/routes/devices/:id':'Изменение правила устройства',
  'DELETE /api/routes/devices/:id':'Удаление правила устройства',
  'POST /api/routes/locals':'Создание локального маршрута',
  'PUT /api/routes/locals/:id':'Изменение локального маршрута',
  'DELETE /api/routes/locals/:id':'Удаление локального маршрута',
  'POST /api/clients/static':'Закрепление IP-адреса устройства',
  'DELETE /api/clients/static/:id':'Удаление закреплённого IP-адреса',
  'PUT /api/settings':'Сохранение настроек службы',
  'PUT /api/dns':'Сохранение настроек DNS',
  'POST /api/dns/apply':'Применение настроек DNS',
  'POST /api/network/plan':'Проверка сетевой конфигурации',
  'PUT /api/network':'Сохранение сетевой конфигурации',
  'POST /api/network/apply':'Сохранение и применение сети',
  'POST /api/network/stop':'Остановка клиентской сети',
  'PUT /api/zapret':'Сохранение настроек zapret',
  'POST /api/zapret/autotune':'Подбор стратегии zapret',
  'POST /api/domain-lists/update':'Обновление пресетов доменов',
  'POST /api/modules':'Обновление модулей',
  'POST /api/system/action':'Системное действие',
  'POST /api/system/action:config':'Перезагрузка конфигурации',
  'POST /api/system/action:reboot':'Перезагрузка устройства',
  'POST /api/system/action:poweroff':'Выключение устройства',
  'POST /api/gateway-deployments':'Deploying a VPN server',
  'POST /api/gateway-deployments/inspect':'Checking the VPS SSH host key',
  'POST /api/gateway-deployments/:id/retry':'Retrying a VPN deployment',
  'POST /api/access-points':'Создание точки доступа',
  'POST /api/access-points/inspect':'Проверка SSH-доступа к VPS',
  'POST /api/access-points/:id/install':'Установка точки доступа на VPS',
  'PUT /api/access-points/:id':'Изменение точки доступа',
  'PUT /api/access-points/:id/credentials':'Изменение SSH-доступа к VPS',
  'DELETE /api/access-points/:id':'Удаление точки доступа',
  'POST /api/access-points/:id/clients':'Создание VPN-клиента',
  'PUT /api/access-points/:id/clients/:id':'Изменение VPN-клиента',
  'DELETE /api/access-points/:id/clients/:id':'Удаление VPN-клиента'
};

export function auditAction(method, url, detail) {
  const path = String(url).split('?')[0].replace(/\/(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}|(?:[a-f0-9]{2}:){5}[a-f0-9]{2})(?=\/|$)/gi,'/:id');
  const action = method+' '+path;
  if (action==='POST /api/system/action' && ['config','reboot','poweroff'].includes(detail)) return action+':'+detail;
  return Object.hasOwn(eventLabels,action) ? action : method+' /api/unknown';
}

export function eventResult(status) {
  if (status===299) return 'Disconnected';
  if (status===202) return 'Принято в работу';
  if (status>=200 && status<300) return 'Выполнено';
  if (status===401) return 'Требуется вход';
  if (status===403) return 'Нет доступа';
  if (status===404) return 'Объект не найден';
  if (status===409) return 'Конфликт изменений';
  if (status===429) return 'Слишком много попыток';
  if (status>=500) return 'Ошибка службы';
  if (status>=400) return 'Неверные данные';
  return 'Результат неизвестен';
}

const moduleNames={system:'FreedomGate',mihomo:'mihomo',xray:'Xray',outline:'Shadowsocks Outline SDK',adguard:'AdGuard Home',zapret:'zapret2',frp:'frp',tor:'Tor / Snowflake',lantern:'Lantern','domain-lists':'Domain presets','diagnostic-blocklist':'Diagnostic domain list'};
export function moduleAuditDetail(body){
 if(!['check','update'].includes(body?.op))return '';
 const id=Object.hasOwn(moduleNames,body.id)?body.id:null;
 if(body.id && !id)return '';
 return JSON.stringify({kind:'module',op:body.op,id,...(body.op==='update' && typeof body.version==='string' && /^v?[0-9][\w.-]{0,63}$/.test(body.version)?{version:body.version}:{})});
}
export function presentEvent(event){
 let context;try{context=JSON.parse(event.detail);}catch{}
 const service=context?.service==='freedomgate-network.service'?context.service:'freedomgate.service';
 if(event.action==='SYSTEM restore-failed'){
  const component=moduleNames[context?.stage];
  return {key:component?'Failed to restore service {service} ({component}).':'Failed to restore service {service}.',parameters:{service,component},detail:''};
 }
 if(event.action==='SYSTEM service-failed')return {key:'Service {service} terminated unexpectedly.',parameters:{service},detail:''};
 if(event.action==='POST /api/modules' && context?.kind==='module' && ['check','update'].includes(context.op)){
  const module=moduleNames[context.id];
  if(!module)return {key:'Checking module updates.',detail:''};
  return {key:context.op==='check'?'Checking updates for {module}.':context.version?'Starting update of {module} to {version}.':'Starting update of {module}.',parameters:{module,version:context.version},detail:''};
 }
 return {key:eventLabels[event.action] || 'Действие в админке',detail:event.detail};
}
