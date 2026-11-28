// No event details or user-controlled configuration are interpolated here.
const messages={
 en:{failed:'is unavailable.',restored:'is working again.',changed:'has changed its connection state.',switched:'switched its selected gateway.',updated:'update completed.',updateFailed:'update failed.',backupFailed:'configuration backup failed.',test:'Test notification. Telegram delivery is working.',next:'Open FreedomGate diagnostics and check this component.'},
 ru:{failed:'недоступен.',restored:'снова работает.',changed:'изменил состояние подключения.',switched:'переключил выбранный шлюз.',updated:'обновление завершено.',updateFailed:'ошибка обновления.',backupFailed:'не удалось создать резервную копию.',test:'Тестовое уведомление. Доставка в Telegram работает.',next:'Откройте диагностику FreedomGate и проверьте этот компонент.'},
 zh:{failed:'不可用。',restored:'已恢复工作。',changed:'连接状态已更改。',switched:'已切换所选网关。',updated:'更新已完成。',updateFailed:'更新失败。',backupFailed:'配置备份失败。',test:'测试通知。Telegram 消息发送正常。',next:'请打开 FreedomGate 诊断并检查此组件。'}
};
export function telegramMessage(config,event){const t=messages[config.language] || messages.en;return [config.systemName,new Date(event.at).toISOString(),event.component || 'FreedomGate',t[event.kind] || t.changed,...(['failed','updateFailed','backupFailed'].includes(event.kind)?[t.next]:[])].join('\n');}
