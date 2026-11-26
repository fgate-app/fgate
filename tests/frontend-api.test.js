import test from 'node:test';
import assert from 'node:assert/strict';
import { createApiClient } from '../web/src/lib/api.js';

test('API client reads current CSRF token and preserves request headers and cancellation', async () => {
  let session = { csrf: 'first' };
  const controller = new AbortController();
  const calls = [];
  const api = createApiClient({
    getSession: () => session,
    fetch: async (url, options) => {
      calls.push({ url, options });
      return Response.json({ ok: true });
    },
  });
  await api('settings', { method: 'PUT', body: '{}', headers: { Accept: 'application/json' }, signal: controller.signal });
  session = { csrf: 'second' };
  await api('clients');
  assert.equal(calls[0].url, '/api/settings');
  assert.equal(calls[0].options.headers.get('Accept'), 'application/json');
  assert.equal(calls[0].options.headers.get('X-CSRF-Token'), 'first');
  assert.equal(calls[0].options.signal, controller.signal);
  assert.equal(calls[1].options.headers.get('X-CSRF-Token'), 'second');
});

test('API client clears expired authenticated sessions and retains structured errors', async () => {
  let expired = 0;
  let session = { user: { id: 1 } };
  const data = { error: 'Session expired', engine: { state: 'error' } };
  const api = createApiClient({
    getSession: () => session,
    onUnauthorized: () => { expired++; session = null; },
    fetch: async () => Response.json(data, { status: 401 }),
  });
  await assert.rejects(api('dns'), failure => {
    assert.equal(failure.message, data.error);
    assert.deepEqual(failure.data, data);
    return true;
  });
  await assert.rejects(api('dns'));
  assert.equal(expired, 1);
});

test('API errors report HTTP status for non-JSON or missing error details',async()=>{
 const html=createApiClient({getSession:()=>null,fetch:async()=>new Response('<html>Bad Gateway</html>',{status:502})});
 await assert.rejects(html('settings'),/HTTP 502/);
 const empty=createApiClient({getSession:()=>null,fetch:async()=>Response.json({}, {status:400})});
 await assert.rejects(empty('settings'),/HTTP 400/);
});

test('API messages default to English and localize parameters without changing raw error data',async()=>{
 const {formatMessage}=await import('../web/src/lib/i18n-format.js');
 let locale='en';
 const dictionary={ru:{'mihomo did not open its DNS or proxy port':'mihomo не открыл DNS или прокси-порт','DNS resolvers returned code {code}':'DNS-резолверы ответили кодом {code}'}};
 let data={error:'mihomo did not open its DNS or proxy port'};
 const api=createApiClient({getSession:()=>null,translate:(key,params)=>formatMessage(dictionary[locale]?.[key] || key,params),fetch:async()=>Response.json(data,{status:503})});
 await assert.rejects(api('dns'),failure=>failure.message===data.error);
 locale='ru';await assert.rejects(api('dns'),failure=>{assert.equal(failure.message,'mihomo не открыл DNS или прокси-порт');assert.equal(failure.data.error,data.error);return true;});
 data={error:'DNS resolvers returned code 2'};await assert.rejects(api('dns'),/DNS-резолверы ответили кодом 2/);
 locale='zh-CN';await assert.rejects(api('dns'),/DNS resolvers returned code 2/);
 assert.equal(formatMessage('{detail}',{detail:'{untrusted}'}),'{untrusted}');
});
