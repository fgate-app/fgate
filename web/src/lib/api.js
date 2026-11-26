import {readDiagnosticStream} from './diagnostic-stream.js';
import {formatMessage} from './i18n-format.js';
// Read the session at request time so login/logout never leave a stale CSRF token.
export function createApiClient({ getSession, onUnauthorized, onResponse, translate = formatMessage, fetch: request = globalThis.fetch }) {
  const message=text=>{
    for(const [prefix,template,key] of [
      ['mihomo rejected the configuration: ','mihomo rejected the configuration: {detail}','detail'],
      ['DNS resolvers returned code ','DNS resolvers returned code {code}','code'],
      ['mihomo exited (','mihomo exited ({reason})','reason'],
    ])if(text.startsWith(prefix))return translate(template,{[key]:key==='reason'?text.slice(prefix.length).replace(/\)$/,''):text.slice(prefix.length)});
    return translate(text);
  };
  return async function api(path, options = {}) {
    const {onDiagnosticEvent,...requestOptions}=options;
    const headers = new Headers(options.headers);
    if(onDiagnosticEvent)headers.set('Accept','application/x-ndjson');
    if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    const session = getSession();
    if (session?.csrf) headers.set('X-CSRF-Token', session.csrf);
    const response = await request('/api/' + path, { ...requestOptions, headers });
    if(response.status===401 && getSession()?.user)onUnauthorized?.();
    if(response.ok && onDiagnosticEvent && response.headers.get('Content-Type')?.includes('application/x-ndjson')){
      const data=await readDiagnosticStream(response,onDiagnosticEvent,{translate,signal:options.signal});
      onResponse?.(data);return data;
    }
    let data;
    try { data = await response.json(); }
    catch {
      throw new Error(response.ok?translate('Could not read the server response.'):translate('Server error: HTTP {status}',{status:response.status}));
    }
    if (!response.ok) {
      const failure = new Error(typeof data?.error==='string' && data.error?message(data.error):translate('Server error: HTTP {status}',{status:response.status}));
      failure.data = data;
      throw failure;
    }
    onResponse?.(data);
    return data;
  };
}
