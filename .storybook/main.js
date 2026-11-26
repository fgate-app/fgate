import vue from '@vitejs/plugin-vue';
export default {
  stories: ['../web/src/stories/**/*.stories.js'],
  framework: '@storybook/vue3-vite',
  addons: ['@storybook/addon-a11y'],
  core: { disableTelemetry: true },
  async viteFinal(config) {
    // The application Vite root/proxy must not affect the component playground.
    config.root = process.cwd();
    config.plugins = [...(config.plugins || []), vue()];
    config.server = { ...config.server, proxy: undefined };
    return config;
  },
};
