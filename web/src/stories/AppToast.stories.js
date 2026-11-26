import { onUnmounted, ref } from 'vue';
import AppDialog from '../components/AppDialog.vue';
import AppToast from '../components/AppToast.vue';
import AppButton from '../components/AppButton.vue';
import { clearToasts, notify, updateToast } from '../lib/toasts.js';

export default {
  title: 'Components/Micro notifications',
  component: AppToast,
  parameters: {
    docs: {
      description: {
        component: 'Микронотификации сверху экрана. Рендерятся в top layer, поэтому видны поверх модальных окон. Закрываются крестиком или автоматически.',
      },
    },
  },
};

const Interactive = {
  components: { AppToast, AppButton },
  setup() {
    clearToasts();
    onUnmounted(clearToasts);
    return {
      error: () => notify("Strategy testing is unavailable on this host.", 'error'),
      success: () => notify('Стратегия определена: подмена контрольной суммы.', 'success'),
      info: () => notify('Проверка завершена.', 'info'),
    };
  },
  template: `<div style="display:grid;gap:12px;max-width:420px"><div class="controls-row"><AppButton @click="error">Ошибка</AppButton><AppButton variant="secondary" @click="success">Успех</AppButton><AppButton variant="secondary" @click="info">Инфо</AppButton></div><AppToast/></div>`,
};

export const InteractiveExample = { name: 'Interactive', render: () => Interactive };

export const Error = {
  render: () => ({
    components: { AppToast },
    setup() {
      clearToasts();
      notify("Strategy testing is unavailable on this host.", 'error', 0);
      return {};
    },
    template: '<AppToast/>',
  }),
};

export const Success = {
  render: () => ({
    components: { AppToast },
    setup() {
      clearToasts();
      notify('Стратегия определена: подмена контрольной суммы.', 'success', 0);
      return {};
    },
    template: '<AppToast/>',
  }),
};

export const Stacked = {
  render: () => ({
    components: { AppToast },
    setup() {
      clearToasts();
      notify('Проверка завершена.', 'info', 0);
      notify('Стратегия определена: подбор TTL.', 'success', 0);
      notify("Strategy testing is unavailable on this host.", 'error', 0);
      return {};
    },
    template: '<AppToast/>',
  }),
};

export const Countdown={
 render:()=>({components:{AppToast,AppButton},setup(){
  clearToasts();let id,timer;
  onUnmounted(()=>{clearTimeout(timer);clearToasts();});
  function queue(){clearTimeout(timer);if(!id)id=notify("Changes will apply in",'info',0);updateToast(id,{message:"Changes will apply in",type:'info',deadline:Date.now()+5000});timer=setTimeout(()=>updateToast(id,{message:"Changes applied.",type:'success',deadline:null}),5000);}
  return {queue};
 },template:'<AppButton @click="queue">Изменить настройку</AppButton><AppToast />'})
};

export const LayoutRegression={render:()=>({components:{AppToast,AppButton,AppDialog},setup(){const open=ref(false);clearToasts();onUnmounted(clearToasts);return {open,short:()=>notify('Changes saved.','success',0),long:()=>notify('The operation could not be completed. Check the connection and try again. '.repeat(5),'error',0),clear:clearToasts};},template:`<div class="form-section"><AppButton @click="short">Short notification</AppButton><AppButton @click="long">Long notification</AppButton><AppButton @click="open=true">Open modal</AppButton><AppButton @click="clear">Clear notifications</AppButton><AppDialog :open="open" title="Toast test" @close="open=false"><AppButton @click="short">Notify inside modal</AppButton></AppDialog><AppToast /></div>`})};
