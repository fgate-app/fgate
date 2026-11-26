import DashboardChart from '../components/DashboardChart.vue';
export default {title:'Components/Dashboard charts (synthetic fixtures)',component:DashboardChart};
const samples=Array.from({length:61},(_,index)=>({time:Date.now()-(60-index)*5000,download:1000000+Math.sin(index/4)*700000,upload:200000+Math.cos(index/5)*100000,cpu:25+Math.sin(index/6)*20,memory:38+index/8}));
export const Traffic={args:{label:'Traffic',samples,series:[{key:'download',label:'Download',color:'primary'},{key:'upload',label:'Upload',color:'secondary'}]}};
export const CPU={args:{label:'CPU',samples,series:[{key:'cpu',color:'primary'}],percent:true}};
export const Memory={args:{label:'Memory',samples,series:[{key:'memory',color:'primary'}],percent:true}};
