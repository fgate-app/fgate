import {readFile,stat} from 'node:fs/promises';
import {resolve,extname} from 'node:path';

const securityHeaders={
  'X-Content-Type-Options':'nosniff',
  'Referrer-Policy':'same-origin'
};
const contentTypes={'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon','.webmanifest':'application/manifest+json; charset=utf-8'};

export class HttpError extends Error {
  constructor(status,message){super(message);this.status=status;}
}

export function sendJson(res,status,data){
  res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...securityHeaders});
  res.end(JSON.stringify(data));
}

export async function readJsonBody(req){
  if(!['POST','PUT'].includes(req.method))return {};
  const limit=req.url.startsWith('/api/configuration/')?90*1024*1024:req.url.startsWith('/api/routes/groups')?4*1024*1024:300000;
  const chunks=[];
  let size=0;
  for await(const chunk of req){
    const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);
    size+=bytes.length;
    if(size>limit)throw new HttpError(413,"Request is too large.");
    chunks.push(bytes);
  }
  try{
    const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if(!body || typeof body!=='object' || Array.isArray(body))throw Error();
    return body;
  }catch{throw new HttpError(400,"A JSON object is required.");}
}

export async function serveInterface(req,res,url,root){
  if(req.method!=='GET')throw new HttpError(405,"Method not supported.");
  let path=resolve(root,'.'+url.pathname);
  if(!path.startsWith(root+'/') && path!==root)throw new HttpError(403,"Invalid path.");
  try{if(!(await stat(path)).isFile())path=resolve(root,'index.html');}
  catch{path=resolve(root,'index.html');}
  const data=await readFile(path);
  res.writeHead(200,{'Content-Type':contentTypes[extname(path)] || 'application/octet-stream',...(extname(path)==='.html' || url.pathname==='/sw.js' || url.pathname==='/manifest.webmanifest'?{'Cache-Control':'no-cache'}:{}),...securityHeaders});
  res.end(data);
}
