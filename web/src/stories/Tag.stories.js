import AppTag from '../components/AppTag.vue';

export default {
  title: 'Components/Tag',
  component: AppTag,
  parameters: {
    docs: {
      description: {
        component: 'Тег-пилюля: текст + опциональная кнопка удаления (крестик). Размеры m (13px/28px) и s (12px/22px).',
      },
    },
  },
  args: { label: 'youtube.com', size: 'm', removable: false, disabled: false },
  argTypes: {
    size: { control: 'select', options: ['m', 's'] },
    removable: { control: 'boolean' },
    tone:{control:'select',options:['neutral','preset','user']},
  },
};

const render = args => ({
  components: { AppTag },
  setup: () => ({ args }),
  template: '<AppTag v-bind="args" />',
});

export const Default = { args: {}, render };

export const Removable = { args: { removable: true }, render };

export const Small = { args: { size: 's' }, render };

export const SmallRemovable = { args: { size: 's', removable: true }, render };

export const Disabled = { args: { removable: true, disabled: true }, render };

const tags = ['youtube.com', 'rutracker.org', 'instagram.com'];
const renderGroup = args => ({
  components: { AppTag },
  setup: () => ({ args, tags }),
  template: '<div style="display:flex;flex-wrap:wrap;gap:8px;max-width:500px"><AppTag v-for="tag in tags" :key="tag" :label="tag" v-bind="args" /></div>',
});

export const Group = { args: { removable: true }, render: renderGroup };
export const GroupSmall = { args: { removable: true, size: 's' }, render: renderGroup };
export const Preset = {args:{label:'YouTube',tone:'preset',removable:true},render};
export const UserRule = {args:{label:'youtube.com',tone:'user',removable:true},render};
