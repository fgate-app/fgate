import {ref} from 'vue';
import AppInput from '../components/AppInput.vue';
import AppTextarea from '../components/AppTextarea.vue';
export default {title:'Components/Field actions'};
export const CopyContents={render:()=>({components:{AppInput,AppTextarea},setup:()=>({text:ref('Copy this text'),multiline:ref('First line\nSecond line'),actions:ref(0)}),template:`<div class="form-section" style="max-width:480px">
 <label>Input m<AppInput v-model="text" copyable maxlength="100" /></label>
 <label>Input s<AppInput model-value="Small input" size="s" copyable readonly /></label>
 <label>Textarea m<AppTextarea v-model="multiline" copyable :rows="3" /></label>
 <label>Textarea s<AppTextarea model-value="Small textarea" size="s" copyable :rows="3" readonly /></label>
 <label>Disabled<AppInput model-value="Disabled" copyable disabled /></label>
 <label>Default<AppInput model-value="No action button" /></label>
 <label>Custom action<AppInput model-value="Custom" action-icon="edit" action-label="Custom action" @action="actions++" /></label>
 <output>{{actions}}</output>
 </div>`})};
