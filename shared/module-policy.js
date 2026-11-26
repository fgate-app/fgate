// These binaries are part of the application release, never independent updates.
export const releaseManagedModuleIds=Object.freeze(['system','outline','tor','lantern']);
export const isReleaseManagedModule=id=>releaseManagedModuleIds.includes(id);
