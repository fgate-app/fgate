import AppAccordion from '../components/AppAccordion.vue';

export default {
  title: 'Components/Accordion',
  component: AppAccordion,
  parameters: {
    docs: {
      description: {
        component: 'Раскрывающийся дивайдер: тонкая линия с подписью по центру. Используется для «Дополнительных настроек».',
      },
    },
  },
};

const render = args => ({
  components: { AppAccordion },
  setup: () => ({ args }),
  template: `<AppAccordion v-bind="args"><p class="muted">Содержимое дополнительных настроек: порты, параметры пакетов, hostlist.</p></AppAccordion>`,
});

export const Closed = { args: { open: false, title: 'Дополнительные настройки' }, render };
export const Open = { args: { open: true, title: 'Дополнительные настройки' }, render };
