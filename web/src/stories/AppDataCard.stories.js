import AppTable from '../components/AppTable.vue';
import AppDataCard from '../components/AppDataCard.vue';
import AppButton from '../components/AppButton.vue';
import AppInput from '../components/AppInput.vue';

export default {
  title: 'Components/Data card',
  component: AppDataCard,
  parameters: {
    docs: {
      description: {
        component: 'Карточка для таблицы: шапка с названием, действиями и фильтром, ниже таблица без отступов до краёв — линии разделителей строк идут от края до края.',
      },
    },
  },
};

const rows = [
  { name: 'Cloudflare', address: '1.1.1.1', protocol: 'DoH' },
  { name: 'Google', address: '8.8.8.8', protocol: 'DoT' },
  { name: 'Quad9', address: '9.9.9.9', protocol: 'UDP' },
];

const render = args => ({
  components: { AppTable, AppDataCard, AppButton, AppInput },
  setup: () => ({ args, rows }),
  template: `
    <AppDataCard v-bind="args">
      <template #actions>
        <AppButton size="s" variant="secondary">Добавить</AppButton>
      </template>
      <template #filters>
        <AppInput placeholder="Фильтр по имени или адресу" />
      </template>
      <div class="table-wrap">
        <AppTable class="data-table">
          <thead><tr><th>Резолвер</th><th>Адрес</th><th>Протокол</th></tr></thead>
          <tbody>
            <tr v-for="row in rows" :key="row.address">
              <td><strong>{{ row.name }}</strong></td>
              <td><code>{{ row.address }}</code></td>
              <td>{{ row.protocol }}</td>
            </tr>
          </tbody>
        </AppTable>
      </div>
    </AppDataCard>
  `,
});

export const Default = { args: { title: 'Пул резолверов', count: 3 }, render };
export const WithoutFilters = {
  args: { title: 'Пул резолверов', count: 3 },
  render: args => ({
    components: { AppTable, AppDataCard, AppButton, AppInput },
    setup: () => ({ args, rows }),
    template: `
      <AppDataCard v-bind="args">
        <template #actions><AppButton size="s" variant="secondary">Добавить</AppButton></template>
        <div class="table-wrap">
          <AppTable class="data-table">
            <thead><tr><th>Резолвер</th><th>Адрес</th><th>Протокол</th></tr></thead>
            <tbody>
              <tr v-for="row in rows" :key="row.address">
                <td><strong>{{ row.name }}</strong></td>
                <td><code>{{ row.address }}</code></td>
                <td>{{ row.protocol }}</td>
              </tr>
            </tbody>
          </AppTable>
        </div>
      </AppDataCard>
    `,
  }),
};

export const Mobile = { ...Default, globals:{viewport:{value:'mobile1',isRotated:false}}, parameters: { layout: 'fullscreen' } };

export const Loading = {
  render: () => ({
    components: {AppDataCard,AppTable},
    template: `<AppDataCard title="Resolvers"><AppTable loading class="data-table"><thead><tr><th>Name</th><th>Address</th><th>Protocol</th><th class="actions-col"></th></tr></thead><tbody /></AppTable></AppDataCard>`,
  }),
};
