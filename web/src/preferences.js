import { ref, watch } from 'vue';
import {formatMessage,messageParameters} from './lib/i18n-format.js';
import en from './locales/en.json';
import ru from './locales/ru.json';
import zh from './locales/zh-CN.json';
const dictionaries={en,ru,'zh-CN':zh};
const chinesePrefixes=Object.keys(zh).filter(key=>/[：:]\s*$/.test(key) || /\s$/.test(key)).sort((a,b)=>b.length-a.length);
export const languageOptions=[{value:'en',label:'English'},{value:'ru',label:'Русский'},{value:'zh-CN',label:'简体中文'}];
// Only fully available locales are exposed in the language selector.
export const localeRegistry = { en:{direction:'ltr',available:true}, ru:{direction:'ltr',available:true}, fa:{direction:'rtl',available:false}, 'zh-CN':{direction:'ltr',available:true} };
function read(key, fallback) { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } }
const locale = ref(Object.hasOwn(dictionaries,read('fg.locale','en')) ? read('fg.locale','en') : 'en');
const sidebarCollapsed=ref(read('fg.sidebarCollapsed','false')==='true');
watch(sidebarCollapsed,value=>{try{localStorage.setItem('fg.sidebarCollapsed',String(value));}catch{}});
const theme = ref(read('fg.theme','dark')==='light'?'light':'dark');
watch([locale,theme],()=>{
  document.documentElement.lang=locale.value;
  document.documentElement.dir=localeRegistry[locale.value]?.direction || 'ltr';
  document.documentElement.dataset.theme=theme.value;
  document.documentElement.style.colorScheme=theme.value;
  let favicon=document.querySelector('link#app-favicon');
  if(!favicon){favicon=document.createElement('link');favicon.id='app-favicon';favicon.rel='icon';favicon.type='image/svg+xml';document.head.append(favicon);}
  favicon.setAttribute('sizes','any');favicon.href='/favicon.svg';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content',theme.value==='light'?'#f8f9fb':'#101318');
  try { localStorage.setItem('fg.locale',locale.value);localStorage.setItem('fg.theme',theme.value); } catch { /* Preferences still work without storage. */ }
},{immediate:true});
// Old persisted errors may contain a translated Russian value rather than a key.
const legacyMessageKeys=new Map(Object.entries(ru).filter(([key,value])=>!/[А-Яа-яЁё]/.test(key) && /[А-Яа-яЁё]/.test(value)).map(([key,value])=>[value,key]));
const parameterizedMessages=Object.keys(en).filter(key=>key.includes('{')).sort((a,b)=>b.replace(/\{\w+\}/g,'').length-a.replace(/\{\w+\}/g,'').length);
function lookupTranslation(key) {
 const dictionary=dictionaries[locale.value] || en;
 if(dictionary[key])return dictionary[key];
 const legacyKey=legacyMessageKeys.get(key);
 if(legacyKey)return dictionary[legacyKey] || en[legacyKey] || legacyKey;
 for(const template of parameterizedMessages){const parameters=messageParameters(template,key);if(parameters)return formatMessage(dictionary[template] || en[template],parameters);}
 // Keep dynamic details (addresses, names, HTTP codes) outside translated prefixes.
 if(locale.value==='zh-CN' && typeof key==='string'){
  const prefix=chinesePrefixes.find(k=>key.startsWith(k));
  if(prefix)return dictionary[prefix]+key.slice(prefix.length);
 }
 return en[key] || key;
}
export function translate(key,parameters) { return formatMessage(lookupTranslation(key),parameters); }
export function usePreferences() { return {locale,theme,sidebarCollapsed,languageOptions,t:translate}; }
