import AppCount from '../components/AppCount.vue';

export default {
  title: 'Components/Count',
  component: AppCount,
  render: args => ({ components: { AppCount }, setup: () => ({ args }), template: '<AppCount v-bind="args" />' }),
};

export const Default = { args: { value: 3 } };
export const TwoDigits = { args: { value: 42 } };
export const Large = { args: { value: 120 } };
export const CustomLabel = { args: { value: 7, label: '7 элементов' } };
