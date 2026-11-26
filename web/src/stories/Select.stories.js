import {ref} from 'vue';
import AppSelect from '../components/AppSelect.vue';
const options=[{value:'vless',label:'VLESS'},{value:'ss',label:'Shadowsocks'},{value:'sstp',label:'SSTP'},{value:'wireguard',label:'WireGuard'},{value:'openvpn',label:'OpenVPN'}];
export default {title:'Components/Select',component:AppSelect,args:{label:'Protocol',modelValue:'vless',options},render:args=>({components:{AppSelect},setup(){return {args,value:ref(args.modelValue)};},template:'<div style="max-width:360px"><label>{{args.label}}<AppSelect v-bind="args" v-model="value"/></label></div>'})};
export const Default={};
export const Disabled={args:{disabled:true}};
export const Empty={args:{options:[],modelValue:'',placeholder:'Select a protocol'}};
export const LongList={args:{options:Array.from({length:100},(_,i)=>({value:String(i),label:'Connection '+(i+1)})),modelValue:'0'}};
