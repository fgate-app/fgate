export const OUTLINE_DPI_MARK=0x10000007;
export const OUTLINE_DPI_TABLE='freedomgate_outline_dpi';
export const OUTLINE_DPI_PRIORITY='1801';
export function outlineDpiArgs({binary,lua,pidfile,queue=299}){
 return [binary,`--qnum=${queue}`,'--daemon',`--pidfile=${pidfile}`,'--fwmark=0x40000000','--bind-fix4','--bind-fix6','--user=root',`--lua-init=@${lua}/zapret-lib.lua`,`--lua-init=@${lua}/zapret-antidpi.lua`,
  '--filter-mark=0x10000007/0xffffffff','--filter-tcp=1-65535','--reasm-disable','--out-range=-d10','--payload=all','--lua-desync=multidisorder:pos=1:payload=all'];
}
export function outlineDpiNft(uid,queue=299){
 if(!Number.isInteger(uid)||uid<1||!Number.isInteger(queue)||queue<1||queue>65535)throw new Error("Invalid DPI bypass parameters.");
 return `table inet ${OUTLINE_DPI_TABLE} {
 chain postrouting {
  type filter hook postrouting priority 100; policy accept;
  oifname "lo" return
  meta skuid ${uid} meta mark 0x10000007 meta l4proto tcp counter queue num ${queue} bypass
 }
}\n`;
}
