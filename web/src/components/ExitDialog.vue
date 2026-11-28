<script setup>
import {xhttpFields} from '../../../shared/xray-xhttp.js';
import {xrayMuxFields,tcpMuxUnsupported} from '../../../shared/xray-mux.js';
import {mihomoSchema} from '../../../shared/mihomo-schema.js';
import {nativePrefix} from '../../../shared/mihomo-proxy.js';
import {xraySecurityFields,xrayAlpnHint} from '../../../shared/xray-security.js';
import AppAccordion from './AppAccordion.vue';
import AppInfoBlock from './AppInfoBlock.vue';
import AppPasswordInput from './AppPasswordInput.vue';
import {useFormFeedback} from '../composables/useFormFeedback.js';
import {computed,ref,watch} from 'vue';
import {canWrapGateway,gatewayWrapCandidates} from '../../../shared/gateway-wrap.js';
import {profileLinkName} from '../../../shared/profile-name.js';
import {configRecords,configKind,CONFIG_LIMIT} from '../../../shared/gateway-config.js';
import {proxyTypes,fieldLabels,fieldOptions,visibleFields,manualConfig} from '../../../shared/manual-gateway.js';
import {usePreferences} from '../preferences.js';
import AppButton from './AppButton.vue';
import AppDialog from './AppDialog.vue';
import AppInput from './AppInput.vue';
import AppFileUpload from './AppFileUpload.vue';
import AppSwitch from './AppSwitch.vue';
import AppTextarea from './AppTextarea.vue';
import AppSelect from './AppSelect.vue';
import AppTabBar from './AppTabBar.vue';
import AppTab from './AppTab.vue';
import AppTabPanel from './AppTabPanel.vue';
import ConfigSelectionDialog from './ConfigSelectionDialog.vue';
const {reportError}=useFormFeedback();
const props=defineProps({open:Boolean,disabled:Boolean,initialType:{type:String,default:''},profile:Object,loadConfig:Function,profiles:{type:Array,default:()=>[]}});
const emit=defineEmits(['close','add']);
const {t}=usePreferences();
const dpiBypass=ref(false),wrapEnabled=ref(false),gatewayId=ref('');
const wrapOptions=computed(()=>gatewayWrapCandidates(props.profiles,props.profile?.id).map(p=>({value:p.id,label:p.name})));
const subscriptionManaged=computed(()=>!!props.profile?.subscriptionId);
const wrapping=computed(()=>canWrapGateway(props.profile));
function wrapSettings(){if(!wrapping.value)return {};if(wrapEnabled.value && !wrapOptions.value.some(p=>p.value===gatewayId.value))throw Error("Select an outer gateway.");return {gatewayId:wrapEnabled.value?gatewayId.value:null};}
const enabled=ref(true),name=ref(''),nameEdited=ref(false),value=ref('');
const mode=ref('config'),type=ref('vless'),draft=ref({}),fileValue=ref(''),selectedFile=ref(null),reading=ref(false),fileGeneration=ref(0);
const loading=ref(false),loaded=ref(false);
const picking=ref(false),records=ref([]),selected=ref([]);
const selectionRecords=computed(()=>records.value.map(row=>({key:row.index,label:row.label})));
const advanced=ref(false);
const fields=computed(()=>visibleFields(type.value,draft.value));
const fieldSections=computed(()=>type.value==='vless'?[{advanced:false,fields:fields.value.filter(f=>![...xraySecurityFields,...xrayMuxFields,...xhttpFields].includes(f))},{advanced:true,fields:fields.value.filter(f=>[...xraySecurityFields,...xrayMuxFields,...xhttpFields].includes(f))}].filter(s=>s.fields.length):[{advanced:false,fields:fields.value}]);
const muxHint=computed(()=>type.value==='vless' && draft.value.muxEnabled==='true'?(tcpMuxUnsupported(draft.value)?(Number(draft.value.muxConcurrency)<0?'Only UDP sessions are pooled; TCP streams remain separate.':'TCP Mux is incompatible with Vision and XHTTP. Set TCP concurrency to -1 for XUDP only.'):['grpc','xhttp','splithttp'].includes(draft.value.network)?'This transport already multiplexes streams. Prefer TCP concurrency -1 for XUDP only.':'This Xray version treats TCP concurrency 0 to 128 as a limit of 128 streams. Mux does not guarantee higher speed.'):'');
const alpnHint=computed(()=>type.value==='vless'?xrayAlpnHint(draft.value):'');
const detected=computed(()=>{try{const rows=configRecords(value.value);return rows.length>1?`${rows.length} ${t('подключений')}`:configKind(rows[0]);}catch{return '';}});
const canSubmit=computed(()=>!props.disabled && !reading.value && !loading.value && (props.profile?name.value.trim():mode.value==='manual'?true:mode.value==='file'?fileValue.value.trim():value.value.trim()));
const nativeType=computed(()=>type.value.startsWith(nativePrefix)?type.value.slice(nativePrefix.length):null);
const advancedLabels={xhttpMode:'XHTTP mode',xhttpHeaders:'XHTTP headers (JSON)',xhttpXmux:'XHTTP connection pool (JSON)',xhttpExtra:'XHTTP extra options (JSON)',xhttpDownload:'XHTTP download settings (JSON)',encryption:'VLESS Encryption',muxEnabled:'Enable Mux',muxConcurrency:'TCP Mux concurrency',muxXudpConcurrency:'XUDP concurrency',muxUdp443:'UDP port 443',alpn:'ALPN',pinnedPeerCertSha256:'Certificate SHA-256 pins',verifyPeerCertByName:'Certificate names',spiderX:'SpiderX',mldsa65Verify:'ML-DSA-65 verification key'};
const fieldLabel=field=>advancedLabels[field]?t(advancedLabels[field]):field==='options'?t('Advanced proxy options (JSON)'):field==='network' && nativeType.value==='zerotier'?t('Network'):t(fieldLabels[field] || field);
const isBoolean=field=>field==='muxEnabled' || nativeType.value && mihomoSchema[nativeType.value]?.[field]==='boolean';
const multiline=f=>xhttpFields.includes(f) && f!=='xhttpMode' || ['ca','cert','key','tls-auth','tls-crypt','options','mldsa65Verify','pinnedPeerCertSha256'].includes(f) || (nativeType.value && f==='private-key' && ['ssh','http','trojan','anytls','vmess','vless'].includes(nativeType.value));
function resetDraft(){advanced.value=false;if(type.value.startsWith(nativePrefix)){draft.value={options:'{}',port:'443'};return;}draft.value={xhttpMode:'auto',xhttpHeaders:'',xhttpXmux:'',xhttpExtra:'',xhttpDownload:'',encryption:'none',port:type.value==='socks5'?'1080':type.value==='wireguard'?'51820':type.value==='openvpn'?'1194':'443',security:'reality',network:'tcp',proto:'udp','skip-cert-verify':'false',muxEnabled:'false',muxConcurrency:'128',muxXudpConcurrency:'16',muxUdp443:'reject',cipher:type.value==='openvpn'?'AES-128-GCM':'chacha20-ietf-poly1305','allowed-ips':'0.0.0.0/0, ::/0'};}
watch(type,resetDraft,{flush:'sync'});
watch(()=>props.open,async open=>{
 const generation=++fileGeneration.value;loaded.value=false;loading.value=false;
 if(!open){picking.value=false;draft.value={};return;}
 dpiBypass.value=props.profile?.dpiBypass===true;gatewayId.value=props.profile?.gatewayId || '';wrapEnabled.value=!!gatewayId.value;
 name.value=props.profile?.name || '';nameEdited.value=false;enabled.value=props.profile?.enabled!==false;value.value='';mode.value=props.profile||props.initialType?'manual':'config';type.value=proxyTypes.some(option=>option.value===props.initialType)?props.initialType:'vless';resetDraft();fileValue.value='';selectedFile.value=null;reading.value=false;records.value=[];selected.value=[];
 if(subscriptionManaged.value){loaded.value=true;return;}
 if(props.profile && (!props.profile.builtin || props.profile.engine==='lantern')){
  loading.value=true;
  try{const data=await props.loadConfig(props.profile.id);if(generation!==fileGeneration.value)return;type.value=data.type;draft.value={...data.fields};dpiBypass.value=data.dpiBypass===true;gatewayId.value=data.gatewayId || '';wrapEnabled.value=!!gatewayId.value;advanced.value=data.type==='vless' && [...xraySecurityFields,...xrayMuxFields,...xhttpFields].some(key=>key==='muxEnabled'?draft.value[key]==='true':(xraySecurityFields.includes(key) && draft.value[key]) || (xhttpFields.includes(key) && draft.value[key] && !['{}','auto'].includes(draft.value[key])));loaded.value=true;}
  catch(e){if(generation===fileGeneration.value){reportError(e.message);mode.value='config';}}
  finally{if(generation===fileGeneration.value)loading.value=false;}
 }
});
watch(value,config=>{if(props.open && !props.profile && !nameEdited.value)name.value=profileLinkName(config);});
function editName(v){nameEdited.value=true;name.value=v;}
async function readFile(file){
 const generation=++fileGeneration.value;selectedFile.value=file;fileValue.value='';if(!file){reading.value=false;return;}
 if(file.size>CONFIG_LIMIT){reportError('The file must be no larger than 256 KB.');selectedFile.value=null;return;}
 reading.value=true;
 try{const text=await file.text();if(generation!==fileGeneration.value)return;configRecords(text);fileValue.value=text;if(!props.profile && !nameEdited.value)name.value=file.name.replace(/\.[^.]+$/,'').slice(0,100);}
 catch(e){if(generation===fileGeneration.value){reportError(e.message);selectedFile.value=null;}}
 finally{if(generation===fileGeneration.value)reading.value=false;}
}
function submit(){
 try{
  if(props.disabled || loading.value)return;
  if(props.profile && mode.value==='manual'){if(!props.profile.builtin && !loaded.value)throw new Error("Could not load configuration.");emit('add',{name:name.value.trim(),enabled:enabled.value,...wrapSettings(),...((type.value==='ss' || props.profile.engine==='outline')?{dpiBypass:dpiBypass.value}:{}),...(!props.profile.builtin && !subscriptionManaged.value?{editor:{type:type.value,fields:{...draft.value}}}:{})});return;}
  const config=mode.value==='manual'?manualConfig(type.value,draft.value):mode.value==='file'?fileValue.value.trim():value.value.trim();
  if(!config && !props.profile)throw new Error("Paste a configuration or link.");
  const rows=config?configRecords(config):[];
  if(rows.length>1){records.value=rows.map((value,index)=>({value,index,label:profileLinkName(value) || `${configKind(value)} ${index+1}`}));selected.value=props.profile?[]:rows.map((_,index)=>index);picking.value=true;return;}
  emit('add',{name:name.value.trim(),...(config?{value:rows[0]}:{}),...(props.profile?{enabled:enabled.value,...wrapSettings(),...(props.profile.engine==='outline'?{dpiBypass:dpiBypass.value}:{})}:{}),...(mode.value==='file'?{username:draft.value.username,password:draft.value.password}:{})});
 }catch(e){reportError(e.message);}
}
function addSelected(){try{if(props.disabled || !selected.value.length)return;const values=records.value.filter(r=>selected.value.includes(r.index)).map(r=>r.value);emit('add',{value:props.profile?values[0]:JSON.stringify(values),...(props.profile?{name:name.value.trim(),enabled:enabled.value,...wrapSettings(),...(props.profile.engine==='outline'?{dpiBypass:dpiBypass.value}:{})}:{})});}catch(e){reportError(e.message);}}
</script>
<template>
 <AppDialog :form-session="open" :form-state="loading?undefined:[enabled,name,value,dpiBypass,wrapEnabled,gatewayId,type,draft,fileValue]" :open="open && !picking" :title="t(profile?'Изменить подключение':'Новая точка выхода')" @close="emit('close')">
  <div class="form-section gateway-form">
   <label>{{t('Название')}}<AppInput :model-value="name" :disabled="!!profile?.builtin" maxlength="100" :placeholder="t('Необязательно')" @update:model-value="editName" /></label>
   <AppSwitch v-if="profile" v-model="enabled" :label="t('Включено')" />
   <AppSwitch v-if="profile?.engine==='outline' && loaded" v-model="dpiBypass" :label="t('Обход DPI')" :disabled="disabled" data-testid="ss-dpi-bypass" />
   <AppSwitch v-if="wrapping && loaded" v-model="wrapEnabled" :label="t('Завернуть в шлюз')" :disabled="disabled" data-testid="gateway-wrap" />
   <label v-if="wrapping && loaded && wrapEnabled">{{t('Внешний шлюз')}}<AppSelect v-model="gatewayId" :options="wrapOptions" :label="t('Внешний шлюз')" :disabled="disabled" data-testid="gateway-wrap-select" /></label>
   <p v-if="loading" class="muted" role="status">{{t('Загрузка…')}}</p>
   <AppInfoBlock v-if="subscriptionManaged">{{t('Connection parameters are managed by the subscription.')}}</AppInfoBlock>
   <AppTabBar v-if="!profile?.builtin && !loading && !subscriptionManaged" v-model="mode" :label="t('Способ добавления')" size="s">
    <AppTab v-if="profile" value="manual">{{t('Параметры')}}</AppTab><AppTab value="config">{{t(profile?'Загрузить заново':'Добавить конфиг')}}</AppTab><AppTab value="file">{{t('Загрузить файл')}}</AppTab><AppTab v-if="!profile" value="manual">{{t('Вручную')}}</AppTab>
    <template #panels>
     <AppTabPanel value="config"><label>{{t('Ссылка или конфигурация')}}<AppTextarea v-model="value" :rows="6" :placeholder="t('Proxy link, mihomo YAML/JSON, OpenVPN or WireGuard')" /><small v-if="detected" class="muted form-hint" data-testid="exit-detected">{{t('Тип')}}: {{detected}}</small></label></AppTabPanel>
     <AppTabPanel value="file"><div class="form-section gateway-form"><AppFileUpload :model-value="selectedFile" :label="t('Файл конфигурации')" accept=".txt,.ovpn,.conf,.json,.yaml,.yml" :max-size="CONFIG_LIMIT" :disabled="disabled" :loading="reading" data-testid="gateway-file" :hint="t('Proxy links or Base64, mihomo YAML/JSON, OpenVPN and WireGuard. Up to 256 KB.')" @update:model-value="readFile" /><template v-if="fileValue && configKind(fileValue)==='OpenVPN'"><label>{{t('Логин')}}<AppInput v-model="draft.username" autocomplete="off" /></label><label>{{t('Пароль')}}<AppPasswordInput v-model="draft.password" autocomplete="new-password" /></label><small class="muted">{{t('Если сервер требует логин и пароль, укажите их здесь.')}}</small></template></div></AppTabPanel>
     <AppTabPanel value="manual"><div v-if="!profile || loaded" class="form-section gateway-form"><label>{{t('Тип прокси')}}<AppSelect v-model="type" :disabled="!!profile" :label="t('Тип прокси')" :options="proxyTypes" /></label><component :is="section.advanced?AppAccordion:'div'" v-for="section in fieldSections" :key="section.advanced?'advanced':'base'" :open="section.advanced?advanced:undefined" :title="section.advanced?t('Дополнительные настройки'):undefined" @update:open="advanced=$event"><div class="form-section"><AppInfoBlock v-if="section.advanced && ['xhttp','splithttp'].includes(draft.network)">{{t('Download settings use an XHTTP stream JSON with address, port, network and security. Leave empty to share the upload connection. Separate downloads are unavailable in stream-one mode.')}}</AppInfoBlock><AppInfoBlock v-if="section.advanced && muxHint">{{t(muxHint)}}</AppInfoBlock><AppInfoBlock v-if="section.advanced && alpnHint">{{t(alpnHint)}}</AppInfoBlock><AppInfoBlock v-if="section.advanced && draft.security==='reality' && draft.mldsa65Verify">{{t('ML-DSA-65 requires matching server settings and a REALITY target certificate larger than 3500 bytes.')}}</AppInfoBlock><AppInfoBlock v-if="section.advanced && draft.security==='tls'">{{t(draft.pinnedPeerCertSha256?'A matching leaf certificate pin replaces CA and name checks in Xray. Use a trusted fingerprint.':'Certificate pins must come from a trusted source. Certificate verification stays enabled.')}}</AppInfoBlock><div v-for="field in section.fields" :key="field"><AppSwitch v-if="isBoolean(field) || field==='skip-cert-verify'" :model-value="draft[field]==='true'" :disabled="disabled" :label="isBoolean(field)?fieldLabel(field):t('Skip certificate verification')" @update:model-value="draft[field]=$event?'true':'false'" /><label v-else>{{field==='fingerprint' && type==='hysteria2'?t('Certificate SHA-256 fingerprint'):fieldLabel(field)}}<AppTextarea v-if="multiline(field)" v-model="draft[field]" :rows="4" /><AppSelect v-else-if="!nativeType && fieldOptions[field] && !(field==='cipher' && type==='openvpn')" v-model="draft[field]" :label="field==='fingerprint' && type==='hysteria2'?t('Certificate SHA-256 fingerprint'):fieldLabel(field)" :options="[...new Set([...fieldOptions[field],...(draft[field]?[draft[field]]:[])])].map(value=>({value,label:value?t(value):t('Необязательно')}))" /><AppPasswordInput v-else-if="['encryption','password','private-key','pre-shared-key','obfs-password','token','psk','key','network-secret','auth-key'].includes(field)" v-model="draft[field]" autocomplete="new-password" :disabled="disabled"/><AppInput v-else v-model="draft[field]" :type="['port','muxConcurrency','muxXudpConcurrency'].includes(field)?'number':'text'" :min="field==='port'?1:['muxConcurrency','muxXudpConcurrency'].includes(field)?-32768:undefined" :max="field==='port'?65535:['muxConcurrency','muxXudpConcurrency'].includes(field)?32767:undefined" autocomplete="off" /></label><small v-if="field==='encryption'" class="muted">{{t('Use the complete client Encryption string from your provider, or none to disable it. This is separate from TLS and REALITY.')}}</small></div></div></component></div></AppTabPanel>
    </template>
   </AppTabBar>
  </div>
  <template #footer><AppButton variant="secondary" :disabled="disabled" @click="emit('close')">{{t('Отмена')}}</AppButton><AppButton :disabled="!canSubmit" data-testid="dialog-add-exit" @click="submit">{{t(profile?'Сохранить':'Добавить')}}</AppButton></template>
 </AppDialog>
 <ConfigSelectionDialog :open="open && picking" :records="selectionRecords" v-model="selected" :disabled="disabled" :single="!!profile" @close="picking=false" @confirm="addSelected" />
</template>
<style scoped>
.gateway-form{gap:var(--space-6)}
.gateway-form>p{margin:0}
</style>
