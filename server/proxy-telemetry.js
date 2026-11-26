// Never expose controller responses: they contain destinations, client addresses and credentials.
export function createTelemetryCollector(request, {now = Date.now, cacheMs = 1000} = {}) {
  let previous = new Map(), sampledAt = 0, cached = null, pending = null;
  return async (profiles, groups) => {
    if (pending) return pending;
    if (cached && now() - sampledAt < cacheMs) return cached;
    pending = (async () => {
      const [snapshot, registry] = await Promise.all([request('/connections'), request('/proxies')]);
      const time = now(), elapsed = sampledAt ? (time - sampledAt) / 1000 : 0;
      const proxies = registry.proxies || {};
      const tags = new Map(profiles.map(profile => [profile.engine === 'direct' ? 'DIRECT' : `p-${profile.id.slice(0,8)}-grp`, profile.id]));
      const groupTags = new Map(groups.map(group => [`cg-${group.id}`, group.id]));
      const latency = tag => {
        const proxy = proxies[tag];
        const last = proxy?.history?.at(-1);
        const httpHistory=(proxy?.history || []).slice(-24).filter(sample=>typeof sample.time==='string' && Number.isFinite(Date.parse(sample.time))).map(sample=>({time:sample.time,delay:sample.delay>0?sample.delay:null}));
        return proxy?.alive !== false && last?.delay > 0 ? {httpHistory,ping: last.delay, measuredAt: last.time,httpStatus:'ok'} : {httpHistory,ping: null, measuredAt: last?.time || null,httpStatus:last?'error':'unmeasured'};
      };
      const result = {available: true, sampledAt: new Date(time).toISOString(), profiles: {}, groups: {}};
      for (const [tag, id] of tags) result.profiles[id] = {available: !!proxies[tag] && proxies[tag].now !== 'REJECT', ...latency(tag), upload: elapsed ? 0 : null, download: elapsed ? 0 : null};
      for (const [tag, id] of groupTags) {
        let selected=proxies[tag]?.now;
        const visited=new Set([tag]);
        while(selected && !tags.has(selected) && !visited.has(selected)){
          visited.add(selected);selected=proxies[selected]?.now;
        }
        const measured = latency(selected);
        result.groups[id] = {selectedId: tags.get(selected) || null, ...measured};
      }
      const current = new Map();
      for (const connection of snapshot.connections || []) {
        const upload = Math.max(0, Number(connection.upload) || 0), download = Math.max(0, Number(connection.download) || 0);
        current.set(connection.id, {upload, download});
        const old = previous.get(connection.id);
        const chain = connection.chains || [];
        const tag = chain.find(value => tags.has(value));
        const id = tags.get(tag) || (chain.some(value => value.startsWith('zapret-')) ? profiles.find(profile => profile.engine === 'zapret')?.id : null);
        const target = result.profiles[id];
        if (!target || !elapsed) continue;
        target.upload += Math.max(0, upload - (old?.upload || 0)) / elapsed;
        target.download += Math.max(0, download - (old?.download || 0)) / elapsed;
      }
      previous = current;
      sampledAt = time;
      cached = result;
      return result;
    })();
    try {return await pending;} finally {pending = null;}
  };
}
