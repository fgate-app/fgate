import ResolverTable from '../components/ResolverTable.vue';

const resolvers = [
  { id: 'cloudflare', name: 'Cloudflare 1.1.1.1', vendor: 'Cloudflare', country: 'US', filtering: 'none', protocols: { doh: 'https://cloudflare-dns.com/dns-query', dot: 'tls://1.1.1.1' } },
  { id: 'google', name: 'Google Public DNS', vendor: 'Google', country: 'US', filtering: 'none', protocols: { doh: 'https://dns.google/dns-query' } },
];

const entries = [
  { url: 'https://cloudflare-dns.com/dns-query', via: '' },
  { url: 'https://dns.google/dns-query', via: 'DIRECT' },
];
const statuses = {
  'https://cloudflare-dns.com/dns-query': { state: 'ok', ok: true, ms: 42, protocol: 'doh' },
  'https://dns.google/dns-query': { state: 'fail', ok: false, error: 'ETIMEDOUT' },
};

export default {
  title: 'Components/ResolverTable',
  component: ResolverTable,
  args: { entries, statuses, resolvers, label: 'Resolver pool' },
  render: args => ({ components: { ResolverTable }, setup: () => ({ args }), template: '<ResolverTable v-bind="args" />' }),
};

export const Default = {};
export const Empty = { args: { entries: [], statuses: {} } };
