import AppButton from '../components/AppButton.vue';
import AppInput from '../components/AppInput.vue';
import AppSelect from '../components/AppSelect.vue';
import { ref } from 'vue';
import { usePreferences } from '../preferences.js';
export default {title:'Foundations/Interface',render:()=>({components:{AppSelect,AppButton,AppInput},setup:()=>({...usePreferences(),protocol:ref('vless')}),template:`<div style="max-width:760px"><section class="panel"><div class="eyebrow">FREEDOMGATE DESIGN SYSTEM</div><h1>{{t('Настройки')}}</h1><h2>{{t('Интерфейс')}}</h2><div class="row"><span>Primary text</span><span class="badge">Status badge</span></div></section><div class="alert" role="status">Settings saved</div><div class="alert error" role="alert">Connection unavailable</div><section class="panel"><form @submit.prevent><label>Connection name<AppInput placeholder="Primary VPN" /></label><label>Protocol<AppSelect v-model="protocol" label="Protocol" :options="[{value:'vless',label:'VLESS'},{value:'ss',label:'Shadowsocks'}]"/></label><AppButton type="submit">Save draft</AppButton></form></section></div>`})};
export const Playground={};
