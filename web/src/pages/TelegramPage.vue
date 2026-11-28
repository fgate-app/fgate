<script setup>
import {ref,computed,onMounted,onUnmounted,watch} from 'vue';
import {usePreferences} from '../preferences.js';
import {notify} from '../lib/toasts.js';
import AppDataCard from '../components/AppDataCard.vue';
import AppButton from '../components/AppButton.vue';
import AppInput from '../components/AppInput.vue';
import AppPasswordInput from '../components/AppPasswordInput.vue';
import AppSelect from '../components/AppSelect.vue';
import AppSwitch from '../components/AppSwitch.vue';
import AppCheckbox from '../components/AppCheckbox.vue';
import AppInfoBlock from '../components/AppInfoBlock.vue';
const props=defineProps({api:Function});const {t}=usePreferences();
const saved=ref(''),settings=ref(null),token=ref(''),busy=ref(false),error=ref(''),delivery=ref(null),hasToken=ref(false);
const chats=ref([]),chatNotice=ref('');
watch(token,()=>{chats.value=[];chatNotice.value='';});
const chatOptions=computed(()=>chats.value.map(chat=>({value:chat.id,label:(chat.name || t('Telegram chat'))+' · '+chat.id})));
const categories={gateways:'Gateway failures, recovery and failover',services:'Service failures and recovery',cloud:'Cloud access changes',updates:'Update installation results',backups:'Configuration backup failures'};
const dirty=computed(()=>!!token.value || JSON.stringify(settings.value)!==saved.value);
let timer,closed=false;const controller=new AbortController();
async function load(){try{const data=await props.api('telegram',{signal:controller.signal});if(closed)return;delivery.value=data.delivery;if(!settings.value){const {delivery:state,hasToken:tokenSaved,...config}=data;settings.value=config;hasToken.value=tokenSaved;saved.value=JSON.stringify(config);}}catch(e){if(!closed)error.value=e.message;}}
async function save(){busy.value=true;error.value='';try{const data=await props.api('telegram',{method:'PUT',body:JSON.stringify({...settings.value,token:token.value})});hasToken.value=data.hasToken;token.value='';delivery.value=data.delivery;saved.value=JSON.stringify(settings.value);notify(t('Telegram settings saved.'),'success');}catch(e){error.value=e.message;}finally{busy.value=false;}}
async function detectChats(){busy.value=true;error.value='';chatNotice.value='';try{const data=await props.api('telegram/chats',{method:'POST',body:JSON.stringify({token:token.value}),signal:controller.signal});if(closed)return;chats.value=data.chats;if(chats.value.length===1){settings.value.chatId=chats.value[0].id;chatNotice.value='Chat detected. Save the settings to use this recipient.';}else chatNotice.value=chats.value.length?'Select the notification recipient, then save the settings.':'No chats found. Send /start to your bot in Telegram, then detect chats again.';}catch(e){if(!closed)error.value=e.message;}finally{busy.value=false;}}
async function test(){busy.value=true;error.value='';try{await props.api('telegram/test',{method:'POST',body:'{}'});notify(t('Test notification sent.'),'success');await load();}catch(e){error.value=e.message;}finally{busy.value=false;}}
onMounted(async()=>{await load();timer=setInterval(load,5000);});onUnmounted(()=>{closed=true;controller.abort();clearInterval(timer);});
</script>
<template>
 <AppDataCard :title="t('Telegram notifications')">
  <form v-if="settings" class="telegram-form form-section" @submit.prevent="save" data-testid="telegram-settings">
   <AppSwitch v-model="settings.enabled" :label="t('Enable Telegram notifications')" :disabled="busy" />
   <label>{{t('System name')}}<AppInput v-model="settings.systemName" maxlength="80" :disabled="busy" /></label>
   <label>{{t('Bot token')}}<AppPasswordInput v-model="token" autocomplete="new-password" :placeholder="hasToken?t('Saved token — leave empty to keep it'):''" :disabled="busy" /></label>
   <AppButton type="button" variant="secondary" :disabled="busy || (!hasToken && !token)" @click="detectChats">{{t(busy?'Working…':'Detect chat')}}</AppButton>
   <label v-if="chats.length>1">{{t('Notification recipient')}}<AppSelect v-model="settings.chatId" :label="t('Notification recipient')" :options="chatOptions" :disabled="busy" /></label>
   <p v-if="chatNotice" role="status">{{t(chatNotice)}}</p>
   <label>{{t('Recipient chat ID')}}<AppInput v-model="settings.chatId" inputmode="text" :disabled="busy" /></label>
   <AppInfoBlock>{{t('Send /start to your bot in the desired Telegram chat, then click Detect chat. If several chats are found, choose the recipient. The token stays hidden after saving.')}}</AppInfoBlock>
   <label>{{t('Notification language')}}<AppSelect v-model="settings.language" :options="[{value:'en',label:'English'},{value:'ru',label:'Русский'},{value:'zh',label:'中文'}]" :disabled="busy" /></label>
   <fieldset class="form-section"><legend>{{t('Events')}}</legend><AppCheckbox v-for="(label,key) in categories" :key="key" :label="t(label)" :model-value="settings.categories.includes(key)" :disabled="busy" @update:model-value="settings.categories=$event?[...settings.categories,key]:settings.categories.filter(x=>x!==key)" /></fieldset>
   <AppInfoBlock variant="warning">{{t('Notifications cannot be sent while the internet or FreedomGate is down. Recent queued events are delivered after recovery. Restoring a configuration disables this integration until you enable it again.')}}</AppInfoBlock>
   <p v-if="delivery" role="status">{{delivery.error?t(delivery.error):delivery.pending?t('Notifications queued: {count}',{count:delivery.pending}):delivery.lastDelivered?t('Last notification: {time}',{time:new Date(delivery.lastDelivered).toLocaleString()}):t('No notifications sent yet.')}}</p>
   <p v-if="error" class="alert" role="alert">{{error}}</p>
   <div class="telegram-actions"><AppButton type="submit" :disabled="busy">{{t('Сохранить')}}</AppButton><AppButton type="button" variant="secondary" :disabled="busy || !hasToken || dirty || !settings.enabled" @click="test">{{t('Send test notification')}}</AppButton></div>
  </form>
  <p v-else class="telegram-form" role="status">{{error || t('Загрузка')}}</p>
 </AppDataCard>
</template>
<style scoped>
.telegram-form{padding:var(--space-6);max-width:calc(var(--space-12)*16);margin:0}
.telegram-form fieldset{border:0;padding:0;min-width:0;margin:0}
.telegram-form legend{padding:0;margin-bottom:var(--space-4)}
.telegram-actions{display:flex;gap:var(--space-3);flex-wrap:wrap}
</style>
