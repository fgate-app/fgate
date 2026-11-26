import AppTextarea from '../components/AppTextarea.vue';

export default {
  title: 'Components/Textarea',
  component: AppTextarea,
  parameters: {
    docs: {
      description: {
        component: 'Многострочное поле на тех же токенах и стилях, что AppInput: рамка, фон, hover и focus совпадают с инпутами.',
      },
    },
  },
};

const render = args => ({
  components: { AppTextarea },
  setup: () => ({ args }),
  template: '<AppTextarea v-bind="args" />',
});

export const Default = { args: { modelValue: 'ss://YWVzLTI1Ni1nY206cGFzc0BleGFtcGxlLmNvbTo4Mzg4', rows: 6 }, render };
export const Placeholder = { args: { modelValue: '', rows: 4, placeholder: 'ss://, socks5://, vless://, vpn:// или JSON' }, render };
export const Small = { args: { modelValue: 'socks5://127.0.0.1:1080', rows: 3, size: 's' }, render };
export const Disabled = { args: { modelValue: 'vless://uuid@example.com:443', rows: 4, disabled: true }, render };
