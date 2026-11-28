// Return only recipient metadata, never message text, attachments or user payloads.
export function telegramChats(updates){
 if(!Array.isArray(updates))throw Error('Invalid Telegram updates');
 const chats=new Map();
 for(const update of updates.slice(0,100)){
  const member=update?.my_chat_member;
  if(Number.isSafeInteger(member?.chat?.id) && ['left','kicked'].includes(member?.new_chat_member?.status)){chats.delete(String(member.chat.id));continue;}
  const chat=update?.message?.chat || update?.channel_post?.chat || (['member','administrator','creator'].includes(member?.new_chat_member?.status)?member.chat:null);
  if(!chat || !Number.isSafeInteger(chat.id) || !['private','group','supergroup','channel'].includes(chat.type))continue;
  const id=String(chat.id),name=typeof chat.title==='string'?chat.title:[chat.first_name,chat.last_name].filter(x=>typeof x==='string').join(' ');
  chats.set(id,{id,type:chat.type,name:name.replace(/[\x00-\x1f\x7f]/g,' ').slice(0,120)});
 }
 return [...chats.values()];
}
