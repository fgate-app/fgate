import MaterialIconCatalog from './MaterialIconCatalog.vue';
import AppIcon from '../components/AppIcon.vue';
export default {title:'Components/Material icons',component:AppIcon,argTypes:{name:{control:'select',options:['shield','overview','connections','routes','network','settings','modules','users','account','warning','arrow','external','selected','unselected']}}};
export const Default={args:{name:'shield'}};
export const Gallery={render:()=>({components:{AppIcon},setup:()=>({names:['shield','overview','connections','routes','network','settings','modules','users','account','warning','arrow','external','selected','unselected']}),template:'<div class="icon-gallery"><div v-for="name in names" :key="name"><AppIcon :name="name" /><span>{{name}}</span></div></div>'})};

export const AllIcons={render:()=>({components:{MaterialIconCatalog},template:'<MaterialIconCatalog />'}),parameters:{controls:{disable:true}}};
