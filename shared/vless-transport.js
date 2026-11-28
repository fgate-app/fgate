import {vlessEncryption} from './vless-encryption.js';
// Transport compatibility shared by URI/JSON import and the manual form.
export function validateVlessTransport({network='tcp',security='none',flow='',encryption='none'}={}) {
  vlessEncryption(encryption);
  if(!['tcp','raw','ws','grpc','httpupgrade','xhttp','splithttp'].includes(network))throw Error('This Xray transport is not supported yet.');
  if(!['none','tls','reality'].includes(security))throw Error('Choose none, TLS or REALITY security.');
  if(security==='reality' && ['ws','httpupgrade'].includes(network))throw Error('REALITY requires TCP, RAW, gRPC or XHTTP transport.');
  if(flow && !['xtls-rprx-vision','xtls-rprx-vision-udp443'].includes(flow))throw Error('This VLESS flow is not supported.');
  if(flow && encryption==='none' && (!['tcp','raw'].includes(network) || security==='none'))throw Error('Vision requires TCP or RAW with TLS or REALITY when VLESS encryption is disabled.');
}
