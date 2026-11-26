import {computed,ref} from 'vue';
import ModulesPage from '../pages/ModulesPage.vue';
import AppButton from '../components/AppButton.vue';
export default {title:'Settings/Modules table',component:ModulesPage,parameters:{layout:'padded'}};
export const StableColumns={render:()=>({components:{ModulesPage,AppButton},setup(){
 const expanded=ref(false),noop=()=>{},can=()=>true;
 const management=computed(()=>({moduleRows:[
  {id:'mihomo',name:'mihomo',version:expanded.value?'v1.99.0-preview-build-20261126-abcdefghijklmnopqrstuvwxyz0123456789':'v1.19.34',status:expanded.value?'Downloading and verifying the new module version':'Running',note:expanded.value?'Downloading v1.99.0-preview and checking its integrity':null,progress:expanded.value?2:-1},
  {id:'xray',name:'xray',version:'v26.11.19',status:expanded.value?'Waiting for the previous working version to be restored':'Running',error:expanded.value?'Could not download https://example.invalid/releases/'+('long-path-'.repeat(20))+'/module.tar.gz':null},
  {id:'outline',name:'Shadowsocks Outline SDK',version:'v0.1.0',status:'Running'}],moduleServiceError:null,moduleWorking:false,moduleUpdateDialog:null,
  moduleStatus:row=>row.status,moduleVersionNote:row=>row.note,moduleVersionError:row=>row.error,moduleProgress:row=>row.progress ?? -1,moduleActions:()=>[{value:'check',label:'Check for updates'}],onModuleAction:noop,onModuleRow:noop,checkUpdates:noop,updateFor:()=>null,installModule:noop}));
 return {expanded,management,can};
},template:'<div style="display:grid;gap:var(--space-6);max-width:1200px"><AppButton variant="secondary" size="s" data-testid="change-module-content" @click="expanded=!expanded">Change content</AppButton><ModulesPage :management="management" :can="can" /></div>'})};
