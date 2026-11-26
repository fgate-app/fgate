// Interpolate after choosing the translation; values are plain text, never HTML.
export function formatMessage(template,parameters={}) {
  return typeof template==='string'?template.replace(/\{(\w+)\}/g,(placeholder,key)=>Object.hasOwn(parameters,key)?String(parameters[key]):placeholder):template;
}

// Match an English parameterized server message before translating it. Only
// templates from the bundled dictionary are patterns; user values stay text.
const messagePatterns=new Map();
export function messageParameters(template,value) {
 if(typeof value!=='string' || !template.includes('{'))return null;
 let pattern=messagePatterns.get(template);
 if(!pattern){
  const keys=[];let previous=0,source='^';
  const escape=text=>text.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  for(const match of template.matchAll(/\{(\w+)\}/g)){source+=escape(template.slice(previous,match.index))+'(.*?)';keys.push(match[1]);previous=match.index+match[0].length;}
  source+=escape(template.slice(previous))+'$';pattern={expression:new RegExp(source),keys};messagePatterns.set(template,pattern);
 }
 const match=pattern.expression.exec(value);
 return match?Object.fromEntries(pattern.keys.map((key,index)=>[key,match[index+1]])):null;
}
