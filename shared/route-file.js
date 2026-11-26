import {uniqueRouteEntries} from './route-preset-entries.js';
// Plain upstream-style rules: comments and attributes are metadata, not rules.
export function parseRouteFile(text,normalize){
 if(typeof text!=='string' || text.length>2*1024*1024)throw Error('The rule file is too large.');
 const rules=[];
 for(const raw of text.replace(/^\uFEFF/,'').split(/\r?\n/)){
  const line=raw.split('#')[0].trim();if(!line)continue;
  const [entry,...attributes]=line.split(/\s+/);
  if(entry.startsWith('include:'))throw Error('Choose a preset to import included lists.');
  if(attributes.some(value=>!/^[@&][a-zA-Z0-9_!-]+$/.test(value)))throw Error('The rule file contains invalid records.');
  rules.push(entry);
  if(rules.length>50000)throw Error('Specify no more than 50000 addresses.');
 }
 if(!rules.length)throw Error('The rule file is empty.');
 try{return uniqueRouteEntries(normalize(rules));}catch{throw Error('The rule file contains invalid records.');}
}
