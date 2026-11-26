import ProtocolIcon from '../components/ProtocolIcon.vue';
import { protocols } from '../lib/protocols.js';
export default {title:'Components/Protocol logos',component:ProtocolIcon,argTypes:{protocol:{control:'select',options:protocols.map(p=>p.id)},size:{control:{type:'range',min:16,max:96,step:4}},monochrome:{control:'boolean'}}};
export const Default={args:{protocol:'wireguard',size:32}};
export const Monochrome={args:{protocol:'openvpn',size:32,monochrome:true}};
export const Unknown={args:{protocol:'unrecognized-protocol',size:32}};
export const Gallery={render:()=>({components:{ProtocolIcon},setup:()=>({protocols}),template:`<div class="protocol-gallery"><div v-for="p in protocols" :key="p.id" class="panel"><div class="protocol-sizes"><ProtocolIcon v-for="size in [16,24,40]" :key="size" :protocol="p.id" :size="size" /></div><strong>{{p.label}}</strong><small class="muted">{{p.source}}</small></div></div>`})};
export const InConnectionList={render:()=>({components:{ProtocolIcon},setup:()=>({protocols:protocols.slice(0,8)}),template:`<section class="panel" style="max-width:600px"><div class="row" v-for="p in protocols" :key="p.id"><div class="protocol-label"><ProtocolIcon :protocol="p.id" decorative /><strong>{{p.label}}</strong></div><span class="badge">Draft</span></div></section>`})};
