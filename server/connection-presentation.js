import {isIP} from 'node:net';
import {networkInterfaces} from 'node:os';

// An open mihomo socket is not evidence that its originating device is online.
// Keep transport state intact and describe the source separately.
export function describeConnections(connections,{clients=[],interfaces=networkInterfaces()}={}){
 const devices=new Map(clients.map(client=>[client.ip,client]));
 const local=new Set(Object.values(interfaces).flat().map(entry=>entry.address));
 return connections.map(connection=>{
  const device=devices.get(connection.sourceIP);
  if(device)return {...connection,sourceKind:'device',sourceName:device.hostname || device.ip,clientOnline:device.online};
  const ip=connection.sourceIP || '';
  const service=connection.type==='Inner' || !ip || ip==='::1' || isIP(ip)===4 && ip.startsWith('127.') || local.has(ip);
  return {...connection,sourceKind:service?'service':'unknown',sourceName:service?'FreedomGate':ip,clientOnline:null};
 });
}
