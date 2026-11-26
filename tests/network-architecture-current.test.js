import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildNetworkArchitecture} from '../web/src/lib/network-architecture.js';
const text=readFileSync(new URL('../web/src/fixtures/network-architecture-current.json',import.meta.url),'utf8');
const snapshot=JSON.parse(text);
test('current-map fixture preserves captured topology and paths without production identities',()=>{
 assert.equal(snapshot.profiles.length,8);assert.equal(snapshot.connectionGroups.length,2);assert.equal(snapshot.rules.groups.length,12);assert.equal(snapshot.clients.length,8);assert.equal(snapshot.observations.paths.length,9);
 const graph=buildNetworkArchitecture(snapshot);assert.equal(graph.nodes.filter(n=>n.kind==='device').length,snapshot.clients.filter(c=>c.online===true).length);
 const ids=new Set(graph.nodes.map(node=>node.id));assert.equal(ids.size,graph.nodes.length);
 for(const edge of graph.edges){assert.ok(ids.has(edge.source));assert.ok(ids.has(edge.target));}
 assert.ok(graph.edges.some(edge=>edge.downloadRate>0));assert.ok(graph.nodes.some(node=>node.state==='disabled'));assert.ok(!graph.nodes.some(node=>node.kind==='device'&&node.state==='offline'));
 for(const client of snapshot.clients){assert.match(client.hostname,/^(Device|Remote client) /);if(client.mac)assert.match(client.mac,/^02:00:00:00:00:/);if(client.ip)assert.match(client.ip,/^198\.51\.100\./);}
 assert.doesNotMatch(text,/192\.168\.|10\.20\.|"password"|"secret"|"inboundUser"|"config"|"token"/);
 for(const profile of snapshot.profiles)assert.match(profile.id,/^gw-\d{5}$/);
});
