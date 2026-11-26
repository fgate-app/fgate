import os from 'node:os';
import { readFile, statfs } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute=promisify(execFile);
export function cpuCounters(cpus) {return cpus.reduce((a,c)=>({idle:a.idle+c.times.idle,total:a.total+Object.values(c.times).reduce((x,y)=>x+y,0)}),{idle:0,total:0});}
export function cpuPercent(before,after) {const total=after.total-before.total;return total>0?Math.max(0,Math.min(100,100*(1-(after.idle-before.idle)/total))):null;}
export function decodePower(text) {const match=/^throttled=0x([0-9a-f]+)\s*$/i.exec(text);if(!match)return null;const flags=parseInt(match[1],16);return {source:'vcgencmd',flags,underVoltage:!!(flags&1),frequencyCapped:!!(flags&2),throttled:!!(flags&4),softTemperatureLimit:!!(flags&8),underVoltageOccurred:!!(flags&0x10000),throttledOccurred:!!(flags&0x40000)};}
async function piSensors(){let model='';try{model=await readFile('/proc/device-tree/model','utf8');}catch{}if(!model.includes('Raspberry Pi'))return {temperature:null,power:null};
 const command=async arg=>{for(const path of ['/usr/bin/vcgencmd','/opt/vc/bin/vcgencmd'])try{return (await execute(path,[arg],{timeout:1500,maxBuffer:4096})).stdout;}catch{}return '';};
 const [temp,power]=await Promise.all([command('measure_temp'),command('get_throttled')]);const match=/temp=([\d.]+)/.exec(temp);return {temperature:match?{celsius:Number(match[1]),source:'vcgencmd'}:null,power:decodePower(power)};
}
export function createMetricsCollector(){let previous=cpuCounters(os.cpus()),cached=null,pending=null;
 return async()=>{if(cached && Date.now()-Date.parse(cached.timestamp)<3000)return cached;if(pending)return pending;
 pending=(async()=>{const cpus=os.cpus(),current=cpuCounters(cpus),cpu=cpuPercent(previous,current);previous=current;
 let available=os.freemem(),memorySource='os.freemem';if(os.platform()==='linux')try{const info=await readFile('/proc/meminfo','utf8'),match=/^MemAvailable:\s+(\d+) kB/m.exec(info);if(match){available=Number(match[1])*1024;memorySource='MemAvailable';}}catch{}
 const total=os.totalmem();let disk=null;try{const fs=await statfs(process.cwd());const capacity=fs.blocks*fs.bsize,free=fs.bfree*fs.bsize;disk={path:process.cwd(),total:capacity,used:capacity-free,available:fs.bavail*fs.bsize,percent:capacity?100*(capacity-free)/capacity:null};}catch{}
 const sensors=await piSensors();cached={timestamp:new Date().toISOString(),host:{name:os.hostname(),platform:os.platform(),architecture:os.arch(),uptime:os.uptime()},cpu:{percent:cpu,cores:cpus.length,model:cpus[0]?.model || null,load:os.loadavg()},memory:{total,available,used:total-available,percent:total?100*(total-available)/total:null,source:memorySource},disk,...sensors};return cached;})().finally(()=>{pending=null;});return pending;
 };
}
