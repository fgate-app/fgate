export function formatBinaryBytes(value) {
 const units=['B','KB','MB','GB','TB'];let index=0;
 while(value>=1024 && index<units.length-1){value/=1024;index++;}
 return value.toFixed(index?1:0)+' '+units[index];
}
