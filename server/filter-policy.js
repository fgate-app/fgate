import {isIP} from 'node:net';
import {groupDnsEntries,adguardDomainRule as domainRule} from './route-entries.js';

// The routes list owns simple domain blocking. AdGuard is an implementation
// detail; unrelated advanced filtering rules remain untouched.
export class FilterPolicy {
  constructor(store,filter) {this.store=store;this.filter=filter;this.queue=Promise.resolve();}
  #run(action) {this.queue=this.queue.then(action,action);return this.queue;}
  #available() {return Boolean(this.filter?.userRules && (!this.filter.status || this.filter.status().state==='running'));}
  async #import() {
    if(!this.#available())return;
    let state=this.store.filterRuleState();
    if(!state.imported){
      const rules=await this.filter.userRules(),blocked=new Set(this.store.routeGroups().filter(group=>group.routeId==='block').flatMap(group=>group.entries)),imported=[];
      for(const rule of rules){
        const match=/^\|\|((?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,})\^$/i.exec(rule);if(!match)continue;
        const entry=match[1].toLowerCase();if(!blocked.has(entry)){this.store.addRouteGroup({name:entry.slice(0,100),entries:[entry],routeId:'block'});blocked.add(entry);}imported.push(rule);
      }
      this.store.saveFilterRuleState({...state,imported:true,managed:[...new Set([...state.managed,...imported])]});
    }
    state=this.store.filterRuleState();
    if(!state.dnsImported && this.filter.policySnapshot){
      const snapshot=await this.filter.policySnapshot();
      this.store.db.exec('BEGIN IMMEDIATE');
      try{
        const filters=[];
        for(const source of snapshot.filters || []){
          const group=this.store.addRouteGroup({name:(source.name || 'AdGuard DNS filter').slice(0,100),routeId:'block',entries:[],dnsFilters:[{url:source.url,name:source.name}]});
          if(source.enabled===false)this.store.setRouteEnabled('groups',group.id,false);filters.push(source.url);
        }
        const extra=(snapshot.userRules || []).filter(rule=>!state.managed.includes(rule));
        if(extra.length)this.store.addRouteGroup({name:'AdGuard: пользовательские правила',routeId:'block',entries:[],dnsRules:extra});
        this.store.saveFilterRuleState({...state,dnsImported:true,managed:[...new Set([...state.managed,...extra])],managedFilters:filters});
        this.store.db.exec('COMMIT');
      }catch(error){this.store.db.exec('ROLLBACK');throw error;}
    }
  }
  async migrateSubscriptions(){
    const groups=this.store.routeGroups(),legacy=groups.filter(group=>group.dnsFilters?.length);
    if(!legacy.length)return;
    const settings=this.store.adGuardSettings() || await this.filter.configuration?.() || {};
    const subscriptions=[...(settings.subscriptions || []),...legacy.flatMap(group=>group.dnsFilters.map(source=>({...source,enabled:group.enabled!==false})))];
    this.store.db.exec('BEGIN IMMEDIATE');
    try{this.store.saveAdGuardSettings({...settings,subscriptions});for(const group of legacy){if(!group.entries.length && !group.dnsRules.length)this.store.removeRouteGroup(group.id);else this.store.db.prepare('UPDATE route_groups SET dns_policy=? WHERE id=?').run(JSON.stringify({dnsFilters:[],dnsRules:group.dnsRules}),group.id);}this.store.db.exec('COMMIT');}catch(error){this.store.db.exec('ROLLBACK');throw error;}
  }
  load() {return this.#run(async()=>{await this.#import();await this.migrateSubscriptions();});}
  mutate(action){return this.#run(async()=>{await this.#import();await this.migrateSubscriptions();return action();});}
  change(action,{apply}={}) {return this.#run(async()=>{
    await this.#import();await this.migrateSubscriptions();
    const beforeState=this.store.filterRuleState();
    const tables=['route_groups','local_routes','adguard_settings','device_routes','static_leases'];
    const beforeSubscriptions=this.store.adGuardSettings()?.subscriptions || [];
    const snapshot=tables.map(table=>({table,rows:this.store.db.prepare('SELECT * FROM '+table).all()}));
    let attemptedRules=[],attemptedFilters=[],runtimeChanged=false,applyStarted=false;
    try{
    const result=await action();
    await this.migrateSubscriptions();
    if(this.#available() && this.filter.reconcileUserRules) {
      const state=this.store.filterRuleState();
      const groups=this.store.routeGroups().filter(group=>group.enabled!==false && group.routeId==='block');
      const desired=[...new Set(groups.flatMap(group=>[...groupDnsEntries(group).map(domainRule).filter(Boolean),...(group.dnsRules || [])]))];
      for(const {alias,target} of this.store.localRoutes().filter(route=>route.enabled!==false)) {
        // CIDR routes describe networks, not individual DNS answers.
        if(target.includes('/'))continue;
        const type=isIP(target)===4?'A':isIP(target)===6?'AAAA':'CNAME';
        desired.push(`${domainRule('full:'+alias)}$dnsrewrite=NOERROR;${type};${target}`);
      }
      const subscriptions=this.store.adGuardSettings()?.subscriptions || [];
      attemptedRules=desired;attemptedFilters=subscriptions.map(source=>source.url);runtimeChanged=true;
      if(this.filter.reconcileFilters)await this.filter.reconcileFilters(state.managedFilters || [],subscriptions);
      await this.filter.reconcileUserRules(state.managed,desired);
      this.store.saveFilterRuleState({...state,managed:desired,managedFilters:[...new Set(subscriptions.map(source=>source.url))]});
    }
    if(apply){applyStarted=true;await apply();}
    return result;
    }catch(error){
      this.store.db.exec('BEGIN IMMEDIATE');
      try{
        for(const {table,rows} of snapshot){this.store.db.exec('DELETE FROM '+table);for(const row of rows){const keys=Object.keys(row);this.store.db.prepare('INSERT INTO '+table+' ('+keys.join(',')+') VALUES ('+keys.map(()=>'?').join(',')+')').run(...keys.map(key=>row[key]));}}
        this.store.saveFilterRuleState(beforeState);this.store.db.exec('COMMIT');
      }catch(restoreError){this.store.db.exec('ROLLBACK');throw restoreError;}
      if(runtimeChanged){
        try{
          const previous=beforeSubscriptions;
          if(this.filter.reconcileFilters)await this.filter.reconcileFilters([...new Set([...(beforeState.managedFilters || []),...attemptedFilters])],previous);
          await this.filter.reconcileUserRules([...new Set([...beforeState.managed,...attemptedRules])],beforeState.managed);
        }catch{throw Error("Could not apply the DNS policy. Check AdGuard Home availability and save again.");}
      }
      if(applyStarted)try{await apply();}catch{throw Error('Could not restore routing after a failed change. Check the routing engine and retry.');}
      throw error;
    }
  });}
}
