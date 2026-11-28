import {telegramChats} from './telegram-chats.js';
import {normalizeTelegram} from './telegram-settings.js';
import {telegramRepository,readTelegram,writeTelegram,publicTelegram} from './telegram-settings.js';
import {telegramMessage} from '../shared/telegram-messages.js';
import {HttpError} from './http.js';
const MAX_QUEUE=50,TTL=3600000,DEBOUNCE=15000,RATE=10000;
export class TelegramNotifications{
 constructor(store,{fetchImpl,now=Date.now,stateDir}={}){
  this.store=store;this.repo=telegramRepository(store,stateDir);this.fetch=fetchImpl;this.now=now;this.closed=false;this.generation=0;
  store.db.exec('CREATE TABLE IF NOT EXISTS telegram_delivery(id INTEGER PRIMARY KEY CHECK(id=1),value TEXT NOT NULL)');
  const row=store.db.prepare('SELECT value FROM telegram_delivery WHERE id=1').get();
  try{this.state=JSON.parse(row?.value);}catch{}
  this.state ||= {cursor:Number(store.db.prepare('SELECT max(id) AS id FROM events').get().id)||0,queue:[],observations:{},enabledSince:this.now(),lastAttempt:0,lastDelivered:null,error:null};
  this.persist();
 }
 persist(){const keys=Object.keys(this.state.observations);if(keys.length>1000)for(const key of keys.sort((a,b)=>this.state.observations[a].since-this.state.observations[b].since).slice(0,keys.length-1000))delete this.state.observations[key];this.store.db.prepare('INSERT INTO telegram_delivery VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(JSON.stringify(this.state));}
 status(){return {...publicTelegram(readTelegram(this.repo)),delivery:{pending:this.state.queue.length,lastDelivered:this.state.lastDelivered,error:this.state.error}};}
 configure(input){const old=readTelegram(this.repo);const cfg=writeTelegram(this.repo,{...old,...input,token:input.token || old.token});this.cancel();this.state.queue=[];this.state.observations={};this.state.error=null;this.state.enabledSince=this.now();this.state.cursor=Number(this.store.db.prepare('SELECT max(id) AS id FROM events').get().id)||0;this.persist();return this.status();}
 cancel(){this.generation++;this.controller?.abort();this.testController?.abort();this.discoveryController?.abort();}
 stop(){this.closed=true;this.cancel();}
 enqueue(category,kind,component,key=component){const cfg=readTelegram(this.repo);if(!cfg.enabled || !cfg.categories.includes(category))return;
  const at=this.now();this.state.queue=this.state.queue.filter(e=>at-e.at<TTL);
  const duplicate=this.state.queue.find(e=>e.key===key && e.kind===kind);if(duplicate)return;
  this.state.queue.push({category,kind,component,key,at,attempts:0,nextAt:at});if(this.state.queue.length>MAX_QUEUE)this.state.queue.shift();
 }
 observe(key,value,{category,component,kind='changed',failed=false}={}){
  if(value===null || value===undefined)return;
  const at=this.now(),observations=this.state.observations;
  const entry=observations[key];
  // Baseline is silent; subsequent stable changes are notifications, not startup replays.
  if(!entry){observations[key]={value:failed?'unknown':value,pending:value,since:at};return;}
  if(entry.pending!==value){entry.pending=value;entry.since=at;}
  if(entry.value!==value && at-entry.since>=DEBOUNCE){entry.value=value;this.enqueue(category,kind==='health'?(failed?'failed':'restored'):kind,component,key);}
 }
 journal(){
  const rows=this.store.db.prepare('SELECT id,timestamp,action,status,detail FROM events WHERE id>? ORDER BY id LIMIT 200').all(this.state.cursor);
  for(const e of rows){this.state.cursor=e.id;if(this.now()-Date.parse(e.timestamp)>TTL || Date.parse(e.timestamp)<(this.state.enabledSince || 0))continue;
   if(e.action==='POST /api/configuration/backups' && e.status>=400)this.enqueue('backups','backupFailed','Configuration backup','backup');
   if(e.action==='SYSTEM service-failed'){
    let context;try{context=JSON.parse(e.detail);}catch{}
    const service=context?.service==='freedomgate-network.service'?'Network helper':'FreedomGate';
    this.enqueue('services','failed',service,'service-event-'+service);
    if(service==='FreedomGate')this.state.observations['service-app']={value:'failed',pending:'failed',since:this.now()};
   }
   const match=/^SYSTEM (wifi|dhcp)-(failed|started)$/.exec(e.action);
   if(match){const key='journal-'+match[1],value=match[2]==='failed'?'failed':'ready';this.state.observations[key]={...(this.state.observations[key] || {value:value==='failed'?'unknown':value}),pending:value,since:Math.min(this.now(),Date.parse(e.timestamp))};}
  }
 }
 beginUpdate(id){if(!['system','mihomo','xray','adguard','zapret','frp','domain-lists','diagnostic-blocklist'].includes(id))return;this.state.observations['update-'+id]={value:'installing',pending:'installing',since:this.now()};this.persist();}
 async tick(snapshot){if(this.closed || this.ticking)return;this.ticking=true;const generation=this.generation;
  try{const cfg=readTelegram(this.repo);if(!cfg.enabled){this.state.queue=[];this.state.observations={};this.state.cursor=Number(this.store.db.prepare('SELECT max(id) AS id FROM events').get().id)||0;this.persist();return;}
   this.journal();for(const id of ['wifi','dhcp']){const entry=this.state.observations['journal-'+id];if(entry)this.observe('journal-'+id,entry.pending,{category:'services',component:id==='wifi'?'Wi-Fi access point':'DHCP',kind:'health',failed:entry.pending==='failed'});}if(snapshot)await snapshot(this);if(this.closed || generation!==this.generation)return;this.persist();await this.deliver();
  }finally{this.ticking=false;}
 }
 async request(token,method,body,{signal,maxBytes=16384}={}){
  const response=await this.fetch('https://api.telegram.org/bot'+token+'/'+method,{method:'POST',body:JSON.stringify(body),headers:{'Content-Type':'application/json'},redirect:'error',acceptStatus:s=>s===429 || s>=400&&s<500,maxBytes,timeoutMs:10000,signal,validate:bytes=>{let data;try{data=JSON.parse(bytes);}catch{throw Error('Invalid Telegram response');}if(typeof data?.ok!=='boolean')throw Error('Invalid Telegram response');}});
  let data;try{data=await response.json();}catch{throw new HttpError(502,'Telegram returned an invalid response.');}
  if(!data.ok){const error=new HttpError(502,data.error_code===429?'Telegram rate limit reached.':'Telegram rejected the notification.');error.retryAfter=Math.min(3600,Math.max(1,Number(data.parameters?.retry_after)||10));error.permanent=[400,401,403,404].includes(data.error_code);error.telegramCode=data.error_code;throw error;}
  return data.result;
 }
 async send(cfg,event,signal){return this.request(cfg.token,'sendMessage',{chat_id:cfg.chatId,text:telegramMessage(cfg,event),link_preview_options:{is_disabled:true}},{signal});}
 async chats(input={},signal){
  if(this.discoveryBusy || this.now()-(this.lastDiscovery || 0)<5000)throw new HttpError(429,'Wait before detecting Telegram chats again.');
  const token=normalizeTelegram({token:input.token || readTelegram(this.repo).token}).token;
  if(!token)throw new HttpError(400,'Enter a bot token before detecting chats.');
  this.discoveryBusy=true;this.lastDiscovery=this.now();const generation=this.generation,controller=new AbortController();this.discoveryController=controller;
  const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  try{
   // No offset/allowed_updates: do not acknowledge messages or change the bot's subscription.
   const result=await this.request(token,'getUpdates',{limit:100,timeout:0},{signal:controller.signal,maxBytes:1024*1024});
   if(this.closed || generation!==this.generation || controller.signal.aborted)throw Error('Cancelled');
   return {chats:telegramChats(result)};
  }catch(error){throw new HttpError(error.telegramCode===409?409:502,error.telegramCode===409?'Telegram chat detection conflicts with a webhook or another bot client. Use a dedicated bot or enter the chat ID manually.':error.telegramCode===429?'Telegram rate limit reached.':'Could not detect Telegram chats. Send /start to the bot and try again.');}
  finally{this.discoveryBusy=false;signal?.removeEventListener('abort',abort);}
 }
 async test(){const cfg=readTelegram(this.repo);if(!cfg.enabled)throw new HttpError(400,'Enable and save Telegram before sending a test.');
  if(this.testBusy || this.now()-(this.lastTest||0)<RATE)throw new HttpError(429,'Wait before sending another test notification.');this.testBusy=true;this.lastTest=this.now();const generation=this.generation,controller=new AbortController();this.testController=controller;
  try{await this.send(cfg,{kind:'test',component:'Telegram',at:this.now()},controller.signal);if(generation!==this.generation)throw Error();this.state.error=null;this.state.lastDelivered=this.now();this.persist();return {ok:true};}
  catch{if(generation===this.generation){this.state.error='Could not send the Telegram test notification.';this.persist();}throw new HttpError(502,'Could not send the Telegram test notification.');}finally{this.testBusy=false;}
 }
 async deliver(){
  const cfg=readTelegram(this.repo),at=this.now();this.state.queue=this.state.queue.filter(e=>at-e.at<TTL && cfg.categories.includes(e.category));
  if(!cfg.enabled || !this.state.queue.length || at-this.state.lastAttempt<RATE)return;
  const event=this.state.queue[0];if(event.nextAt>at)return;const generation=this.generation;this.controller=new AbortController();this.state.lastAttempt=at;this.persist();
  try{await this.send(cfg,event,this.controller.signal);if(generation!==this.generation || this.closed)return;this.state.queue.shift();this.state.lastDelivered=this.now();this.state.error=null;this.store.recordEvent('system','SYSTEM telegram-delivered',200);}
  catch(error){if(generation!==this.generation || this.closed)return;event.attempts++;event.nextAt=this.now()+(error.retryAfter || Math.min(300,2**event.attempts*10))*1000;this.state.error=error.permanent?'Telegram rejected the notification.':'Telegram delivery is unavailable; retry scheduled.';if(error.permanent || event.attempts>=8)this.state.queue.shift();this.store.recordEvent('system','SYSTEM telegram-delivery-failed',503);}
  finally{if(generation===this.generation && !this.closed)this.persist();}
 }
}
