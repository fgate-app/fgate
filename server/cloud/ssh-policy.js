import {createPrivateKey,createPublicKey,randomBytes} from 'node:crypto';
// Shared wire validation; only device-generated Ed25519 public keys are accepted.
export const cloudSshGroup='freedomgate-cloud-ssh';
export const cloudSshUser=id=>'fg'+id.replaceAll('-','').slice(0,30);
export function validEd25519Key(value){
 if(typeof value!=='string' || value.length>128)return false;
 const match=/^ssh-ed25519 ([A-Za-z0-9+/]+={0,2})$/.exec(value);if(!match)return false;
 const b=Buffer.from(match[1],'base64');
 return b.length===51 && b.readUInt32BE(0)===11 && b.subarray(4,15).toString()==='ssh-ed25519' && b.readUInt32BE(15)===32 && b.toString('base64')===match[1];
}
export function validCloudSsh(value,id){return !!value && value.username===cloudSshUser(id) && Number.isInteger(value.port) && value.port>0 && value.port<=65535 && validEd25519Key(value.hostKey);}
export function cloudAuthorizedKey(row){
 if(!validEd25519Key(row.sshPublicKey) || !Number.isInteger(row.transportPort) || row.transportPort<1024 || row.transportPort>65535)throw Error('Invalid cloud SSH authorization');
 return `restrict,port-forwarding,command="/usr/sbin/nologin",permitopen="127.0.0.1:${row.transportPort}",permitopen="127.0.0.1:7443" ${row.sshPublicKey}\n`;
}

// Independent per-device key. Only its public part is registered on the cloud.
export function generateCloudSshIdentity(){
 const seed=randomBytes(32);
 const privateKey=createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),seed]),format:'der',type:'pkcs8'});
 const pub=Buffer.from(createPublicKey(privateKey).export({format:'jwk'}).x,'base64url');
 const u32=value=>{const b=Buffer.alloc(4);b.writeUInt32BE(value);return b;};
 const string=value=>{const b=Buffer.isBuffer(value)?value:Buffer.from(value);return Buffer.concat([u32(b.length),b]);};
 const wire=Buffer.concat([string('ssh-ed25519'),string(pub)]),check=randomBytes(4);
 let block=Buffer.concat([check,check,string('ssh-ed25519'),string(pub),string(Buffer.concat([seed,pub])),string('freedomgate-cloud')]);
 const padding=8-block.length%8;block=Buffer.concat([block,Buffer.from(Array.from({length:padding},(_,i)=>i+1))]);
 const encoded=Buffer.concat([Buffer.from('openssh-key-v1\0'),string('none'),string('none'),string(''),u32(1),string(wire),string(block)]).toString('base64').match(/.{1,70}/g).join('\n');
 return {publicKey:'ssh-ed25519 '+wire.toString('base64'),privateKey:'-----BEGIN OPENSSH PRIVATE KEY-----\n'+encoded+'\n-----END OPENSSH PRIVATE KEY-----\n'};
}
export function cloudAuthorizedKeys(row){
 return row.sshPublicKey?cloudAuthorizedKey(row):'';
}

export const cloudSshPort=2222;
// A separate forwarding-only daemon; the administrative sshd is untouched.
export const cloudSshdConfig=`Port ${cloudSshPort}
ListenAddress 0.0.0.0
HostKey /etc/ssh/ssh_host_ed25519_key
PidFile /run/freedomgate-cloud-ssh/sshd.pid
UsePAM yes
PermitRootLogin no
AllowGroups ${cloudSshGroup}
AuthenticationMethods publickey
PubkeyAuthentication yes
PasswordAuthentication no
KbdInteractiveAuthentication no
AuthorizedKeysFile /etc/freedomgate-cloud/ssh-authorized-keys/%u
AllowTcpForwarding local
AllowStreamLocalForwarding no
AllowAgentForwarding no
X11Forwarding no
PermitTTY no
PermitTunnel no
PermitUserRC no
MaxSessions 0
MaxAuthTries 3
LoginGraceTime 15
ClientAliveInterval 10
ClientAliveCountMax 3
`;
