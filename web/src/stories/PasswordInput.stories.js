import {ref} from 'vue';
import AppPasswordInput from '../components/AppPasswordInput.vue';
export default {
  title: 'Components/Password input',
  component: AppPasswordInput,
  args: {size: 'm', disabled: false},
  argTypes: {size: {control: 'select', options: ['m','s']}},
  render: args => ({components: {AppPasswordInput}, setup: () => ({args, password: ref('example password')}), template: '<label>Password<AppPasswordInput v-model="password" v-bind="args" autocomplete="new-password" /></label>'})
};
export const Medium = {};
export const Small = {args: {size: 's'}};
export const Disabled = {args: {disabled: true}};
