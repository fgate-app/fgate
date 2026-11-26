import BrandLogo from '../components/BrandLogo.vue';
export default {title:'Brand/FreedomGate',component:BrandLogo};
export const Logo={args:{decorative:false}};
export const Sizes={render:()=>({components:{BrandLogo},template:'<div style="display:flex;gap:32px;align-items:center"><BrandLogo style="width:20px;height:28px"/><BrandLogo/><BrandLogo style="width:80px;height:108px"/><BrandLogo style="width:160px;height:216px"/></div>'})};
export const Wordmark={render:()=>({components:{BrandLogo},template:'<div class="brand"><BrandLogo/><span>FreedomGate<small>NETWORK CONTROL</small></span></div>'})};
