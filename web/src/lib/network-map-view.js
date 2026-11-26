export const networkMapViewKey='freedomgate.network-map.view';
const valid=value=>value?.version===1&&Number.isFinite(value.scale)&&value.scale>0&&value.scale<=2.4&&Number.isFinite(value.offset?.x)&&Number.isFinite(value.offset?.y);
export function readNetworkMapView(storage){
 try{const value=JSON.parse((storage || globalThis.localStorage)?.getItem(networkMapViewKey) || 'null');return valid(value)?{scale:value.scale,offset:{x:value.offset.x,y:value.offset.y}}:null;}catch{return null;}
}
export function writeNetworkMapView(view,storage){
 const value={version:1,scale:view.scale,offset:{x:view.offset.x,y:view.offset.y}};if(!valid(value))return false;
 try{const target=storage || globalThis.localStorage;if(!target)return false;target.setItem(networkMapViewKey,JSON.stringify(value));return true;}catch{return false;}
}
