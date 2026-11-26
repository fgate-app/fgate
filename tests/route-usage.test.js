import test from 'node:test';import assert from 'node:assert/strict';
import {countConnectionRoutes,routeUsesConnection} from '../web/src/lib/route-usage.js';
test('route counts and connection filters agree for direct and group references without counting domain entries',()=>{
 const groups=[{id:'group',members:['a','b']}],routes={groups:[{id:'one',routeId:'a',entries:['a.example','b.example']},{id:'two',routeId:'group'},{id:'block',routeId:'block'}],devices:[{id:'phone',routeId:'group'}],locals:[{id:'alias'}]};
 assert.equal(countConnectionRoutes(routes,'a',groups),3);assert.equal(countConnectionRoutes(routes,'b',groups),2);assert.equal(countConnectionRoutes(routes,'group',groups),2);
 assert.equal(routeUsesConnection(routes.groups[0],'b',groups),false);assert.equal(routeUsesConnection(routes.groups[2],'block',groups),true);
});
