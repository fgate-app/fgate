// Independent from the web/helper lifecycle. Only a private helper-created job is accepted.
import {runSystemUpdate} from '../server/system-update-job.js';
const work=process.argv[2];
if(!/^\/opt\/freedomgate\/module-updates\/system-work-[a-f0-9-]+$/.test(work||''))throw Error('Invalid system update workspace.');
await runSystemUpdate({work});
