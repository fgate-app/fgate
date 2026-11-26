import ResolverStatus from '../components/ResolverStatus.vue';

export default {
  title: 'Components/ResolverStatus',
  component: ResolverStatus,
  render: args => ({ components: { ResolverStatus }, setup: () => ({ args }), template: '<ResolverStatus v-bind="args" />' }),
};

export const Available = { args: { status: { state: 'ok', ok: true, ms: 42, protocol: 'doh' } } };
export const Unavailable = { args: { status: { state: 'fail', ok: false, error: 'ETIMEDOUT' } } };
export const Unsupported = { args: { status: { state: 'unsupported', error: "DoQ cannot be checked without a QUIC client" } } };
export const Unknown = { args: { status: undefined } };
