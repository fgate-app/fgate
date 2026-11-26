import {safeDhcpLeases} from './dhcp-config.js';
// Client for the privileged network helper.
//
// The web service runs sandboxed (NoNewPrivileges, empty capability set), so it
// never executes hostapd, dnsmasq or nft directly. It sends JSON commands to the
// root helper over a Unix socket and reads the JSON result back. The helper is
// the only process allowed to touch interfaces and firewall rules.

import { connect } from 'node:net';
import { join } from 'node:path';

const SOCKET_PATH =
  process.env.FREEDOMGATE_NETWORK_SOCKET ||
  join(process.env.FREEDOMGATE_RUN_DIR || '/run/freedomgate', 'network.sock');
const DEFAULT_TIMEOUT = Number(process.env.FREEDOMGATE_HELPER_TIMEOUT || 20000);

export class NetworkHelperError extends Error {
  constructor(message, { unavailable = false } = {}) {
    super(message);
    this.name = 'NetworkHelperError';
    this.unavailable = unavailable;
  }
}

export const diagnosticActions = new Set(['diagnostic-uplink','diagnostic-endpoint','diagnostic-socket','diagnostic-dns','diagnostic-sni','diagnostic-strategy','diagnostic-endpoint-route']);

export function sendCommand(command, { timeout = DEFAULT_TIMEOUT, signal, socketPath = SOCKET_PATH } = {}) {
  return new Promise((resolve, reject) => {
    let socket, raw = '', settled = false;
    const finish = (error, value) => {
      if(settled)return;
      settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);
      socket?.destroy();error?reject(error):resolve(value);
    };
    const abort=()=>finish(Object.assign(new Error('Diagnostic cancelled.'),{name:'AbortError',code:'ABORTED'}));
    const timer=setTimeout(()=>finish(new NetworkHelperError('The privileged helper timed out.',{unavailable:true})),timeout);
    if(signal?.aborted){abort();return;}
    signal?.addEventListener('abort',abort,{once:true});
    try{socket=connect(socketPath);socket.setEncoding('utf8');}catch{finish(new NetworkHelperError('Failed to connect to the helper.',{unavailable:true}));return;}
    socket.on('connect',()=>{
      if(settled)return;
      // Diagnostics keep the write side open so disconnect means cancellation.
      if(diagnosticActions.has(command.action))socket.write(JSON.stringify(command)+'\n');
      else socket.end(JSON.stringify(command));
    });
    socket.on('data',chunk=>{
      raw+=chunk;
      if(Buffer.byteLength(raw)>(command.action==='diagnostic-dns'?256:64)*1024)finish(new NetworkHelperError('The helper response is too large.'));
    });
    socket.on('end',()=>{
      try{const value=JSON.parse(raw);finish(null,value);}
      catch{finish(new NetworkHelperError('The helper returned an invalid response.'));}
    });
    socket.on('error',()=>finish(new NetworkHelperError('The helper is unavailable.',{unavailable:true})));
    socket.on('close',()=>{if(!settled)finish(new NetworkHelperError('The helper connection closed.',{unavailable:true}));});
  });
}

export function applyNetwork(setup) {
  return sendCommand({ action: 'apply', config: {...setup,staticLeases:safeDhcpLeases(setup.staticLeases)} });
}

export function applyLeases(leases) {
  return sendCommand({ action: 'leases', leases:safeDhcpLeases(leases) });
}

export function stopNetwork() {
  return sendCommand({ action: 'stop' });
}

export function networkStatus() {
  return sendCommand({ action: 'status' });
}

export function systemAction(action) {
  return sendCommand({ action: 'system', system: action });
}

export function applyZapret(payload) {
  return sendCommand({ action: 'zapret', op: 'apply', ...payload }, { timeout: 30000 });
}

export function stopZapret() {
  return sendCommand({ action: 'zapret', op: 'stop' });
}

export function zapretStatus() {
  return sendCommand({ action: 'zapret', op: 'status' });
}

export function moduleCommand(op,id,version,gateways=[]){return sendCommand({action:'modules',op,id,version,gateways});}

export function zapretProbeUdp(){return sendCommand({action:'zapret',op:'probe-udp'},{timeout:5000});}

export function ensureOutlineDpi(){return sendCommand({action:'outline-dpi'},{timeout:30000});}

export function probeUplink({signal}={}){return sendCommand({action:'diagnostic-uplink'},{timeout:20000,signal});}

export function probeGatewayEndpoint({addresses,port,capture=false},{signal}={}){return sendCommand({action:'diagnostic-endpoint',addresses,port,capture},{timeout:42000,signal});}

export function observeGatewaySocket({pid,address,port,processStartedAt,inodes,signal}){return sendCommand({action:'diagnostic-socket',pid,address,port,processStartedAt,inodes},{timeout:6000,signal});}

export function probeDnsMatrix({name,providers,family=4},{signal}={}){return sendCommand({action:'diagnostic-dns',name,providers,family},{signal,timeout:45000});}

export function probeSni({name,fakeIpRanges=[]},{signal}={}){return sendCommand({action:'diagnostic-sni',name,fakeIpRanges},{signal,timeout:55000});}

export function probeEndpointDns({name,provider},{signal}={}){return sendCommand({action:'diagnostic-dns',mode:'endpoint',name,providers:[provider]},{signal,timeout:15000});}

export function probeEndpointRoute({addresses,port},{signal}={}){return sendCommand({action:'diagnostic-endpoint-route',addresses,port},{signal,timeout:18000});}

export function probeMtu({address},{signal}={}){return sendCommand({action:'diagnostic-mtu',address},{signal,timeout:12000});}
