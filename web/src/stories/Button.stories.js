import AppIcon from '../components/AppIcon.vue';
import AppButton from '../components/AppButton.vue';
export default {title:'Components/Button',component:AppButton,argTypes:{variant:{control:'select',options:['primary','secondary','outline','blanc']},label:{control:'text'}},render:args=>({components:{AppButton},setup:()=>({args}),template:'<AppButton v-bind="args">{{args.label}}</AppButton>'})};
export const Primary={args:{label:'Save changes',variant:'primary'}};
export const Secondary={args:{label:'Cancel',variant:'secondary'}};
export const Disabled={args:{label:'Saving…',disabled:true}};
export const LongLabel={args:{label:'Сохранить настройки выбранного подключения'}};

export const Outline={args:{label:'Sign out',variant:'outline'}};
export const Small={args:{label:'Save',size:'s'}};

export const Blanc={args:{label:'Cancel',variant:'blanc'}};
export const BlancDisabled={args:{label:'Cancel',variant:'blanc',disabled:true}};
export const BlancIcon={args:{variant:'blanc',iconOnly:true,'aria-label':'Open menu'},render:args=>({components:{AppButton,AppIcon},setup:()=>({args}),template:'<AppButton v-bind="args"><AppIcon name="menu" /></AppButton>'})};
