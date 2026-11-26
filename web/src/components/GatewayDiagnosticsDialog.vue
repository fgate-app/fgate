<script setup>
import {ref,watch,onBeforeUnmount,computed} from 'vue';
import AppDialog from './AppDialog.vue';
import AppButton from './AppButton.vue';
import AppProgress from './AppProgress.vue';
import AppIcon from './AppIcon.vue';
import AppSwitch from './AppSwitch.vue';
import AppTagInput from './AppTagInput.vue';
import {gatewayUsesTcpOnly} from '../../../shared/gateway-wrap.js';
import {defaultDiagnosticDomains,normalizeDiagnosticDomains} from '../../../shared/diagnostic-targets.js';
import AppSelect from './AppSelect.vue';
import {diagnosticGroups,diagnosticOverview} from '../../../shared/diagnostic-summary.js';
import {isLocalDiagnostic} from '../../../shared/diagnostic-context.js';
import {exportDiagnosticReport} from '../../../shared/diagnostic-report.js';
import {usePreferences} from '../preferences.js';
const props=defineProps({open:Boolean,profile:Object,profiles:Array,api:Function});
const emit=defineEmits(['close']);
const {t}=usePreferences();
const phase=ref('settings'),progress=ref(null),elapsed=ref(0);let clock;
const report=ref(null),loading=ref(false),error=ref(''),uplink=ref(true),endpointCheck=ref(true);
const dnsFamily=ref('4'),tlsVersionsCheck=ref(false),http3Check=ref(false),mtuCheck=ref(false);
const pairedTransferCheck=ref(false);
const transferCheck=ref(false),speedCheck=ref(false),protocolCheck=ref(true),tcpCapture=ref(false);
const endpointDnsSource=ref('doh'),endpointDnsProvider=ref('');
const sniCheck=ref(false),compareDns=ref(false);
const domains=ref([...defaultDiagnosticDomains]);
const domainError=computed(()=>{try{normalizeDiagnosticDomains(domains.value);return '';}catch(error){return error.message;}});
function savedDomains(){try{return normalizeDiagnosticDomains(JSON.parse(localStorage.getItem('fg.diagnostic-domains') || 'null'));}catch{return [...defaultDiagnosticDomains];}}
const dnsCheck=ref(false),dnsProviders=ref([]),dnsSecond=ref('');
const dnsOptions=computed(()=>dnsProviders.value.map(row=>({value:row.id,label:row.name})));
let controller,revision=0;
async function loadDnsCatalog(){try{const value=await props.api('diagnostics/dns/providers');dnsProviders.value=value.providers;[,dnsSecond.value]=value.defaults;if(!endpointDnsProvider.value)endpointDnsProvider.value=value.defaults[0];}catch{dnsProviders.value=[];}}
const tcpOnlyPath=computed(()=>gatewayUsesTcpOnly(props.profiles || [props.profile].filter(Boolean),props.profile?.id));
const localDiagnostic=computed(()=>isLocalDiagnostic(props.profile));
const hasEndpoint=computed(()=>props.profile && !['direct','zapret','block','tor','lantern'].includes(props.profile.engine));
watch(endpointDnsProvider,value=>{if(dnsSecond.value===value)dnsSecond.value=dnsProviders.value.find(row=>row.id!==value)?.id || '';});
const groups=computed(()=>diagnosticGroups(report.value,{providers:dnsProviders.value}));
const overview=computed(()=>diagnosticOverview(report.value));
const stepLabels={lantern:'Connecting to the Lantern proxy network',tor:'Connecting to the Tor network',mtu:'Route MTU to the proxy server',http3:'HTTP/3 and QUIC','tls-versions':'TLS 1.2 and TLS 1.3','paired-transfer':'Same download through both paths',blocklist:'Domain blocklist lookup','path-comparison':'Comparing connection paths','server-route':'Route to the proxy server',strategies:'Testing DPI bypass strategies',strategy:'Testing DPI bypass strategies',preparing:'Preparing checks',websites:'Opening websites',server:'Reaching the proxy server',internet:'Internet access without the gateway','dns-direct':'Website address lookup without the gateway','dns-gateway':'Website address lookup through this connection','sni-direct':'Website name check without the gateway','sni-gateway':'Website name check through this connection',downloads:'Downloading files',speedtest:'Gateway speedtest',protocols:'TCP and UDP through the gateway'};
const completed=computed(()=>progress.value?.steps?.filter(row=>['finished','skipped'].includes(row.state)).length || 0);
const currentStep=computed(()=>progress.value?.steps?.find(row=>['strategy','control-selection','path-comparison-attempt'].includes(row.kind) && row.state==='running') || progress.value?.steps?.find(row=>row.state==='running'));
const clockText=computed(()=>`${Math.floor(elapsed.value/60)}:${String(elapsed.value%60).padStart(2,'0')}`);
function receive(event){
 if(event.progress)progress.value=event.progress;
 if(event.type==='result' && event.report?.progress)progress.value=event.report.progress;
 if(event.report)report.value=event.report;
 if(report.value && progress.value)report.value.progress=structuredClone({...progress.value,steps:progress.value.steps.map(row=>({...row}))});
}
function cancel(){
 stop();phase.value='result';if(progress.value)progress.value={...progress.value,state:'cancelled'};
 report.value={...(report.value || {attempts:[]}),progress:progress.value || {state:'cancelled',steps:[]}};
}
const findingStates={ok:'Works',failed:'Problem found',partial:'Some checks failed',unavailable:'Could not check'};
function stop(){clearInterval(clock);revision++;controller?.abort();controller=null;loading.value=false;}
async function load(){
 if(domainError.value){error.value=t(domainError.value);return;}
 try{domains.value=normalizeDiagnosticDomains(domains.value);localStorage.setItem('fg.diagnostic-domains',JSON.stringify(domains.value));}catch{}
 stop();phase.value='running';const current=revision;report.value=null;progress.value=null;elapsed.value=0;error.value='';loading.value=true;controller=new AbortController();const began=Date.now();clock=setInterval(()=>{elapsed.value=Math.floor((Date.now()-began)/1000);},1000);
 try{const value=await props.api('profiles/'+props.profile.id+'/diagnostics',{method:'POST',body:JSON.stringify({uplink:!localDiagnostic.value && uplink.value,endpoint:hasEndpoint.value && endpointCheck.value,tcpCapture:hasEndpoint.value && endpointCheck.value && tcpCapture.value,endpointDnsSource:endpointDnsSource.value,endpointDnsProvider:endpointDnsProvider.value || undefined,dns:dnsCheck.value,tlsVersions:tlsVersionsCheck.value,http3:http3Check.value,mtu:hasEndpoint.value && endpointCheck.value && mtuCheck.value,dnsFamily:Number(dnsFamily.value),domains:domains.value,dnsProviders:compareDns.value?[endpointDnsProvider.value,dnsSecond.value]:[endpointDnsProvider.value],transfer:transferCheck.value,pairedTransfer:!localDiagnostic.value && pairedTransferCheck.value,speedtest:speedCheck.value,protocols:protocolCheck.value,sni:sniCheck.value}),signal:controller.signal,onDiagnosticEvent:event=>{if(current===revision)receive(event);}});if(current===revision){report.value=value;progress.value=value.progress || progress.value;}}
 catch(failure){if(current===revision && failure.name!=='AbortError'){error.value=failure.message;if(progress.value)progress.value={...progress.value,state:'interrupted'};report.value={...(report.value || {attempts:[]}),progress:progress.value || {state:'interrupted',steps:[]}};}}
 finally{if(current===revision){clearInterval(clock);loading.value=false;phase.value='result';}}
}
watch(()=>[props.open,props.profile?.id],()=>{if(props.open && props.profile){stop();phase.value='settings';report.value=null;progress.value=null;elapsed.value=0;error.value='';uplink.value=props.profile.engine!=='tor';endpointCheck.value=true;tcpCapture.value=false;endpointDnsSource.value='doh';endpointDnsProvider.value='';dnsCheck.value=false;tlsVersionsCheck.value=false;http3Check.value=false;mtuCheck.value=false;dnsFamily.value='4';domains.value=savedDomains();transferCheck.value=false;pairedTransferCheck.value=false;speedCheck.value=false;protocolCheck.value=true;sniCheck.value=false;compareDns.value=false;loadDnsCatalog();}else stop();},{immediate:true});
onBeforeUnmount(stop);
function close(){stop();emit('close');}
function exportReport(){
 const url=URL.createObjectURL(new Blob([JSON.stringify(exportDiagnosticReport(report.value),null,2)],{type:'application/json'}));
 const link=document.createElement('a');link.href=url;link.download='freedomgate-diagnostics.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function returnToSettings(){stop();report.value=null;progress.value=null;error.value='';elapsed.value=0;phase.value='settings';}
</script>
<template>
 <AppDialog :open="open" wide :label="t('Диагностика шлюза')" :title="t('Gateway diagnostics {name}',{name:profile?.name || ''})" @close="close">
  <div class="form-section" data-testid="gateway-diagnostics">
   <div v-if="phase==='settings'" class="form-section" data-testid="diagnostic-settings">
   <section class="form-section">
    <label>{{t('Test domains')}}<AppTagInput v-model="domains" :label="t('Test domains')" :disabled="loading" :placeholder="t('Add a domain and press Enter')" data-testid="diagnostic-domains"><template #suffix><span data-testid="diagnostic-domain-count">{{t('{count} of {max}',{count:domains.length,max:8})}}</span></template></AppTagInput></label>
    <p v-if="domainError" role="alert">{{t(domainError)}}</p>
    <AppSwitch v-if="!localDiagnostic" v-model="uplink" :disabled="loading" :label="t('Проверить прямой uplink')" />
    <AppSwitch v-if="hasEndpoint" v-model="endpointCheck" :disabled="loading" :label="t('Check gateway server addresses')" />
    <AppSwitch v-model="dnsCheck" :disabled="loading || !dnsProviders.length" :label="t(localDiagnostic?'Check DNS resolvers':'Compare DNS paths')" data-testid="diagnostic-dns-switch" />
    <AppSwitch v-model="sniCheck" :disabled="loading" :label="t('Compare SNI and IP addresses')" data-testid="diagnostic-sni-switch" />
    <AppSwitch v-if="hasEndpoint && endpointCheck" v-model="mtuCheck" :disabled="loading" :label="t('Route MTU to the proxy server')" data-testid="diagnostic-mtu-switch" />
    <AppSwitch v-if="!tcpOnlyPath" v-model="http3Check" :disabled="loading" :label="t('Check HTTP/3 and QUIC')" data-testid="diagnostic-http3-switch" />
    <AppSwitch v-model="tlsVersionsCheck" :disabled="loading" :label="t('Compare TLS 1.2 and TLS 1.3')" data-testid="diagnostic-tls-versions-switch" />
    <AppSwitch v-model="transferCheck" :disabled="loading" :label="t('Receive data from websites')" data-testid="diagnostic-transfer-switch" />
    <AppSwitch v-if="!localDiagnostic" v-model="pairedTransferCheck" :disabled="loading" :label="t('Compare one download with and without the gateway')" data-testid="diagnostic-paired-transfer-switch" />
    <AppSwitch v-model="protocolCheck" :disabled="loading" :label="t('Check TCP and UDP')" data-testid="diagnostic-protocol-switch" />
    <AppSwitch v-model="speedCheck" :disabled="loading" :label="t('Measure gateway speed')" data-testid="diagnostic-speed-switch" />
    <p v-if="speedCheck">{{t('Cloudflare speedtest: downloads up to 8 MiB and uploads up to 2 MiB. Runs once through the selected connection.')}}</p>
    <p v-if="transferCheck">{{t('Requests up to 1 MiB from each listed website. This is not a speed test; redirects and large responses may prevent the check.')}}</p>
   </section>
   <section v-if="dnsCheck || sniCheck || tlsVersionsCheck || http3Check || (hasEndpoint && endpointCheck)" class="form-section" aria-labelledby="diagnostic-parameters-title" data-testid="diagnostic-parameters">
    <h4 id="diagnostic-parameters-title">{{t('Test parameters')}}</h4>
    <label v-if="dnsCheck">{{t('DNS transport family')}}<AppSelect v-model="dnsFamily" :label="t('DNS transport family')" :disabled="loading" :options="[{value:'4',label:'IPv4'},{value:'6',label:'IPv6'}]" data-testid="diagnostic-dns-family" /></label>
    <label v-if="dnsCheck || tlsVersionsCheck || http3Check || (hasEndpoint && endpointCheck && endpointDnsSource==='doh')">{{t('Primary DNS resolver')}}<AppSelect v-model="endpointDnsProvider" :label="t('Primary DNS resolver')" :disabled="loading || !dnsProviders.length" :options="dnsOptions" /></label>
    <AppSwitch v-if="dnsCheck || (hasEndpoint && endpointCheck && endpointDnsSource==='doh')" v-model="compareDns" :disabled="loading || dnsProviders.length<2" :label="t('Compare with another resolver')" data-testid="diagnostic-compare-resolver" />
    <label v-if="compareDns && (dnsCheck || (hasEndpoint && endpointCheck && endpointDnsSource==='doh'))">{{t('Second DNS resolver')}}<AppSelect v-model="dnsSecond" :options="dnsOptions.filter(row=>row.value!==endpointDnsProvider)" :label="t('Second DNS resolver')" :disabled="loading" /></label>
    <template v-if="hasEndpoint && endpointCheck">
     <label>{{t('Server address DNS source')}}<AppSelect v-model="endpointDnsSource" :label="t('Server address DNS source')" :disabled="loading" :options="[{value:'doh',label:t('DoH over the direct uplink')},{value:'system',label:t('System DNS')}]" /></label>
     <AppSwitch v-model="tcpCapture" :disabled="loading" :label="t('Check the server response in more detail')" data-testid="diagnostic-capture-switch" />
     <p v-if="tcpCapture">{{t('Checks one direct connection to the server for up to 10 seconds. No message contents are recorded.')}}</p>
    </template>
   </section>
   </div>
    <section v-if="phase!=='settings'" class="diagnostic-section" data-testid="diagnostic-identity">
     <h4>{{t('Exit connection')}}</h4>
     <dl class="diagnostic-identity">
      <template v-if="!localDiagnostic"><div><dt>{{t('Gateway type')}}</dt><dd>{{t('Proxy')}} · {{({xray:'Xray',outline:'Outline SDK',mihomo:'mihomo'})[profile?.engine] || profile?.engine || t('Unavailable')}}</dd></div><div><dt>{{t('Protocol')}}</dt><dd>{{profile?.protocol==='ss'?'Outline/Shadowsocks':profile?.protocol?.toUpperCase() || t('Unavailable')}}</dd></div></template>
      <div><dt>{{t('IP address')}}</dt><dd>{{report?.egressIdentity?.ip || t('Unavailable')}}</dd></div>
      <div><dt>{{t('Country')}}</dt><dd>{{report?.egressIdentity?.country || report?.egressIdentity?.countryCode || t('Unavailable')}}</dd></div>
      <div><dt>{{t('City')}}</dt><dd>{{report?.egressIdentity?.city || t('Unavailable')}}</dd></div>
      <div><dt>{{t('Provider / ASN')}}</dt><dd>{{[report?.egressIdentity?.provider,report?.egressIdentity?.asn].filter(Boolean).join(' · ') || t('Unavailable')}}</dd></div>
     </dl>
    </section>
   <section v-if="phase==='running' && progress" class="diagnostic-progress" data-testid="diagnostic-progress" aria-labelledby="diagnostic-progress-title">
    <div class="diagnostic-line"><h4 id="diagnostic-progress-title" role="status">{{t(loading?(currentStep?.label || stepLabels[currentStep?.kind || currentStep?.id] || 'Preparing checks'):progress.state==='completed'?'Diagnostics completed':progress.state==='cancelled'?'Diagnostics cancelled':progress.state==='budget-exhausted'?'Diagnostic time limit reached':'Diagnostics interrupted')}}<template v-if="loading && currentStep?.domain"> · {{currentStep.domain}}</template></h4><span class="diagnostic-muted">{{clockText}}</span></div>
    <AppProgress :value="completed" :max="progress.steps.length" :label="t('Diagnostic progress')" />
    <p class="diagnostic-muted">{{t('Completed {completed} of {total} steps',{completed,total:progress.steps.length})}}</p>
    <ol class="diagnostic-steps">
     <li v-for="step in progress.steps" :key="step.id" :data-state="step.state" :data-kind="step.kind" :data-outcome="step.outcome"><AppIcon class="diagnostic-stage-icon" :name="['failed','partial'].includes(step.outcome)?'close':'check'" /><span>{{t(step.label || stepLabels[step.kind || step.id])}}<template v-if="step.percent!==undefined"> · {{step.percent}}%</template><template v-if="step.address"> · {{step.address}}</template><template v-if="step.domain"> · {{step.domain}}</template></span><span class="diagnostic-muted">{{t(step.state==='finished'?(findingStates[step.outcome] || 'Could not check'):step.state==='running'?(loading?'In progress':'Not completed'):'Not run')}}</span></li>
    </ol>
   </section>
   <p v-else-if="loading" role="status">{{t('Preparing checks')}}</p>
   <p v-if="error" role="alert">{{error}}</p>
   <template v-if="phase==='result' && report">
    <section class="diagnostic-section diagnostic-overview" data-testid="diagnostic-summary">
     <h4>{{t(overview.title)}}</h4>
     <p v-if="report.domains" class="diagnostic-muted">{{report.domains.join(' · ')}}</p>
     <p role="status" data-testid="diagnostic-outcome">{{t(overview.message)}}</p>
     <p v-if="overview.uncheckedTargets?.length">{{t('Not fully checked: {domains}',{domains:overview.uncheckedTargets.join(', ')})}}</p>
     <p v-if="overview.failedTargets?.length">{{t('Did not open: {domains}',{domains:overview.failedTargets.join(', ')})}}</p>
     <div v-if="overview.next" class="diagnostic-next"><h4>{{t('What to do next')}}</h4><p>{{t(overview.next)}}</p></div>
    </section>
    <section class="diagnostic-section">
     <section v-for="group in groups" :key="group.id" class="diagnostic-section diagnostic-domain-group" :data-testid="'diagnostic-group-'+group.id">
     <h4>{{group.domain?group.title:t(group.title)}}</h4>
     <div class="diagnostic-findings">
      <details v-for="card in group.cards" :key="card.id" class="diagnostic-finding" :data-state="card.state" :data-testid="'diagnostic-finding-'+card.id">
       <summary><AppIcon class="diagnostic-finding-icon" :name="['failed','partial'].includes(card.state)?'close':'check'" /><span>{{t(card.title)}}</span><span class="diagnostic-muted diagnostic-result-state">{{t(card.statusMessage || findingStates[card.state] || findingStates.unavailable)}}<AppIcon name="chevron" /></span></summary>
       <div class="diagnostic-detail">
        <p v-if="card.description">{{t(card.description)}}</p><p>{{t(card.message,card.params)}}</p><p v-if="card.next && card.id.startsWith('xray-connection')">{{t(card.next)}}</p>
        <dl v-if="card.rows?.length" class="diagnostic-list"><div v-for="(row,index) in card.rows" :key="index" class="diagnostic-check"><dt>{{row.label?t(row.label):row.target}}<template v-if="row.operation"> · {{t(row.operation)}}</template></dt><dd>{{t(row.message,row.params)}}<p v-for="(detail,detailIndex) in row.details" :key="detailIndex">{{t(detail.message,detail.params)}}</p><p v-if="row.redirects" class="diagnostic-muted">{{t('Redirects: {chain}',{chain:row.redirects})}}</p></dd></div></dl>
       </div>
      </details>
     </div>
     </section>
    </section>
   </template>
  </div>
  <template #footer>
   <AppButton v-if="!loading" variant="secondary" data-testid="diagnostic-close" @click="close">{{t('Закрыть')}}</AppButton>
   <AppButton v-if="loading" variant="secondary" data-testid="diagnostic-cancel" @click="cancel">{{t('Cancel checks')}}</AppButton>
   <AppButton v-if="phase==='result' && report" variant="secondary" data-testid="diagnostic-export" @click="exportReport">{{t('Экспорт JSON')}}</AppButton>
   <AppButton v-if="!loading" :disabled="phase==='settings' && !!domainError" data-testid="diagnostic-retry" @click="phase==='result'?returnToSettings():load()">{{t(phase==='result'?'Повторить':'Run diagnostics')}}</AppButton>
  </template>
 </AppDialog>
</template>
<style scoped>
[data-testid="gateway-diagnostics"]{font-size:var(--font-size-body);color:var(--color-text-primary)}
.form-section h4,.diagnostic-section h4,.diagnostic-progress h4{font-size:var(--font-size-body);font-weight:600;line-height:1.5;margin:0;color:var(--color-text-primary)}
.form-section>p,.diagnostic-section p,.diagnostic-progress p,.diagnostic-list,.diagnostic-list dd{margin:0;font-size:var(--font-size-body);line-height:1.5;overflow-wrap:anywhere}
.diagnostic-section,.diagnostic-progress,.diagnostic-detail,.diagnostic-next{display:grid;gap:var(--space-3);margin:0}
.diagnostic-muted,.diagnostic-list dt,.diagnostic-identity dt{color:var(--color-text-secondary);font-size:var(--font-size-body);font-weight:400}
.diagnostic-line{display:flex;align-items:baseline;justify-content:space-between;gap:var(--space-3)}
.diagnostic-stage-icon{width:var(--space-4);height:var(--space-4);color:color-mix(in srgb,var(--color-text-secondary) 45%,transparent);align-self:center;justify-self:center}
[data-outcome="ok"]>.diagnostic-stage-icon{color:var(--color-success)}
[data-outcome="failed"]>.diagnostic-stage-icon,[data-outcome="partial"]>.diagnostic-stage-icon{color:var(--color-danger)}
.diagnostic-steps{list-style:none;padding:0;margin:0;display:grid;gap:var(--space-2)}
.diagnostic-steps li,.diagnostic-finding summary{display:grid;grid-template-columns:var(--space-2) minmax(0,1fr) auto;align-items:baseline;gap:var(--space-3);font-size:var(--font-size-body);line-height:1.5}
.diagnostic-steps li{grid-template-columns:var(--space-4) minmax(0,1fr) auto}
.diagnostic-finding-icon{width:var(--space-4);height:var(--space-4);align-self:center;justify-self:center;color:color-mix(in srgb,var(--color-text-secondary) 45%,transparent)}
[data-state="ok"]>summary>.diagnostic-finding-icon{color:var(--color-success)}
[data-state="failed"]>summary>.diagnostic-finding-icon,[data-state="partial"]>summary>.diagnostic-finding-icon{color:var(--color-danger)}
.diagnostic-finding summary{grid-template-columns:var(--space-4) minmax(0,1fr) auto}
.diagnostic-findings{border-top:1px solid var(--color-border)}
.diagnostic-finding{border-bottom:1px solid var(--color-border);padding:var(--space-3) 0}
.diagnostic-finding summary{cursor:pointer;list-style:none}
.diagnostic-finding summary::-webkit-details-marker{display:none}
.diagnostic-finding summary>span:last-child{text-align:end}
.diagnostic-result-state{display:flex;align-items:center;justify-content:end;gap:var(--space-2)}
.diagnostic-result-state .app-icon{width:var(--space-4);height:var(--space-4)}
.diagnostic-finding[open] .diagnostic-result-state .app-icon{transform:rotate(180deg)}
.diagnostic-detail{padding:var(--space-3) 0 0 var(--space-5);color:var(--color-text-secondary)}
.diagnostic-list{display:grid;gap:var(--space-3)}
.diagnostic-check{display:grid;gap:var(--space-1)}
.diagnostic-identity{display:grid;gap:var(--space-2);margin:0}
.diagnostic-identity>div{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,2fr);gap:var(--space-3)}
.diagnostic-identity dd{margin:0;overflow-wrap:anywhere}
@media(max-width:600px){.diagnostic-stage-icon,.diagnostic-finding-icon{grid-row:1 / span 2}.diagnostic-steps li,.diagnostic-finding summary{grid-template-columns:var(--space-4) minmax(0,1fr)}.diagnostic-steps li>span:last-child,.diagnostic-finding summary>span:last-child{grid-column:2;text-align:start;justify-content:start}}
</style>
