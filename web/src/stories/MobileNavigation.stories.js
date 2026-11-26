import {ref} from 'vue';
import MobileNavigation from '../components/MobileNavigation.vue';
import AppButton from '../components/AppButton.vue';
export default {title:'Navigation/Mobile drawer',component:MobileNavigation,parameters:{layout:'fullscreen'}};
export const Default={render:()=>({components:{MobileNavigation,AppButton},setup(){return {open:ref(true),page:ref('Обзор'),pages:['Обзор','Подключения','Клиенты','Маршруты','Настройки'],user:{username:'admin'}};},template:`<AppButton @click="open=true">Open menu</AppButton><MobileNavigation :open="open" :pages="pages" :page="page" :user="user" role-label="Administrator" can-system version="0.1.0" @close="open=false" @navigate="page=$event" />`})};
