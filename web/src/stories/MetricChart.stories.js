import MetricChart from '../components/MetricChart.vue';
export default {title:'Components/CPU chart (synthetic fixtures)',component:MetricChart};
export const History={args:{label:'Example CPU history (synthetic)',samples:Array.from({length:60},(_,i)=>({value:40+25*Math.sin(i/5)}))}};
export const Empty={args:{label:'No samples',samples:[]}};
export const Gaps={args:{label:'Missing samples',samples:Array.from({length:60},(_,i)=>({value:i>20&&i<30?null:30+i/2}))}};
