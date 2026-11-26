import { ref } from 'vue';
import ResolverPicker from '../components/ResolverPicker.vue';

const resolvers = [
  { id: 'cloudflare', name: 'Cloudflare 1.1.1.1', vendor: 'Cloudflare', country: 'US', region: 'Глобальный', filtering: 'none', ips: ['1.1.1.1'], protocols: { doh: 'https://cloudflare-dns.com/dns-query' } },
  { id: 'google', name: 'Google Public DNS', vendor: 'Google', country: 'US', region: 'Глобальный', filtering: 'none', ips: ['8.8.8.8'], protocols: { doh: 'https://dns.google/dns-query' } },
  { id: 'quad9', name: 'Quad9', vendor: 'Quad9 Foundation', country: 'CH', region: 'Глобальный', filtering: 'malware', ips: ['9.9.9.9'], protocols: { doh: 'https://dns.quad9.net/dns-query' } },
  { id: 'adguard', name: 'AdGuard DNS', vendor: 'AdGuard', country: 'CY', region: 'Глобальный', filtering: 'ads+trackers', ips: ['94.140.14.14'], protocols: { doh: 'https://dns.adguard-dns.com/dns-query' } },
];

export default {
  title: 'Components/ResolverPicker',
  component: ResolverPicker,
  args: { resolvers },
  render: args => ({
    components: { ResolverPicker },
    setup() {
      const picked = ref('');
      return { args, picked };
    },
    template: '<div style="max-width:520px"><ResolverPicker v-bind="args" @select="picked=$event.name" @custom="picked=$event" /><p>{{picked}}</p></div>',
  }),
};

export const Default = {};
export const EmptyDictionary = { args: { resolvers: [] } };
