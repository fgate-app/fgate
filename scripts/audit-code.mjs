import {readdirSync,readFileSync} from 'node:fs';
import {join,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {babelParse,parse as parseVue} from '@vue/compiler-sfc';

const cyrillic=/[А-Яа-яЁё]/u;
const ignored=new Set(['vendor','node_modules','bin','__pycache__']);
function filesAt(root){return readdirSync(root,{withFileTypes:true}).flatMap(entry=>ignored.has(entry.name)?[]:entry.isDirectory()?filesAt(join(root,entry.name)):[join(root,entry.name)]);}
function canonical(value){
 if(Array.isArray(value))return value.map(canonical);
 if(!value || typeof value!=='object')return value;
 return Object.fromEntries(Object.entries(value).filter(([key])=>!['loc','start','end','extra','id','comments','leadingComments','trailingComments','innerComments'].includes(key)).map(([key,item])=>[key,canonical(item)]));
}
function messageContext(node){
 return node.type==='ThrowStatement'
  || node.type==='NewExpression' && /Error$/.test(node.callee?.name || '')
  || node.type==='ObjectProperty' && ['error','message','reason'].includes(node.key?.name)
  || node.type==='AssignmentExpression' && ['error','message'].includes(node.left?.property?.name)
  || node.type==='CallExpression' && (node.callee?.object?.name==='console' || ['fail','failure','reportError'].includes(node.callee?.name));
}
export function auditCode(root=process.cwd()){
 const messages=[],unusedImports=[],unusedBindings=[],functions=new Map();let files=0;
 for(const folder of ['server','shared','scripts','web/src'])for(const path of filesAt(join(root,folder))){
  if(!/\.(?:js|mjs|vue|py|sh|go)$/.test(path))continue;
  const file=relative(root,path),raw=readFileSync(path,'utf8');files++;
  if(!/\.(?:js|mjs|vue)$/.test(path)){
   for(const [index,line]of raw.split('\n').entries())if(cyrillic.test(line) && /^\s*(?:raise\s|(?:print|logging\.(?:error|warning))\s*\()/.test(line))messages.push({file,line:index+1});
   continue;
  }
  const descriptor=path.endsWith('.vue')?parseVue(raw,{filename:path}).descriptor:null;
  const source=descriptor?(descriptor.scriptSetup || descriptor.script)?.content || '':raw;
  const template=descriptor?.template?.content || '';
  const ast=babelParse(source,{sourceType:'module'}),refs=new Map(),imports=[];
  function walk(node,parents=[]){
   if(!node || typeof node!=='object')return;
   if(Array.isArray(node)){for(const child of node)walk(child,parents);return;}
   if(node.type==='ImportDeclaration'){for(const item of node.specifiers)imports.push({name:item.local.name,line:item.loc.start.line});return;}
   if(node.type==='Identifier')refs.set(node.name,(refs.get(node.name)||0)+1);
   if(['StringLiteral','TemplateElement','RegExpLiteral'].includes(node.type) && cyrillic.test(node.pattern ?? node.value?.raw ?? node.value) && parents.some(messageContext)
      && !parents.some(parent=>parent.type==='CallExpression' && ['t','translate'].includes(parent.callee?.name)))messages.push({file,line:node.loc.start.line});
   if(['FunctionDeclaration','FunctionExpression','ArrowFunctionExpression'].includes(node.type) && node.body?.type==='BlockStatement' && node.end-node.start>170){
    const key=createHash('sha256').update(JSON.stringify(canonical(node.body))).digest('hex');
    const group=functions.get(key)||[];group.push({file,line:node.loc.start.line});functions.set(key,group);
   }
   for(const[key,value]of Object.entries(node))if(!['loc','extra','comments','leadingComments','trailingComments','innerComments'].includes(key) && value && typeof value==='object')walk(value,[...parents,node]);
  }
  walk(ast);
  for(const binding of imports)if(!refs.has(binding.name) && !new RegExp('\\b'+binding.name+'\\b').test(template))unusedImports.push({file,...binding});
  for(const node of ast.program.body)if(node.type==='VariableDeclaration')for(const declaration of node.declarations){
   if(declaration.id.type!=='Identifier')continue;
   const name=declaration.id.name;
   if(refs.get(name)===1 && !new RegExp('\\b'+name+'\\b').test(template))unusedBindings.push({file,line:declaration.loc.start.line,name});
  }
 }
 return {files,messages,unusedImports,unusedBindings,duplicates:[...functions.values()].filter(group=>group.length>1)};
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 const result=auditCode();console.log(JSON.stringify(result,null,2));
 if(result.messages.length || result.unusedImports.length || result.unusedBindings.length || result.duplicates.length)process.exitCode=1;
}
