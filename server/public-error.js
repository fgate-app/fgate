// Only deliberate application failures may be returned to clients. Platform,
// command and network exceptions can contain paths, credentials or stderr.
export class PublicError extends Error {}
export function publicErrorMessage(error,fallback) {
 return error instanceof PublicError?error.message:fallback;
}
