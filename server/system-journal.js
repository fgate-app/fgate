import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const execute=promisify(execFile);

// Store only recognised event templates; raw journal messages can contain secrets.
export function classifySystemEvent(entry) {
 const message=String(entry.MESSAGE || ''),source=entry.SYSLOG_IDENTIFIER || '',unit=entry._SYSTEMD_UNIT || '';
 if(source==='hostapd') {
  if(/pairwise key handshake completed/.test(message))return ['SYSTEM wifi-connected',200];
  if(/IEEE 802\.11: disassociated/.test(message))return ['SYSTEM wifi-disconnected',299];
  if(/AP-DISABLED|INTERFACE-DISABLED|Failed to initialize|Could not configure/.test(message))return ['SYSTEM wifi-failed',503];
  if(/AP-ENABLED/.test(message))return ['SYSTEM wifi-started',200];
 }
 if(source==='dnsmasq' && /bad DHCP|failed to|FAILED to/.test(message))return ['SYSTEM dhcp-failed',503];
 if(source==='dnsmasq' && /exiting on receipt of SIGTERM/.test(message))return ['SYSTEM dhcp-stopped',200];
 if(source==='dnsmasq' && /^started, version/.test(message))return ['SYSTEM dhcp-started',200];
 if(source==='kernel' && /Out of memory:|Killed process|under-voltage|brcmfmac.*(?:failed|timeout|error)/i.test(message))return ['SYSTEM hardware-failed',503];
 if(source==='systemd' && /freedomgate(?:-network)?\.service: (?:Main process exited|Failed with result|Watchdog timeout)/.test(message))return ['SYSTEM service-failed',503,{service:message.match(/freedomgate(?:-network)?\.service/)?.[0]}];
 if(unit==='freedomgate.service' && /FreedomGate startup: .*"state":"failed"|runtime restore failed/.test(message)){let stage;try{const data=JSON.parse(message.slice(message.indexOf('{')));stage=data.stageFailed || data.stage;}catch{}const allowed=['adguard','mihomo','xray','tor','lantern','zapret'];return ['SYSTEM restore-failed',503,{service:'freedomgate.service',...(allowed.includes(stage)?{stage}:{})}];}
 if(unit==='freedomgate.service' && /network apply on start failed|zapret restore failed|shutdown failed/.test(message))return ['SYSTEM network-failed',503];
 return null;
}

export function startSystemJournal(store,{read=execute,interval=5000}={}) {
 let stopped=false,busy=false,warned=false;
 async function poll(){
  if(stopped || busy)return;
  busy=true;
  try {
   const cursor=store.journalCursor();
   const args=['--no-pager','--quiet','--output=json',...(cursor?['--after-cursor='+cursor]:['--since=-1h']), 'SYSLOG_IDENTIFIER=hostapd','+','SYSLOG_IDENTIFIER=dnsmasq','+','SYSLOG_IDENTIFIER=kernel','+','SYSLOG_IDENTIFIER=systemd','+','_SYSTEMD_UNIT=freedomgate.service'];
   const {stdout}=await read('journalctl',args,{timeout:10000,maxBuffer:8*1024*1024});
   if(stopped)return;
   for(const line of stdout.split('\n').filter(Boolean)) {
    const entry=JSON.parse(line),event=classifySystemEvent(entry);
    store.recordJournalEntry(entry,event);
   }
   warned=false;
  }catch(error){
   if(!stopped && /(?:seek|cursor)/i.test(String(error.stderr || '')))store.db.prepare('DELETE FROM system_journal_state WHERE id=1').run();
   if(!stopped && !warned){store.recordEvent('system','SYSTEM journal-unavailable',503);warned=true;}
  }finally{busy=false;}
 }
 const timer=setInterval(poll,interval);timer.unref();poll();
 return {stop(){stopped=true;clearInterval(timer);},poll};
}
