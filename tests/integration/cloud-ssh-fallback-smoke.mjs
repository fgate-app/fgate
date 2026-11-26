// Operator-only: keeps the existing device credential inside the service account.
// Arguments: staged release directory and a private service-owned test directory.
import fs from 'node:fs';import https from 'node:https';import {spawn} from 'node:child_process';import {DatabaseSync} from 'node:sqlite';
const root=process.argv[2],dir=process.argv[3];
const {AccessPointRepository}=await import(root+'/server/access-points/repository.js'),{managedSshCapability,enrollManaged}=await import(root+'/server/access-points/managed.js'),{startCloudSsh}=await import(root+'/server/access-points/cloud-ssh.js'),{execute}=await import(root+'/server/access-points/ssh.js');
const db=new DatabaseSync('/var/lib/freedomgate/freedomgate.sqlite',{readOnly:true});
// Read through the existing repository without running schema initialization.
const repo=Object.assign(Object.create(AccessPointRepository.prototype),{db,stateDir:'/var/lib/freedomgate',table:'access_points'});const p=repo.get('freedomgate-cloud');db.close();p.secrets.cloudSsh=managedSshCapability(p);
let args;const tunnel=await startCloudSsh(p,{stateDir:dir,spawnProcess:(b,a,o)=>{args=a;return spawn(b,a,o);}});
try{
 const status=await new Promise((resolve,reject)=>{const agent=new https.Agent();agent.createConnection=options=>https.globalAgent.createConnection({...options,host:'127.0.0.1',port:tunnel.enrollmentPort,servername:'',checkServerIdentity:(_n,cert)=>{const tls=process.getBuiltinModule('node:tls');return tls.checkServerIdentity(p.host,cert);}});const req=https.get('https://'+p.host+':7443/',{agent,timeout:4000},res=>{res.resume();res.once('end',()=>{agent.destroy();resolve(res.statusCode);});});req.once('error',e=>{agent.destroy();reject(e)});req.on('timeout',()=>req.destroy(Error('TLS timed out')));});
 const base=[];for(let i=0;i<args.length;i++){if(args[i]==='-L'){i++;continue;}if(args[i]!=='-N')base.push(args[i]);}
 const shell=await execute('ssh',[...base,'id'],{timeout:10000});const foreign=await execute('ssh',[...base.slice(0,-1),'-W','127.0.0.1:22',base.at(-1)],{timeout:10000});
 const remote=await execute('ssh',[...base.slice(0,-1),'-N','-R','127.0.0.1:0:127.0.0.1:22',base.at(-1)],{timeout:10000});
 const {generateCloudSshIdentity}=await import(root+'/server/cloud/ssh-policy.js');const wrongHosts=dir+'/wrong-hosts';fs.writeFileSync(wrongHosts,'freedomgate-cloud '+generateCloudSshIdentity().publicKey+'\n',{mode:0o600});
 const mismatch=await execute('ssh',[...base.map(a=>a.startsWith('UserKnownHostsFile=')?'UserKnownHostsFile='+wrongHosts:a),'id'],{timeout:10000});
 const enrollmentPaths=[];const enrollment=await enrollManaged(p,{gateways:[],onAttempt:e=>{if(e.state==='completed')enrollmentPaths.push(e.transport);}});
 const result={remoteForwardDenied:remote.code!==0&&/remote port forwarding failed/i.test(remote.error),hostKeyMismatchDenied:mismatch.code!==0&&/HOST IDENTIFICATION HAS CHANGED|Host key verification failed/i.test(mismatch.error),enrollmentPaths,tokenUnchanged:enrollment.token===p.secrets.token,sshAuthenticated:true,pinnedHttpsStatus:status,shellDenied:shell.code!==0&&/administratively prohibited|session request failed|open failed/i.test(shell.error),unrelatedPortDenied:foreign.code!==0&&/administratively prohibited/i.test(foreign.error)};
 console.log(JSON.stringify(result));if(status!==404 || !result.shellDenied || !result.unrelatedPortDenied || !result.remoteForwardDenied || !result.hostKeyMismatchDenied || !result.tokenUnchanged)process.exitCode=1;
}finally{await tunnel.close();}
