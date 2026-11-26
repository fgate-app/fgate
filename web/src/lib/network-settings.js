export {normalizeNetworkSetup as normalizeNetworkSettings} from '../../../shared/network.js';
import {normalizeNetworkSetup as normalizeNetworkSettings} from '../../../shared/network.js';

export function networkResponse(data, previous = {}) {
  return {
    setup: normalizeNetworkSettings(data.setup ?? previous.setup),
    interfaces: Array.isArray(data.interfaces) ? data.interfaces : previous.interfaces ?? [],
    plan: Array.isArray(data.plan) ? data.plan : previous.plan ?? [],
    warnings: Array.isArray(data.warnings) ? data.warnings : Array.isArray(data.setup?.warnings) ? data.setup.warnings : []
  };
}
