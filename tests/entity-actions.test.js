import test from 'node:test';
import assert from 'node:assert/strict';
import {gatewayActions,routeActions,clientActions,connectionGroupActions,moduleArchitectureActions,moduleConfigTypes,architectureCreateActions,architectureToggleActions} from '../web/src/lib/entity-actions.js';
const full={t:key=>key,can:()=>true},read={...full,can:()=>false},values=items=>items.map(item=>item.value);
test('gateway map/table menus retain engine and builtin differences',()=>{
 assert.deepEqual(values(gatewayActions({engine:'direct'},full)),['routes','journal','diagnostics']);
 assert.deepEqual(values(gatewayActions({engine:'lantern',builtin:true},full)),['diagnostics','routes','journal']);
 assert.deepEqual(values(gatewayActions({engine:'tor',builtin:true},full)),['edit','diagnostics','routes','journal']);
 const custom=gatewayActions({engine:'xray'},full);assert.equal(custom.at(-1).danger,true);
 assert.deepEqual(values(gatewayActions({engine:'xray'},read)),['routes','journal']);
});
test('rules, groups and clients reuse permission-aware table action sets',()=>{
 assert.deepEqual(values(routeActions({system:true},read)),['dns']);
 assert.ok(routeActions({},read).every(item=>item.disabled));
 assert.deepEqual(values(connectionGroupActions(read)),['routes']);
 assert.deepEqual(values(clientActions({remote:true},full)),['journal']);
 assert.deepEqual(values(clientActions({},full)),['journal','pin']);
 assert.deepEqual(values(clientActions({staticIp:'192.0.2.1'},full)),['journal','edit','unpin']);
 assert.deepEqual(values(clientActions({},read)),['journal']);
});
test('module menu hides unsupported/bundled updates and only creates appropriate configurations',()=>{
 for(const id of ['tor','lantern','outline'])assert.ok(!values(moduleArchitectureActions(id,{...full,supported:true})).includes('update'));
 assert.deepEqual(values(moduleArchitectureActions('xray',{...full,supported:false})),['modules','add']);
 assert.deepEqual(values(moduleArchitectureActions('xray',{...full,supported:true})),['modules','update','add']);
 assert.deepEqual(values(moduleArchitectureActions('xray',{...read,supported:true})),['modules']);
 assert.deepEqual(values(moduleArchitectureActions('xray',{...full,supported:true,working:true,installed:false})),['modules']);
 for(const id of ['adguard','frp','zapret','tor','lantern'])assert.ok(!values(moduleArchitectureActions(id,full)).includes('add'));
 assert.deepEqual(moduleConfigTypes,{mihomo:'socks5',xray:'vless',outline:'ss'});
});

test('map create actions match entity write permissions',()=>{
 assert.deepEqual(values(architectureCreateActions(full)),['gateway','group','rule']);
 assert.deepEqual(architectureCreateActions(read),[]);
 assert.deepEqual(values(architectureCreateActions({...full,can:p=>p==='profiles:write'})),['gateway','group']);
 assert.deepEqual(values(architectureCreateActions({...full,can:p=>p==='settings:write'})),['rule']);
});

test('map toggles mirror table eligibility, permissions and persisted enabled state',()=>{
 for(const engine of ['xray','outline','mihomo','tor','lantern','zapret']){
  assert.deepEqual(architectureToggleActions({engine,builtin:true},{...full,kind:'gateway'}),[{value:'disable',label:'Отключить'}]);
  assert.deepEqual(values(architectureToggleActions({engine,enabled:false},{...full,kind:'gateway'})),['enable']);
 }
 assert.deepEqual(architectureToggleActions({engine:'direct'},{...full,kind:'gateway'}),[]);
 assert.deepEqual(architectureToggleActions({system:true},{...full,kind:'rule'}),[]);
 assert.deepEqual(architectureToggleActions({},{...read,kind:'rule'}),[]);
 assert.deepEqual(architectureToggleActions({engine:'xray'},{...read,kind:'gateway'}),[]);
 assert.deepEqual(values(architectureToggleActions({enabled:false},{...full,kind:'rule'})),['enable']);
 assert.deepEqual(values(architectureToggleActions({},{...full,kind:'rule'})),['disable']);
 assert.deepEqual(architectureToggleActions({},{...full,can:p=>p==='profiles:write',kind:'rule'}),[]);
});
