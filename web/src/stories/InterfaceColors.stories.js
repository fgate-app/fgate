import {ref} from 'vue';
import AppButton from '../components/AppButton.vue';
import AppInput from '../components/AppInput.vue';
const groups={
 Surfaces:['page','surface','secondary','secondary-hover','secondary-active','accent-soft','accent-selected'],
 Text:['text-muted','text-secondary','text-label','text-table','text-primary','text-strong'],
 Borders:['border-subtle','border','border-accent'],
 Accents:['primary','accent','accent-strong','on-primary','on-accent'],
 Status:['danger','success','warning-surface','warning-border','warning-text','warning-muted','warning-indicator','inverse-danger','inverse-success']
};
export default {title:'Foundations/Interface colors',parameters:{layout:'padded'}};
export const CompareThemes={render:()=>({components:{AppButton,AppInput},setup:()=>({groups,themes:['light','dark'],value:ref('FreedomGate')}),template:`<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,400px),1fr));gap:var(--space-6)"><section v-for="mode in themes" :key="mode" :data-ui-theme="mode" :style="{background:'var(--color-page)',color:'var(--color-text-primary)',padding:'var(--space-6)',borderRadius:'var(--radius-panel)'}"><h3>{{mode}}</h3><section v-for="(roles,title) in groups" :key="title" class="form-section" style="margin-bottom:var(--space-6)"><h4 style="margin:0">{{title}}</h4><div v-for="role in roles" :key="role" style="display:flex;align-items:center;gap:var(--space-3)"><span :data-color-token="'--color-'+role" :style="{display:'block',flexShrink:0,width:'var(--space-8)',height:'var(--space-8)',borderRadius:'var(--radius-control)',background:'var(--color-'+role+')',border:'1px solid var(--color-border)'}"></span><code style="font-size:var(--font-size-caption)">--color-{{role}}</code></div></section><div class="form-section"><label>Input<AppInput v-model="value" size="m" /></label><AppButton>Primary action</AppButton><AppButton variant="secondary">Secondary action</AppButton></div></section></div>`})};
