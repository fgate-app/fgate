import {dirname} from 'node:path';
import {AccessPointRepository} from './access-points/repository.js';
import {HttpError} from './http.js';
export const telegramCategories=['gateways','services','cloud','updates','backups'];
export const telegramDefaults={enabled:false,systemName:'FreedomGate',chatId:'',language:'en',categories:telegramCategories};
export function normalizeTelegram(input={}){
 if(!input || typeof input!=='object' || Array.isArray(input))throw new HttpError(400,'Invalid Telegram settings.');
 const value={...telegramDefaults,...input};
 if(typeof value.systemName!=='string' || !value.systemName.trim() || value.systemName.length>80 || /[\x00-\x1f]/.test(value.systemName))throw new HttpError(400,'Enter a system name of up to 80 characters.');
 if(typeof value.chatId!=='string' || value.chatId && !/^-?[0-9]{1,20}$/.test(value.chatId))throw new HttpError(400,'Enter a numeric Telegram chat ID.');
 if(!['en','ru','zh'].includes(value.language) || !Array.isArray(value.categories) || value.categories.some(x=>!telegramCategories.includes(x)))throw new HttpError(400,'Invalid Telegram notification preferences.');
 if(value.token && (typeof value.token!=='string' || !/^\d{5,20}:[A-Za-z0-9_-]{20,100}$/.test(value.token)))throw new HttpError(400,'Enter a valid Telegram bot token.');
 if(value.enabled===true && (!value.token || !value.chatId))throw new HttpError(400,'Set a bot token and recipient before enabling Telegram.');
 return {enabled:value.enabled===true,systemName:value.systemName.trim(),chatId:value.chatId,language:value.language,categories:[...new Set(value.categories)],token:value.token || ''};
}
export function telegramRepository(store,stateDir=process.env.FREEDOMGATE_STATE_DIR || dirname(process.env.FREEDOMGATE_DB || '.data/freedomgate.sqlite')){
 return new AccessPointRepository(store.db,{stateDir,table:'telegram_integrations',present:value=>value});
}
export function readTelegram(repo){return repo.all().find(x=>x.id==='settings') || {...telegramDefaults,token:''};}
export function writeTelegram(repo,value){const normalized=normalizeTelegram(value);repo.save({id:'settings',...normalized});return normalized;}
export function publicTelegram(value){const {token,...result}=value;delete result.id;return {...result,hasToken:!!token};}
