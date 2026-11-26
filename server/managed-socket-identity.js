import {readFile,readdir,readlink,stat} from 'node:fs/promises';

const started=raw=>raw.slice(raw.lastIndexOf(')')+1).trim().split(/\s+/)[19];
// The web service can inspect its own children. The root helper deliberately
// lacks CAP_SYS_PTRACE and therefore cannot enumerate their socket links.
export async function managedSocketIdentity(pid,{root='/proc',uid=process.getuid?.()}={}) {
  if(!Number.isInteger(pid) || pid<2)throw Error('Invalid managed process');
  const path=`${root}/${pid}`;
  if((await stat(path)).uid!==uid)throw Error('Foreign process');
  const before=started(await readFile(path+'/stat','utf8'));
  if(!/^\d+$/.test(before || ''))throw Error('Invalid process identity');
  const files=await readdir(path+'/fd');
  if(files.length>4096)throw Error('Too many process descriptors');
  const links=await Promise.allSettled(files.map(fd=>readlink(path+'/fd/'+fd)));
  const inodes=[...new Set(links.filter(row=>row.status==='fulfilled').map(row=>/^socket:\[(\d+)\]$/.exec(row.value)?.[1]).filter(Boolean))];
  if(inodes.length>1024 || started(await readFile(path+'/stat','utf8'))!==before)throw Error('Process identity changed');
  return {processStartedAt:before,inodes};
}
