import StatCard from '../components/StatCard.vue';
export default {title:'Components/Stat card',component:StatCard};
const grid={decorators:[()=>({template:'<div class="stats"><story /></div>'})]};
export const Count={...grid,args:{label:'Connections',value:12,description:'Available profiles'}};
export const Offline={...grid,args:{label:'VPN tunnel',value:'Not running',description:'Engines are not integrated'}};
export const LongContent={...grid,args:{label:'При отказе всех доступных туннелей',value:'Прямое подключение',description:'Уведомление будет отправлено после восстановления доступа'}};

// No .stats wrapper: the card owns its visual treatment.
export const Standalone={args:{label:'Connections',value:12,description:'Standalone card'},decorators:[()=>({template:'<div style="max-width:360px"><story /></div>'})]};
