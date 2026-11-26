import {computed} from 'vue';
import {usePreferences} from '../preferences.js';
import {architectureCreateActions} from '../lib/entity-actions.js';
import NetworkArchitectureCard from '../components/NetworkArchitectureCard.vue';
import OverviewDashboard from '../components/OverviewDashboard.vue';
import {networkArchitectureDemo} from '../fixtures/network-architecture.js';
import {currentNetworkArchitecture,currentNetworkSnapshot,prototypeNetworkArchitecture} from '../fixtures/network-architecture-current.js';
export default {
 title:'Overview/Network architecture',component:NetworkArchitectureCard,
 render:args=>({components:{NetworkArchitectureCard},setup(){const {t}=usePreferences();return {args,createActions:computed(()=>architectureCreateActions({t,can:()=>true}))};},template:'<NetworkArchitectureCard v-bind="args" :create-actions="createActions" />'}),
 parameters:{layout:'fullscreen'},
 decorators:[()=>({template:'<div style="padding:var(--space-6);max-width:1760px;margin:auto"><story/></div>'})],
};
export const Loading={args:{graph:{nodes:[],edges:[],loading:true,width:1284,height:810}}};
export const CurrentMap={args:{graph:currentNetworkArchitecture()}};
export const NoConnectedClients={args:{graph:currentNetworkArchitectureWithoutClients()}};
function currentNetworkArchitectureWithoutClients(){const data=currentNetworkSnapshot();data.clients.forEach(client=>client.online=false);return prototypeNetworkArchitecture(data);}
export const CurrentMapMobile={...CurrentMap,globals:{viewport:{value:'mobile1',isRotated:false}}};
export const Incident={args:{graph:networkArchitectureDemo()}};
export const Healthy={args:{graph:networkArchitectureDemo('healthy')}};
export const Mobile={...Incident,globals:{viewport:{value:'mobile1',isRotated:false}}};
export const InOverview={render:()=>({
 components:{NetworkArchitectureCard,OverviewDashboard},
 setup(){const snapshot=currentNetworkSnapshot();return {graph:currentNetworkArchitecture(),metrics:{traffic:{uploadRate:1800000,downloadRate:33200000,uploadTotal:1280000000,downloadTotal:24200000000,connections:142},counts:{gateways:snapshot.profiles.length,devices:snapshot.clients.filter(client=>!client.remote&&client.online===true).length,accessPoints:new Set(snapshot.clients.map(client=>client.accessPointId).filter(Boolean)).size}},samples:Array.from({length:40},(_,i)=>({time:Date.now()-(39-i)*5000,download:23000000+Math.sin(i*.3)*8000000,upload:1500000+Math.sin(i*.4)*500000,cpu:12+Math.sin(i*.2)*5,memory:36+Math.sin(i*.1)*2}))};},
 template:'<OverviewDashboard :architecture-graph="graph" :metrics="metrics" :samples="samples"/>',
})};
