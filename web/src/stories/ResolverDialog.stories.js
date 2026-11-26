import { ref } from 'vue';
import ResolverDialog from '../components/ResolverDialog.vue';

const resolvers = [
  { id: 'cloudflare', name: 'Cloudflare 1.1.1.1', vendor: 'Cloudflare', country: 'US', region: 'Глобальный', filtering: 'none', protocols: { doh: 'https://cloudflare-dns.com/dns-query', dot: 'tls://1.1.1.1' } },
  { id: 'google', name: 'Google Public DNS', vendor: 'Google', country: 'US', region: 'Глобальный', filtering: 'none', protocols: { doh: 'https://dns.google/dns-query' } },
  { id: 'quad9', name: 'Quad9', vendor: 'Quad9 Foundation', country: 'CH', region: 'Глобальный', filtering: 'malware', protocols: { doh: 'https://dns.quad9.net/dns-query' } },
];

export default {
  title: 'Components/ResolverDialog',
  component: ResolverDialog,
  args: { open: true, title: 'Add resolver', resolvers, existing: [] },
  render: args => ({
    components: { ResolverDialog },
    setup() {
      const open = ref(true);
      const added = ref('');
      return { args, open, added };
    },
    template: '<div><ResolverDialog v-bind="args" :open="open" @close="open=false" @add="added=$event.url" /><p>{{ added }}</p></div>',
  }),
};

export const Default = {};
