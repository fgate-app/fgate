import AppCheckbox from '../components/AppCheckbox.vue';

export default {
  title: 'Components/Checkbox',
  component: AppCheckbox,
  parameters: {
    docs: {
      description: {
        component: 'Флажок: скрытый нативный input + кастомный квадрат с галочкой. Поддерживает размеры m (44px/14px) и s (32px/12px), синхронизирован со Switch и Radio по токенам.',
      },
    },
  },
  args: { label: 'Включить уведомления', modelValue: false, size: 'm', disabled: false },
  argTypes: {
    size: { control: 'select', options: ['m', 's'] },
    modelValue: { control: 'boolean' },
  },
};

const render = args => ({
  components: { AppCheckbox },
  setup: () => ({ args }),
  template: '<AppCheckbox v-bind="args" />',
});

export const Unchecked = { args: { modelValue: false }, render };

export const Checked = { args: { modelValue: true }, render };

export const Small = { args: { size: 's' }, render };

export const SmallChecked = { args: { size: 's', modelValue: true }, render };

export const Disabled = { args: { disabled: true }, render };

export const DisabledChecked = { args: { disabled: true, modelValue: true }, render };