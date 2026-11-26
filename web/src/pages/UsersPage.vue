<script setup>
import AppDataCard from '../components/AppDataCard.vue';
import AppTable from '../components/AppTable.vue';
import AppButton from '../components/AppButton.vue';
import AppIcon from '../components/AppIcon.vue';
import AppSelect from '../components/AppSelect.vue';
import AppRowMenu from '../components/AppRowMenu.vue';
import {usePreferences} from '../preferences.js';
defineProps({users:Array,currentUser:Object,roleNames:Object,actions:Function,can:Function,loading:Boolean,busy:Boolean});
defineEmits(['add','row','action','update-role']);
const {t}=usePreferences();
</script>
<template>

          <AppDataCard :title="t('Пользователи системы')" :count="users.length">
            <template #actions>
              <AppButton v-if="can('users:write')" variant="secondary" size="m" icon-only data-testid="add-user" :aria-label="t('Добавить пользователя')" :title="t('Добавить пользователя')" :disabled="busy" @click="$emit('add')">
                <AppIcon name="plus" />
              </AppButton>
            </template>
            <div v-if="!loading && !users.length" class="empty">{{t('Пользователей пока нет')}}</div>
            <div v-else class="table-wrap">
              <AppTable class="data-table" data-testid="user-list" :loading="loading">
                <thead>
                  <tr>
                    <th>{{t("Пользователь")}}</th>
                    <th>{{t("Роль")}}</th>
                    <th class="actions-col" :aria-label="t('Действия')"></th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="u in users" :key="u.id" data-testid="user-row" @click="$emit('row',u,$event)">
                    <td>
                      <strong>{{u.username}}</strong>
                      <small v-if="u.id===currentUser.id">{{t('вы')}}</small>
                    </td>
                    <td>
                      <AppSelect :label="t('Роль')+' '+u.username" :model-value="u.role" :disabled="busy || !can('users:write')" :options="Object.entries(roleNames).map(([value,label])=>({value,label:t(label)}))" @update:model-value="$emit('update-role',u,$event)" />
                    </td>
                    <td class="actions-cell">
                      <AppRowMenu :actions="actions(u)" :label="t('Действия')" :disabled="busy" @select="$emit('action',u,$event)" />
                    </td>
                  </tr>
                </tbody>
              </AppTable>
            </div>
          </AppDataCard>
</template>
