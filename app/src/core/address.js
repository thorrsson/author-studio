// Server addresses as people type them, such as "localhost:11434" or
// "http://192.168.1.20:1234/v1". Shared by the main process and the renderer.

// The scheme, host, and port of an address, or '' if it is not a web address.
// A saved API key is only ever sent to the origin it was entered for.
export function addressOrigin(value) {
  let text = String(value ?? '').trim();
  if (!text) return '';
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `http://${text}`;
  try {
    const url = new URL(text);
    return /^https?:$/.test(url.protocol) ? url.origin : '';
  } catch {
    return '';
  }
}
