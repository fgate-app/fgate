import snapshot from './network-architecture-current.json' with {type:'json'};
import {buildNetworkArchitectureLayout} from '../lib/network-architecture-layout.js';

// Frozen anonymized capture for Storybook; the application uses live data.
export function currentNetworkSnapshot(){return structuredClone(snapshot);}
export function currentNetworkArchitecture(){return buildNetworkArchitectureLayout(currentNetworkSnapshot());}
export const prototypeNetworkArchitecture=buildNetworkArchitectureLayout;
