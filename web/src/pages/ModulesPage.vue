<script setup>
import AppDataCard from '../components/AppDataCard.vue';
import AppProgress from '../components/AppProgress.vue';
import AppTable from '../components/AppTable.vue';
import AppButton from '../components/AppButton.vue';
import AppDialog from '../components/AppDialog.vue';
import AppRowMenu from '../components/AppRowMenu.vue';
import {usePreferences} from '../preferences.js';
defineProps({management:{type:Object,required:true},can:Function,busy:Boolean,loading:Boolean});
const {t}=usePreferences();
</script>
<template>

          <p v-if="management.moduleServiceError" class="alert" role="status">{{t(management.moduleServiceError)}}</p>
          <AppDataCard :title="t('Модули и интеграции')" :count="management.moduleRows.length">
            <template #actions>
              <AppButton variant="secondary" size="s" data-testid="check-updates" :disabled="busy || management.moduleWorking || !can('users:write')" @click="management.checkUpdates">{{t('Проверить обновления')}}</AppButton>
            </template>
            <div class="table-wrap">
              <AppTable class="data-table modules-table" data-testid="module-list" :loading="loading">
                <colgroup><col class="module-name-column"/><col class="module-version-column"/><col/><col class="module-actions-column"/></colgroup>
                <thead>
                  <tr>
                    <th>{{t("Модуль")}}</th>
                    <th>{{t("Версия")}}</th>
                    <th>{{t("Статус")}}</th>
                    <th class="actions-col" :aria-label="t('Действия')"></th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="m in management.moduleRows" :key="m.id" data-testid="module-row" @click="management.onModuleRow(m,$event)">
                    <td>
                      <strong>{{m.name}}</strong>
                    </td>
                    <td data-testid="module-version"><span>{{m.version}}</span><span v-if="management.moduleVersionNote(m)" class="module-version-note muted" data-testid="module-version-note">{{management.moduleVersionNote(m)}}</span><AppProgress v-if="management.moduleProgress(m)>=0" class="module-update-progress" data-testid="module-update-progress" :value="management.moduleProgress(m)" :max="4" :label="management.moduleVersionNote(m)" /><span v-if="management.moduleVersionError(m)" class="module-version-note muted" data-testid="module-update-error">{{t(management.moduleVersionError(m))}}</span></td>
                    <td data-testid="module-status">{{management.moduleStatus(m)}}</td>
                    <td class="actions-cell">
                      <AppRowMenu v-if="management.moduleActions(m).length" :actions="management.moduleActions(m)" :label="t('Действия')" :disabled="busy" @select="management.onModuleAction(m,$event)" />
                    </td>
                  </tr>
                </tbody>
              </AppTable>
            </div>
          </AppDataCard>
        <AppDialog :open="!!management.moduleUpdateDialog" :title="t(management.moduleUpdateDialog?.id==='system'?'Update FreedomGate':'Обновить модуль')" @close="management.moduleUpdateDialog=null">
          <div v-if="management.moduleUpdateDialog" class="form-section">
            <p>{{management.moduleUpdateDialog.name}}: {{management.moduleUpdateDialog.version}} → {{management.moduleUpdateDialog.id==='system'?management.updateFor('system')?.candidate?.version?.slice(0,7):management.updateFor(management.moduleUpdateDialog.id)?.candidate?.version}}</p>
            <p v-if="management.moduleUpdateDialog.id!=='diagnostic-blocklist'" class="muted">{{t('Во время обновления соединения могут кратковременно прерваться. При ошибке запуска будет восстановлена предыдущая версия.')}}</p>
          </div>
          <template #footer><AppButton variant="secondary" @click="management.moduleUpdateDialog=null">{{t('Отмена')}}</AppButton><AppButton :disabled="management.moduleWorking" data-testid="install-module" @click="management.installModule">{{t('Обновить')}}</AppButton></template>
        </AppDialog>
</template>
<style scoped>
@media(min-width:901px){:global(html:has(.modules-table)){scrollbar-gutter:stable}}
.modules-table{table-layout:fixed;width:100%}
.module-name-column{width:26%}
.module-version-column{width:44%}
.module-actions-column{width:calc(var(--space-8)*2)}
.modules-table th,.modules-table td{overflow-wrap:anywhere;white-space:normal}
@media(max-width:900px){.modules-table{table-layout:auto}.modules-table colgroup{display:none}}

.module-version-note{display:block;margin:0;font-size:inherit;font-weight:400}
.module-update-progress{margin-block:var(--space-2);max-width:100%}
</style>
