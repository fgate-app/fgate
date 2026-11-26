import { ref } from 'vue';
import AppTabBar from '../components/AppTabBar.vue';
import AppTab from '../components/AppTab.vue';
import AppTabPanel from '../components/AppTabPanel.vue';
export default {title:'Components/Tabs',component:AppTabBar,args:{size:'m'},argTypes:{size:{control:'select',options:['m','s']}},render:args=>({components:{AppTabBar,AppTab,AppTabPanel},setup:()=>({args,value:ref('domains')}),template:`<AppTabBar v-bind="args" v-model="value" label="Route type"><AppTab value="domains">Domains</AppTab><AppTab value="ip">IP addresses</AppTab><AppTab value="devices">Network devices</AppTab><AppTab value="disabled" disabled>Unavailable</AppTab><template #panels><AppTabPanel value="domains"><div class="panel">Domain rules</div></AppTabPanel><AppTabPanel value="ip"><div class="panel">IP rules</div></AppTabPanel><AppTabPanel value="devices"><div class="panel">Device rules</div></AppTabPanel></template></AppTabBar>`})};
export const Medium={};
export const Small={args:{size:'s'}};
export const Overflow={render:()=>({components:{AppTabBar,AppTab,AppTabPanel},setup:()=>({value:ref('1')}),template:`<div style="max-width:340px"><AppTabBar v-model="value" label="Connections"><AppTab v-for="n in 12" :key="n" :value="String(n)">Connection {{n}}</AppTab><template #panels><AppTabPanel v-for="n in 12" :key="n" :value="String(n)"><div class="panel">Connection {{n}}</div></AppTabPanel></template></AppTabBar></div>`})};
