import test from 'node:test';
import assert from 'node:assert/strict';
import {readNetworkMapView,writeNetworkMapView,networkMapViewKey} from '../web/src/lib/network-map-view.js';
test('map view persists only scale and offsets and safely rejects malformed storage',()=>{
 const values=new Map(),storage={getItem:key=>values.get(key),setItem:(key,value)=>values.set(key,value)};
 assert.equal(readNetworkMapView(storage),null);
 assert.equal(writeNetworkMapView({scale:1.2,offset:{x:-250,y:42},nodes:['private name']},storage),true);
 assert.deepEqual(readNetworkMapView(storage),{scale:1.2,offset:{x:-250,y:42}});assert.ok(!values.get(networkMapViewKey).includes('private'));
 for(const value of ['bad',JSON.stringify({version:2,scale:1,offset:{x:0,y:0}}),JSON.stringify({version:1,scale:9,offset:{x:0,y:0}}),JSON.stringify({version:1,scale:1,offset:{x:'bad',y:0}})]){values.set(networkMapViewKey,value);assert.equal(readNetworkMapView(storage),null);}
 assert.equal(writeNetworkMapView({scale:.12,offset:{x:16,y:16}},storage),true);assert.equal(readNetworkMapView(storage).scale,.12);
 const denied={getItem(){throw Error('denied');},setItem(){throw Error('denied');}};
 assert.equal(readNetworkMapView(denied),null);assert.equal(writeNetworkMapView({scale:1,offset:{x:0,y:0}},denied),false);
});
