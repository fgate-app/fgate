import UserMenu from '../components/UserMenu.vue';
export default {title:'Components/User menu',component:UserMenu,args:{user:{username:'administrator',role:'admin'},roleLabel:'Administrator'},decorators:[()=>({template:'<div style="width:240px;padding-top:360px"><story /></div>'})]};
export const Default={};
export const LongUsername={args:{user:{username:'administrator.with.a.long.username',role:'admin'}}};

export const Compact={args:{compact:true}};
