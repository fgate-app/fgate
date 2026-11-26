import {connectionGroupContains} from '../../../shared/connection-groups.js';
// Count configured route rows, including routes assigned through a group.
export function routeUsesConnection(route,id,groups=[]){
 if(!id)return true;
 const target=route.routeId ?? route.route_id;
 return target===id || groups.some(group=>group.id===target && connectionGroupContains(groups,group.id,id));
}
export function countConnectionRoutes(routes,id,groups=[]){return [...(routes.groups || []),...(routes.devices || [])].filter(route=>routeUsesConnection(route,id,groups)).length;}
