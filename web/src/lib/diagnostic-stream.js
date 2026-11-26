// One bounded JSON object per line. Missing final result must never look like success.
export async function readDiagnosticStream(response,onEvent,{translate=text=>text,signal}={}){
 const reader=response.body?.getReader();if(!reader)throw Error(translate('Could not read the server response.'));
 const decoder=new TextDecoder();let buffer='',result=null,finished=false;
 const accept=line=>{
  if(!line.trim())return;
  let event;try{event=JSON.parse(line);}catch{throw Error(translate('Could not read the server response.'));}
  if(!event || typeof event!=='object')throw Error(translate('Could not read the server response.'));
  if(finished)throw Error(translate('Could not read the server response.'));
  if(event.type==='error')throw Error(translate(event.error || 'Failed to run gateway diagnostics.'));
  if(event.type==='result'){if(!event.report || typeof event.report!=='object')throw Error(translate('Could not read the server response.'));result=event.report;finished=true;}
  else if(event.type!=='progress')throw Error(translate('Could not read the server response.'));
  onEvent(event);
 };
 try{
  while(true){
   if(signal?.aborted)throw new DOMException('Diagnostic cancelled.','AbortError');
   const {done,value}=await reader.read();buffer+=decoder.decode(value,{stream:!done});
   if(buffer.length>4*1024*1024)throw Error(translate('Could not read the server response.'));
   let newline;while((newline=buffer.indexOf('\n'))!==-1){const line=buffer.slice(0,newline);buffer=buffer.slice(newline+1);accept(line);}
   if(done){if(buffer.trim())accept(buffer);break;}
  }
  if(!finished)throw Error(translate('The diagnostic connection was interrupted. Completed checks have been kept.'));
  return result;
 }finally{try{await reader.cancel();}catch{}reader.releaseLock();}
}
