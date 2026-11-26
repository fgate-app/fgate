import AppInfoBlock from '../components/AppInfoBlock.vue';
export default {title:'Components/Info block',component:AppInfoBlock,argTypes:{variant:{control:'select',options:['info','warning','danger']}}};
const render=args=>({components:{AppInfoBlock},setup:()=>({args}),template:'<AppInfoBlock v-bind="args">Use an existing Debian or Ubuntu VPS with root SSH access or passwordless sudo.</AppInfoBlock>'});
export const Information={args:{variant:'info'},render};
export const Warning={args:{variant:'warning'},render};
export const SpecialAttention={args:{variant:'danger'},render};
