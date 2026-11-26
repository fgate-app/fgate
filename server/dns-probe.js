import dgram from 'node:dgram';
import http2 from 'node:http2';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { randomInt } from 'node:crypto';
import { lookup } from 'node:dns/promises';

const CACHE_TTL = 30_000;
const cache = new Map();

export function buildQuery(name = 'example.com', type = 1, id = randomInt(0, 65536)) {
  const labels = name.split('.').map(label => Buffer.concat([Buffer.from([label.length]), Buffer.from(label)]));
  return Buffer.concat([
    Buffer.from([id >> 8, id & 0xff, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0]),
    ...labels,
    Buffer.from([0, 0, type, 0, 1]),
  ]);
}

export function parseRcode(payload) {
  return Buffer.isBuffer(payload) && payload.length >= 12 ? payload[3] & 15 : null;
}

function elapsed(started) {
  return Math.round(performance.now() - started);
}

function failure(started, protocol, error, rcode = null) {
  return { state: 'fail', ok: false, ms: elapsed(started), protocol, rcode, error };
}

function probeDoh(url, timeout, verify) {
  return new Promise(resolve => {
    const parsed = new URL(url);
    const host = parsed.hostname;
    const port = parsed.port ? Number(parsed.port) : 443;
    const path = parsed.pathname + parsed.search;
    const query = buildQuery();
    const started = performance.now();
    let settled = false;
    let socket = null;
    let client = null;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        client?.close();
      } catch {
        /* already closed */
      }
      try {
        socket?.destroy();
      } catch {
        /* already destroyed */
      }
      resolve(result);
    };
    const timer = setTimeout(() => finish(failure(started, 'doh', 'ETIMEDOUT')), timeout);
    const headers = {
      'content-type': 'application/dns-message',
      accept: 'application/dns-message',
      'content-length': query.length,
    };
    socket = tls.connect(
      {
        host,
        port,
        servername: net.isIP(host) === 0 ? host : undefined,
        ALPNProtocols: ['h2', 'http/1.1'],
        rejectUnauthorized: verify !== false,
        timeout,
      },
      () => {
        // RFC 8484 recommends HTTP/2; Quad9, for example, answers 505 to HTTP/1.1.
        if (socket.alpnProtocol === 'h2') {
          client = http2.connect(parsed.origin, { createConnection: () => socket });
          client.on('error', error => finish(failure(started, 'doh', error.code || error.message)));
          const request = client.request({ ':method': 'POST', ':path': path, ...headers });
          let status = 0;
          const chunks = [];
          request.on('response', responseHeaders => {
            status = responseHeaders[':status'];
          });
          request.on('data', chunk => chunks.push(chunk));
          request.on('end', () => {
            const body = Buffer.concat(chunks);
            const rcode = parseRcode(body);
            if (status === 200 && rcode === 0) finish({ state: 'ok', ok: true, ms: elapsed(started), protocol: 'doh', rcode });
            else finish(failure(started, 'doh', status !== 200 ? `HTTP ${status}` : `DNS rcode ${rcode}`, rcode));
          });
          request.on('error', error => finish(failure(started, 'doh', error.code || error.message)));
          request.end(query);
          return;
        }
        // Server negotiated HTTP/1.1: open a normal request on a fresh socket.
        socket.destroy();
        socket = null;
        const request = https.request(
          { host, port, path, method: 'POST', agent: false, timeout, rejectUnauthorized: verify !== false, headers },
          response => {
            const chunks = [];
            response.on('data', chunk => chunks.push(chunk));
            response.on('end', () => {
              const body = Buffer.concat(chunks);
              const rcode = parseRcode(body);
              if (response.statusCode === 200 && rcode === 0) finish({ state: 'ok', ok: true, ms: elapsed(started), protocol: 'doh', rcode });
              else finish(failure(started, 'doh', response.statusCode !== 200 ? `HTTP ${response.statusCode}` : `DNS rcode ${rcode}`, rcode));
            });
          },
        );
        request.on('timeout', () => request.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
        request.on('error', error => finish(failure(started, 'doh', error.code || error.message)));
        request.end(query);
      },
    );
    socket.on('timeout', () => finish(failure(started, 'doh', 'ETIMEDOUT')));
    socket.on('error', error => finish(failure(started, 'doh', error.code || error.message)));
  });
}

function probeDot(url, timeout, verify) {
  return new Promise(resolve => {
    const started = performance.now();
    const parsed = new URL(url);
    const host = parsed.hostname;
    const port = parsed.port ? Number(parsed.port) : 853;
    const query = buildQuery();
    const frame = Buffer.alloc(2 + query.length);
    frame.writeUInt16BE(query.length, 0);
    query.copy(frame, 2);
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const socket = tls.connect(
      { host, port, timeout, rejectUnauthorized: verify !== false, ...(net.isIP(host) === 0 ? { servername: host } : {}) },
      () => socket.write(frame),
    );
    let buffer = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 2) return;
      const length = buffer.readUInt16BE(0);
      if (buffer.length < 2 + length) return;
      const rcode = parseRcode(buffer.subarray(2, 2 + length));
      socket.end();
      if (rcode === 0) finish({ state: 'ok', ok: true, ms: elapsed(started), protocol: 'dot', rcode });
      else finish(failure(started, 'dot', `DNS rcode ${rcode}`, rcode));
    });
    socket.on('timeout', () => {
      socket.destroy();
      finish(failure(started, 'dot', 'ETIMEDOUT'));
    });
    socket.on('error', error => finish(failure(started, 'dot', error.code || error.message)));
  });
}

function probeTcp(url, timeout) {
  return new Promise(resolve => {
    const started = performance.now();
    const parsed = new URL(url);
    const host = parsed.hostname;
    const port = parsed.port ? Number(parsed.port) : 53;
    const query = buildQuery();
    const frame = Buffer.alloc(2 + query.length);
    frame.writeUInt16BE(query.length, 0);
    query.copy(frame, 2);
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const socket = net.connect({ host, port, timeout }, () => socket.write(frame));
    let buffer = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 2) return;
      const length = buffer.readUInt16BE(0);
      if (buffer.length < 2 + length) return;
      const rcode = parseRcode(buffer.subarray(2, 2 + length));
      socket.end();
      if (rcode === 0) finish({ state: 'ok', ok: true, ms: elapsed(started), protocol: 'tcp', rcode });
      else finish(failure(started, 'tcp', `DNS rcode ${rcode}`, rcode));
    });
    socket.on('timeout', () => {
      socket.destroy();
      finish(failure(started, 'tcp', 'ETIMEDOUT'));
    });
    socket.on('error', error => finish(failure(started, 'tcp', error.code || error.message)));
  });
}

async function probeUdp(url, timeout) {
  const started = performance.now();
  const parsed = new URL(url);
  const port = parsed.port ? Number(parsed.port) : 53;
  let host = parsed.hostname;
  if (net.isIP(host) === 0) {
    try {
      host = (await lookup(host)).address;
    } catch {
      return failure(started, 'udp', 'ENOTFOUND');
    }
  }
  return new Promise(resolve => {
    const socket = dgram.createSocket(net.isIP(host) === 6 ? 'udp6' : 'udp4');
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        /* already closed */
      }
      resolve(result);
    };
    const timer = setTimeout(() => finish(failure(started, 'udp', 'ETIMEDOUT')), timeout);
    socket.on('message', message => {
      const rcode = parseRcode(message);
      if (rcode === 0) finish({ state: 'ok', ok: true, ms: elapsed(started), protocol: 'udp', rcode });
      else finish(failure(started, 'udp', `DNS rcode ${rcode}`, rcode));
    });
    socket.on('error', error => finish(failure(started, 'udp', error.code || error.message)));
    socket.send(buildQuery(), port, host, error => {
      if (error) finish(failure(started, 'udp', error.code || error.message));
    });
  });
}

// Probes one resolver entry. `verify` exists for offline tests only; the HTTP
// layer never forwards it from a client request.
export async function probe(url, { timeout = 4000, verify = true } = {}) {
  const value = String(url);
  if (value === 'system' || value.startsWith('dhcp://')) {
    return { state: 'unsupported', ok: false, protocol: 'system', error: "The system resolver cannot be checked" };
  }
  if (value.startsWith('quic://')) {
    return { state: 'unsupported', ok: false, protocol: 'quic', error: "DoQ cannot be checked without a QUIC client" };
  }
  if (!value.includes('://')) {
    // Bootstrap entries are plain IPs; mihomo queries them over UDP/53.
    const address = net.isIP(value) === 6 ? `[${value}]` : value;
    return probeUdp(`udp://${address}`, timeout);
  }
  if (value.startsWith('https://')) return probeDoh(value, timeout, verify);
  if (value.startsWith('tls://')) return probeDot(value, timeout, verify);
  if (value.startsWith('tcp://')) return probeTcp(value, timeout);
  if (value.startsWith('udp://')) return probeUdp(value, timeout);
  return { state: 'unsupported', ok: false, protocol: 'unknown', error: "Unknown resolver type" };
}

async function mapLimit(items, limit, worker) {
  let index = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const current = items[index++];
      await worker(current);
    }
  });
  await Promise.all(runners);
}

export function clearProbeCache() {
  cache.clear();
}

export async function statusesFor(urls, { timeout = 4000, refresh = false } = {}) {
  const unique = [...new Set(urls.filter(Boolean))];
  const pending = unique.filter(url => refresh || !cache.has(url) || Date.now() - cache.get(url).at > CACHE_TTL);
  await mapLimit(pending, 6, async url => {
    const result = await probe(url, { timeout });
    cache.set(url, { at: Date.now(), result });
  });
  const statuses = {};
  for (const url of unique) {
    const hit = cache.get(url);
    statuses[url] = hit ? { ...hit.result, checkedAt: new Date(hit.at).toISOString() } : { state: 'unknown', ok: false };
  }
  return statuses;
}

// Minimal A/AAAA parser for readiness checks (answers may be compressed).
export function parseAddresses(payload) {
  if (!Buffer.isBuffer(payload) || payload.length < 12) return [];
  const skip = offset => {
    while (payload[offset]) {
      if (payload[offset] & 0xc0) return offset + 2;
      offset += payload[offset] + 1;
    }
    return offset + 1;
  };
  let offset = 12;
  for (let index = 0; index < (payload[4] << 8 | payload[5]); index += 1) offset = skip(offset) + 4;
  const addresses = [];
  for (let index = 0; index < (payload[6] << 8 | payload[7]); index += 1) {
    offset = skip(offset);
    if (offset + 10 > payload.length) break;
    const type = payload[offset] << 8 | payload[offset + 1];
    const length = payload[offset + 8] << 8 | payload[offset + 9];
    offset += 10;
    if (offset + length > payload.length) break;
    if (type === 1 && length === 4) addresses.push([...payload.subarray(offset, offset + 4)].join('.'));
    if (type === 28 && length === 16) {
      const groups = [];
      for (let part = 0; part < 16; part += 2) groups.push(payload.readUInt16BE(offset + part).toString(16));
      addresses.push(groups.join(':'));
    }
    offset += length;
  }
  return addresses;
}
