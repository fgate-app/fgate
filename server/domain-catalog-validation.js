import {presetId,PRESET_LIMIT} from './metacube-catalog.js';
import {validRouteEntry} from './route-entries.js';

const object=value=>value!==null && typeof value==='object' && !Array.isArray(value);
const entries=value=>Array.isArray(value) && value.length<=PRESET_LIMIT && value.every(entry=>typeof entry==='string' && !entry.startsWith('exclude:') && validRouteEntry(entry));

// Disk caches and portable backups must accept the same catalogue structure.
export function validDomainCatalog(value){
 if(!object(value) || ![3,4,5].includes(value.version) || !Array.isArray(value.presets) || !value.presets.length || value.presets.length>10000 || !object(value.lists))return false;
 const ids=new Set();
 for(const preset of value.presets){
  if(!object(preset) || typeof preset.id!=='string' || !presetId.test(preset.id) || ids.has(preset.id) || !Object.hasOwn(value.lists,preset.id) || !entries(value.lists[preset.id]))return false;
  if(preset.exclusions!==undefined && !entries(preset.exclusions))return false;
  if(preset.label!==undefined && typeof preset.label!=='string')return false;
  ids.add(preset.id);
 }
 return true;
}
