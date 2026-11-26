<script setup>
import {connectionGroupContains} from '../../../shared/connection-groups.js';
import {useFormFeedback} from '../composables/useFormFeedback.js';
import {computed, ref, watch} from 'vue';
import AppDialog from './AppDialog.vue';
import AppInput from './AppInput.vue';
import AppTagInput from './AppTagInput.vue';
import AppButton from './AppButton.vue';
import {usePreferences} from '../preferences.js';
const {validate}=useFormFeedback();
const props=defineProps({open:Boolean,disabled:Boolean,group:Object,groups:{type:Array,default:()=>[]},profiles:{type:Array,default:()=>[]}});
const emit=defineEmits(['close','save']);
const {t}=usePreferences();
const name=ref(''), members=ref([]);
const options=computed(()=>[...props.profiles.map(profile=>({value:profile.id,label:profile.builtin?t(profile.name):profile.name})),...props.groups.filter(group=>!props.group?.id || !connectionGroupContains(props.groups,group.id,props.group.id)).map(group=>({value:group.id,label:t('gatewayGroups.option',{name:group.name}),tone:'preset'}))]);
watch(()=>props.open,open=>{if(open){name.value=props.group?.name || '';members.value=[...(props.group?.members || [])];}});
function submit() {
  if(props.disabled)return;
  if(!validate([
    [!!name.value.trim(),'Specify a group name of up to 100 characters.'],
    [members.value.length>0 && members.value.every(id=>options.value.some(option=>option.value===id)),'Select gateways or groups.']
  ]))return;
  emit('save',{name:name.value.trim(),members:members.value});
}
</script>
<template>
  <AppDialog :form-state="[name,members]" :open="open" :title="group?t('Редактировать группу подключений'):t('Новая группа подключений')" @close="emit('close')">
    <div class="form-section">
      <label>{{t('Название группы')}}<AppInput v-model="name" maxlength="100" :disabled="disabled" /></label>
      <label>{{t('Подключения')}}<AppTagInput v-model="members" :label="t('Добавить подключение в группу')" :options="options" :disabled="disabled" :max-tags="100" /></label>
    </div>
    <template #footer>
      <AppButton variant="secondary" :disabled="disabled" @click="emit('close')">{{t('Отмена')}}</AppButton>
      <AppButton data-testid="save-connection-group" :disabled="disabled" @click="submit">{{t('Сохранить')}}</AppButton>
    </template>
  </AppDialog>
</template>

