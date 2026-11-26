import {isReleaseManagedModule} from '../../../shared/module-policy.js';

export function gatewayActions(profile,{t,can}){
 const journal={value:'journal',label:t('Показать соединения')};
 if(!can('profiles:write'))return [{value:'routes',label:t('Перейти к маршрутам')},journal];
 if(profile.engine==='direct')return [{value:'routes',label:t('Перейти к маршрутам')},journal,{value:'diagnostics',label:t('Диагностика шлюза')}];
 return [{value:'edit',label:t('Настроить')},...(profile.subscriptionId?[{value:'subscription-refresh',label:t('Update from subscription')}]:[]),{value:'diagnostics',label:t('Диагностика шлюза')},{value:'routes',label:t('Перейти к маршрутам')},journal,...(!profile.builtin?[{value:'delete',label:t('Удалить'),danger:true}]:[])];
}
export function routeActions(route,{t,can}){
 if(route?.system)return [{value:'dns',label:t('Настройки DNS')}];
 return [{value:'edit',label:t('Редактировать'),disabled:!can('settings:write')},{value:'delete',label:t('Удалить'),danger:true,disabled:!can('settings:write')}];
}
export function clientActions(client,{t,can}){
 return [{value:'journal',label:t('Показать соединения')},...(!client.remote&&can('settings:write')?(client.staticIp?[{value:'edit',label:t('Изменить адрес')},{value:'unpin',label:t('Открепить адрес')}]:[{value:'pin',label:t('Закрепить адрес')}]):[])];
}
export function connectionGroupActions({t,can}){
 return [...(can('profiles:write')?[{value:'edit',label:t('Редактировать')}]:[]),{value:'routes',label:t('Перейти к маршрутам')},...(can('profiles:write')?[{value:'delete',label:t('Удалить'),danger:true}]:[])];
}
export const moduleConfigTypes=Object.freeze({mihomo:'socks5',xray:'vless',outline:'ss'});
export function moduleArchitectureActions(id,{t,can,supported=false,working=false,installed=true}){
 return [{value:'modules',label:t('Модули')},...(!isReleaseManagedModule(id)&&supported&&!working&&can('users:write')?[{value:'update',label:t('Обновить')}]:[]),...(moduleConfigTypes[id]&&installed&&can('profiles:write')?[{value:'add',label:t('Добавить конфиг')}]:[])];
}

export function architectureCreateActions({t,can}){
 return [
  {column:'architecture.gateways',value:'gateway',label:t('Добавить способ выхода'),permission:'profiles:write'},
  {column:'architecture.connectionGroup',value:'group',label:t('Добавить группу'),permission:'profiles:write'},
  {column:'architecture.rules',value:'rule',label:t('architecture.addRule'),permission:'settings:write'},
 ].filter(action=>can(action.permission));
}

export function architectureToggleActions(entity,{t,can,kind}){
 const permission=kind==='gateway'?'profiles:write':'settings:write';
 if(!can(permission)||entity?.system||kind==='gateway'&&entity.engine==='direct')return [];
 const enable=entity.enabled===false;
 return [{value:enable?'enable':'disable',label:t(enable?'Включить':'Отключить')}];
}
