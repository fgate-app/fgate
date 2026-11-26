import {createHmac} from 'node:crypto';
export const accessUsername=(pointId,clientId)=>'fg-ap:'+pointId+':'+clientId;
export const accessPassword=(server,client)=>createHmac('sha256',server.secrets.token || server.secrets.credential).update(client.id).digest('hex');
export const policyUsers=servers=>servers.flatMap(server=>server.clients.filter(client=>client.enabled).map(client=>({username:accessUsername(server.id,client.id),password:accessPassword(server,client)})));
