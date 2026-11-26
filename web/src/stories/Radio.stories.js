import { ref } from 'vue';
import AppRadio from '../components/AppRadio.vue';

export default {
  title: 'Components/Radio',
  component: AppRadio,
  parameters: {
    docs: {
      description: {
        component: 'Радиокнопка: скрытый нативный input + кастомный круг с точкой. Связывается через v-model/value (строка). Размеры m/s синхронизированы с Checkbox и Switch.',
      },
    },
  },
  args: { label: 'Первая опция', value: 'first', modelValue: 'first', size: 'm', disabled: false },
  argTypes: {
    size: { control: 'select', options: ['m', 's'] },
    modelValue: { control: 'text' },
    value: { control: 'text' },
  },
};

const render = args => ({
  components: { AppRadio },
  setup: () => ({ args }),
  template: '<AppRadio v-bind="args" />',
});

export const Selected = { args: {}, render };
export const Unselected = { args: { modelValue: 'other' }, render };
export const Small = { args: { size: 's' }, render };
export const Disabled = { args: { disabled: true }, render };
export const DisabledSelected = { args: { disabled: true, modelValue: 'first' }, render };

const groupTemplate = `<div style="display:grid;gap:8px;max-width:360px">
  <AppRadio v-for="option in options" :key="option.value" v-model="selected" :value="option.value" :label="option.label" :size="args.size" :disabled="args.disabled" />
</div>`;

const renderGroup = args => ({
  components: { AppRadio },
  setup: () => {
    const options = [
      { value: 'vless', label: 'VLESS / REALITY' },
      { value: 'ss', label: 'Shadowsocks' },
      { value: 'socks', label: 'SOCKS5' },
      { value: 'direct', label: 'Прямой выход' },
    ];
    const selected = ref('vless');
    return { args, options, selected };
  },
  template: groupTemplate,
});

export const Group = {
  args: {},
  render: renderGroup,
};

export const GroupSmall = {
  args: { size: 's' },
  render: renderGroup,
};