// Run against an OFFLINE COPY of a database before starting a cloned appliance.
// Normal backup/restore must not run this tool: it preserves instance identity.
import {Store} from '../server/store.js';
import {AccessPointRepository} from '../server/access-points/repository.js';
import {managedPoint} from '../server/access-points/managed.js';
import {dirname,resolve} from 'node:path';
if(process.argv.length!==3){console.error('Usage: node scripts/clone-instance.mjs /absolute/path/to/copied/freedomgate.sqlite');process.exit(1);}
const path=resolve(process.argv[2]),store=new Store(path);
try{const repository=new AccessPointRepository(store.db,{stateDir:dirname(path)});repository.save(managedPoint());console.log('Clone identity created; cloud access is disabled.');}finally{store.close();}
