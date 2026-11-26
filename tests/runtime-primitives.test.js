import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter,once} from 'node:events';
import {spawn} from 'node:child_process';
import dgram from 'node:dgram';
import {stopManagedProcess} from '../server/managed-process.js';
import {requestLoopbackDns} from '../server/loopback-dns.js';
import {PublicError,publicErrorMessage} from '../server/public-error.js';
import {formatMessage,messageParameters} from '../web/src/lib/i18n-format.js';

test('an exited managed child is not signalled by a stale escalation timer',async()=>{
 const child=new EventEmitter(),signals=[];child.kill=signal=>{signals.push(signal);child.emit('exit',0);};
 await stopManagedProcess(child,{timeout:10});await new Promise(resolve=>setTimeout(resolve,30));assert.deepEqual(signals,['SIGTERM']);
});
test('managed process termination escalates when a real child ignores SIGTERM',async()=>{
 const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});console.log('ready');setInterval(()=>{},1000)"],{stdio:['ignore','pipe','ignore']});
 const exited=once(child,'exit');await once(child.stdout,'data');await stopManagedProcess(child,{timeout:30});
 assert.equal((await exited)[1],'SIGKILL');
});
test('shared DNS transport returns a loopback response and bounds a silent peer',async()=>{
 const peer=dgram.createSocket('udp4');await new Promise(resolve=>peer.bind(0,'127.0.0.1',resolve));let reply=true;
 peer.on('message',(message,remote)=>{if(reply)peer.send(message,remote.port,remote.address);});
 try{const message=await requestLoopbackDns(peer.address().port,'test.example');assert.ok(Buffer.isBuffer(message));reply=false;assert.equal(await requestLoopbackDns(peer.address().port,'test.example',{timeout:20}),null);}finally{peer.close();}
});
test('only explicitly public operational errors are returned, regardless of their language',()=>{
 assert.equal(publicErrorMessage(new PublicError('Checksum mismatch.'),'Update failed.'),'Checksum mismatch.');
 for(const error of [Error('private command output'),Error('секретный путь'),Object.assign(Error('token'),{cmd:'private'})])assert.equal(publicErrorMessage(error,'Update failed.'),'Update failed.');
});
test('parameterized English messages localize without interpreting values or regex punctuation',()=>{
 const template='Invalid gateway "{name}" (port {port}).';const values=messageParameters(template,'Invalid gateway "example.com/$1" (port 443).');
 assert.deepEqual(values,{name:'example.com/$1',port:'443'});
 assert.equal(formatMessage('Некорректный шлюз «{name}» (порт {port}).',values),'Некорректный шлюз «example.com/$1» (порт 443).');
 assert.equal(messageParameters(template,'Invalid gateway "example.com" [port 443].'),null);
});
