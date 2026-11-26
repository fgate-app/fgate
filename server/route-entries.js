import {normalizeRouteEntry,routeEntrySelection} from '../shared/route-preset-entries.js';
import {isIP} from 'node:net';
import {createRouteValidation} from '../shared/route-validation.js';
export const {validRouteEntry,normalizeRouteEntries}=createRouteValidation(isIP);
export function mihomoRouteRule(entry,target){
 entry=normalizeRouteEntry(entry);
 if(entry.startsWith('exclude:'))throw Error('Exclusion entries must be compiled with their rule group.');
 if(entry.startsWith('full:'))return `DOMAIN,${entry.slice(5)},${target}`;
 if(entry.startsWith('regexp:'))return `DOMAIN-REGEX,${entry.slice(7)},${target}`;
 if(entry.startsWith('keyword:'))return `DOMAIN-KEYWORD,${entry.slice(8)},${target}`;
 const address=entry.split('/')[0],family=isIP(address);
 if(family)return `${family===6?'IP-CIDR6':'IP-CIDR'},${entry.includes('/')?entry:entry+'/'+(family===6?128:32)},${target}`;
 return `${entry.startsWith('*.')?'DOMAIN-WILDCARD':'DOMAIN-SUFFIX'},${entry},${target}`;
}
const escape=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
export function adguardDomainRule(entry){
 entry=normalizeRouteEntry(entry);
 if(entry.startsWith('exclude:'))return null;
 if(entry.startsWith('full:'))return '/^'+escape(entry.slice(5))+'$/';
 if(entry.startsWith('regexp:'))return '/'+entry.slice(7)+'/';
 if(entry.startsWith('keyword:'))return '/'+escape(entry.slice(8))+'/';
 if(isIP(entry) || entry.includes('/'))return null;
 return `||${entry}^`;
}

// Keep exclusions local to the preset: explicit manual or other preset rules
// remain independent, and a broad service suffix cannot swallow its trackers.
export function groupRouteRules(group,target){
 const manual=group.manualEntries ?? (group.presets?.length?[]:group.entries || []),selection=routeEntrySelection(manual,group.presets || []);
 const predicate=entries=>entries.length===1?mihomoRouteRule(entries[0],'').slice(0,-1):'OR,('+entries.map(entry=>'('+mihomoRouteRule(entry,'').slice(0,-1)+')').join(',')+')';
 const aggregate=matches=>matches.length===1?matches[0]:'OR,('+matches.map(match=>'('+match+')').join(',')+')';
 let rules;
 if(!group.presets?.some(preset=>preset.exclusions?.length))rules=selection.entries.map(entry=>mihomoRouteRule(entry,target));
 else{
  const result=new Set(manual.filter(entry=>!normalizeRouteEntry(entry).startsWith('exclude:')).map(entry=>mihomoRouteRule(entry,target)));
  for(const preset of group.presets){
   if(!preset.entries?.length)continue;
   if(preset.exclusions?.length)result.add(`AND,((${predicate(preset.entries)}),(NOT,((${predicate(preset.exclusions)})))),${target}`);
   else for(const entry of preset.entries)result.add(mihomoRouteRule(entry,target));
  }
  rules=[...result];
 }
 if(!selection.exclusions.length || !rules.length)return rules;
 const included=aggregate(rules.map(rule=>rule.slice(0,rule.lastIndexOf(','))));
 return [`AND,((${included}),(NOT,((${predicate(selection.exclusions)})))),${target}`];
}
export function groupDnsEntries(group){
 if(routeEntrySelection(group.manualEntries ?? group.entries ?? []).exclusions.length)return [];
 if(!group.presets?.some(preset=>preset.exclusions?.length))return group.entries || [];
 // DNS allow rules would override unrelated block groups. Restricted service
 // presets are enforced by mihomo instead; other DNS blocks remain independent.
 return [...new Set([...(group.manualEntries || []),...group.presets.filter(preset=>!preset.exclusions?.length).flatMap(preset=>preset.entries || [])])];
}
