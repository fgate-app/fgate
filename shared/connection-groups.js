// Members stay as references in storage/UI; runtime expansion is deterministic
// and deduplicates gateways reached through more than one group.
export function connectionGroupContains(groups,groupId,memberId){
 const byId=new Map(groups.map(group=>[group.id,group])),seen=new Set(),pending=[groupId];
 while(pending.length){const id=pending.pop();if(id===memberId)return true;if(seen.has(id))continue;seen.add(id);for(const member of byId.get(id)?.members || [])pending.push(member);}
 return false;
}
export function expandConnectionGroup(groups,groupId,{rejectCycles=false}={}){
 const byId=new Map(groups.map(group=>[group.id,group])),active=new Set(),done=new Set(),leaves=new Set(),stack=[{id:groupId,exit:false}];
 while(stack.length){const {id,exit}=stack.pop(),group=byId.get(id);if(!group){leaves.add(id);continue;}if(exit){active.delete(id);done.add(id);continue;}if(active.has(id)){if(rejectCycles)throw Error('Gateway groups cannot contain cycles.');return [];}if(done.has(id))continue;active.add(id);stack.push({id,exit:true});for(const member of [...group.members].reverse())stack.push({id:member,exit:false});}
 return [...leaves];
}
