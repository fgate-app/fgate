export const pagePaths={'Обзор':'/overview','Подключения':'/connections','Клиенты':'/clients','Точки доступа':'/access-points','Журнал':'/journal'};
export const routePaths={'Домены и IP':'domains','Устройства':'devices','Локальные маршруты':'local'};
export const settingsPaths={'Система':'system','Сеть':'network','Интерфейс':'interface','DNS':'dns','Модули и интеграции':'modules','Пользователи':'users','Поддержка SSH':'ssh','Логи':'logs','Аккаунт':'account'};
export function locationFor(page,routeSection,settingsSection,connectionSection,clientSection){
 if(page==='Подключения' && connectionSection==='Подписки')return '/connections/subscriptions';
 if(page==='Подключения' && connectionSection==='Группы')return '/connections/groups';
 if(page==='Маршруты')return '/routes/'+(routePaths[routeSection] || 'domains');
 if(page==='Настройки')return '/settings/'+(settingsPaths[settingsSection] || 'network');
 return pagePaths[page] || '/overview';
}
export function stateFor(path){
 if(path.replace(/\/+$/,'')==='/connections/subscriptions')return {page:'Подключения',connectionSection:'Подписки'};
 if(path.replace(/\/+$/,'')==='/connections/groups')return {page:'Подключения',connectionSection:'Группы'};
 const clean=path.replace(/\/+$/,'') || '/';
 if(clean==='/system')return {page:'Обзор'};
 if(clean==='/incoming' || clean==='/clients/access-points')return {page:'Точки доступа'};
 if(clean==='/clients/devices')return {page:'Клиенты',clientSection:'Устройства'};
 for(const [page,url] of Object.entries(pagePaths))if(url===clean)return {page};
 if(clean==='/routes')return {page:'Маршруты',routeSection:'Домены и IP'};
 if(clean==='/settings')return {page:'Настройки',settingsSection:'Система'};
 for(const [routeSection,part] of Object.entries(routePaths))if(clean==='/routes/'+part)return {page:'Маршруты',routeSection};
 for(const [settingsSection,part] of Object.entries(settingsPaths))if(clean==='/settings/'+part)return {page:'Настройки',settingsSection};
 return {page:'Обзор'};
}
