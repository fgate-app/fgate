export const torDefaults=Object.freeze({mode:'snowflake',connectTimeout:120,retries:2,retryDelay:30});
export function normalizeTorSettings(value={}){
 if(!value || typeof value!=='object' || Array.isArray(value))throw Error('Invalid Tor settings.');
 const next={...torDefaults,...value};
 if(!['auto','snowflake'].includes(next.mode) || !Number.isInteger(next.connectTimeout) || next.connectTimeout<30 || next.connectTimeout>300 || !Number.isInteger(next.retries) || next.retries<0 || next.retries>5 || !Number.isInteger(next.retryDelay) || next.retryDelay<10 || next.retryDelay>300)throw Error('Invalid Tor settings.');
 return Object.fromEntries(Object.keys(torDefaults).map(key=>[key,next[key]]));
}
export const torLabels={stopped:'Tor is stopped.',connecting:'Connecting to Tor.',ready:'Tor is connected.',waiting:'Waiting before retrying Tor.',failed:'Tor could not connect.',unavailable:'Install the Tor module before enabling this gateway.'};
