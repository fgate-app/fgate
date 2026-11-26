import AppProgress from '../components/AppProgress.vue';
export default {title:'Components/Progress',component:AppProgress,args:{value:50,max:100,label:'Progress'},argTypes:{value:{control:{type:'number'}},max:{control:{type:'number'}}},render:args=>({components:{AppProgress},setup:()=>({args}),template:'<div style="width:100%;max-width:600px"><AppProgress v-bind="args" /></div>'})};
export const Empty={args:{value:0}};
export const Half={args:{value:50}};
export const Complete={args:{value:100}};
export const Steps={args:{value:3,max:8,label:'Diagnostic progress'}};
export const Overflow={args:{value:150}};
export const Negative={args:{value:-10}};
export const EmptySteps={args:{value:0,max:0}};
