<script setup>
import {ref,watch} from 'vue';
import AppDialog from './AppDialog.vue';
import AppNavigation from './AppNavigation.vue';
import UserMenu from './UserMenu.vue';
import {usePreferences} from '../preferences.js';
const props=defineProps({open:Boolean,pages:Array,page:String,user:Object,roleLabel:String,disabled:Boolean,canSystem:Boolean});const emit=defineEmits(['close','navigate','logout','system']);const {t}=usePreferences();
const contentVisible=ref(props.open);
watch(()=>props.open,open=>{if(open)contentVisible.value=true;});
</script>
<template>
 <AppDialog :open="open" title="FreedomGate" :label="t('Навигация')" placement="drawer" @close="emit('close')" @closed="contentVisible=false">
  <div class="mobile-navigation-content">
   <AppNavigation v-if="contentVisible" :pages="pages" :model-value="page" @update:model-value="emit('navigate',$event);emit('close')" />
   <div class="mobile-navigation-bottom">
    <UserMenu v-if="open" :user="user" :role-label="roleLabel" :disabled="disabled" :can-system="canSystem" @logout="emit('close');emit('logout')" @system="emit('close');emit('system')" />
   </div>
  </div>
 </AppDialog>
</template>
