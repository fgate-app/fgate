import test from 'node:test';
import assert from 'node:assert/strict';
import { cpuPercent, decodePower, createMetricsCollector } from '../server/metrics.js';
test('CPU deltas and Raspberry Pi current/history flags',()=>{assert.equal(cpuPercent({idle:0,total:0},{idle:75,total:100}),25);assert.equal(cpuPercent({idle:2,total:4},{idle:2,total:4}),null);const p=decodePower('throttled=0x50000\n');assert.equal(p.underVoltage,false);assert.equal(p.throttled,false);assert.equal(p.underVoltageOccurred,true);assert.equal(p.throttledOccurred,true);assert.equal(decodePower('unknown'),null);});
test('metrics coalesce concurrent reads and cache host measurements',async()=>{const collect=createMetricsCollector();const [a,b]=await Promise.all([collect(),collect()]);assert.deepEqual(a,b);assert.equal((await collect()).timestamp,a.timestamp);assert.ok(a.memory.available<=a.memory.total);assert.ok(a.cpu.percent===null || (a.cpu.percent>=0 && a.cpu.percent<=100));});
