import {ref} from 'vue';
import AppSelect from '../components/AppSelect.vue';
import AppRowMenu from '../components/AppRowMenu.vue';
import AppCount from '../components/AppCount.vue';
const options=[{value:'one',label:'First item'},{value:'two',label:'Second item'},{value:'disabled',label:'Unavailable',disabled:true}];
export default {title:'Components/Popup lists'};
export const SharedAppearance={render:()=>({components:{AppSelect,AppRowMenu,AppCount},setup:()=>({value:ref('one'),options,actions:[...options,{value:'remove',label:'Remove',danger:true}]}),template:'<div class="form-section" style="max-width:360px"><label>Select m<AppSelect v-model="value" :options="options" label="Select m" /></label><label>Select s<AppSelect v-model="value" :options="options" size="s" label="Select s" /></label><div>Context menu <AppRowMenu :actions="actions" label="Context menu" /></div><AppCount :value="3" /></div>'})};
