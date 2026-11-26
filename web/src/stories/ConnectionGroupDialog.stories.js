import {ref} from 'vue';
import ConnectionGroupDialog from '../components/ConnectionGroupDialog.vue';
import AppButton from '../components/AppButton.vue';
export default {title:'Components/Connection group dialog',component:ConnectionGroupDialog};
export const Edit={render:()=>({components:{ConnectionGroupDialog,AppButton},setup(){const open=ref(false),saved=ref(null);return {open,saved,group:{name:'Automatic',members:['direct']},profiles:[{id:'direct',name:'Напрямую',builtin:true},{id:'dpi',name:'DPI bypass'},{id:'proxy',name:'Proxy Amsterdam'}],save:value=>{saved.value=value;open.value=false;}};},template:`<AppButton @click="open=true">Edit group</AppButton><ConnectionGroupDialog :open="open" :group="group" :profiles="profiles" @close="open=false" @save="save" /><output data-testid="saved-group">{{JSON.stringify(saved)}}</output>`})};
