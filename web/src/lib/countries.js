// ISO 3166-1 alpha-2: resolve legacy provider names before formatting the UI.
const codes=new Set('AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'.split(' '));
const key=value=>String(value || '').normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
let names;
function countryNames(){
 if(names)return names;
 names=new Map();
 for(const locale of ['en','ru','zh-CN']){
  const display=new Intl.DisplayNames([locale],{type:'region'});
  for(const code of codes)names.set(key(display.of(code)),code);
 }
 for(const [name,code] of Object.entries({'Russian Federation':'RU','Российская Федерация':'RU','The Netherlands':'NL','Holland':'NL','United States of America':'US','USA':'US','США':'US','United Kingdom of Great Britain and Northern Ireland':'GB','UK':'GB','Republic of Korea':'KR','Korea, Republic of':'KR','Viet Nam':'VN','Czech Republic':'CZ'}))names.set(key(name),code);
 return names;
}
export function resolveCountryCode(location){
 for(const value of [location?.countryCode,location?.country_code,location?.country]){
  const code=String(value || '').trim().toUpperCase();if(codes.has(code))return code;
 }
 return countryNames().get(key(location?.country)) || '';
}
