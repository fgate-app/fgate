import { ref } from 'vue';
import AppTagInput from '../components/AppTagInput.vue';

export default {
  title: 'Components/Tag input',
  component: AppTagInput,
  parameters: {
    docs: {
      description: {
        component: 'Поле ввода, в котором значения разделённые заданным знаком (запятая, точка с запятой, Enter) разбиваются на теги. Теги можно удалять крестиком или Backspace. Вставка со знаками-разделителями дробит текст на теги.',
      },
    },
  },
  args: { modelValue: [], separator: ',', placeholder: 'Домен или IP…', size: 'm', disabled: false },
  argTypes: {
    size: { control: 'select', options: ['m', 's'] },
    separator: { control: 'select', options: [',', ';', ' '] },
  },
};

const render = args => ({
  components: { AppTagInput },
  setup: () => {
    const tags = ref([...args.modelValue]);
    return { args: { ...args, modelValue: tags.value }, tags, onUpdate: val => { tags.value = val; args.modelValue = val; } };
  },
  template: '<div style="max-width:500px"><label>Домены и IP-адреса<AppTagInput v-bind="args" v-model="tags" /></label></div>',
});

export const Empty = { args: {}, render };

export const WithTags = {
  args: { modelValue: ['youtube.com', 'rutracker.org', '142.250.0.0/16'] },
  render,
};

export const SmallEmpty = { args: { size: 's' }, render };

export const SmallWithTags = {
  args: { size: 's', modelValue: ['instagram.com', 'youtu.be'] },
  render,
};

export const Semicolons = {
  args: { separator: ';', modelValue: ['youtube.com', 'discord.com'] },
  render,
};

export const Disabled = {
  args: { disabled: true, modelValue: ['youtube.com', 'ifconfig.me'] },
  render,
};
export const BoundPreset = {args:{modelValue:['preset:youtube','youtube.com'],separator:'',tagMeta:[{value:'preset:youtube',label:'YouTube',tone:'preset'},{value:'youtube.com',tone:'user'}]},render};

export const Sizes = {render:()=>({components:{AppTagInput},setup(){return {rows:[{id:'empty',tags:[]},{id:'tags',tags:['example.com']},{id:'options',tags:['one'],options:[{value:'one',label:'One'},{value:'two',label:'Two'}]},{id:'suffix',tags:['example.com'],suffix:true}]};},template:`<div style="display:grid;gap:var(--space-6)"><template v-for="size in ['s','m']" :key="size"><AppTagInput v-for="row in rows" :key="size+row.id" :size="size" :model-value="row.tags" :options="row.options" :label="size+' '+row.id" :data-testid="size+'-'+row.id" placeholder="Add a value"><template v-if="row.suffix" #suffix><span>1 / 8</span></template></AppTagInput></template></div>`})};
