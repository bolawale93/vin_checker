// Fetch wrapper. All state-changing requests carry the custom header required
// by the server's CSRF guard. Cookies are HttpOnly; no tokens are stored in JS.
export class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

let onAuthLost = () => {};
let onMustChangePassword = () => {};
export function setAuthHandlers(handlers) {
  onAuthLost = handlers.onAuthLost || onAuthLost;
  onMustChangePassword = handlers.onMustChangePassword || onMustChangePassword;
}

export async function api(method, url, body) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { 'X-Requested-With': 'vin-checker', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
  } catch {
    throw new ApiError('Cannot reach the VIN Checker server. Check your network connection.', 0);
  }
  let data = null;
  if ((res.headers.get('content-type') || '').includes('application/json')) data = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 && !url.startsWith('/api/auth/login')) onAuthLost();
    if (res.status === 403 && data?.code === 'MUST_CHANGE_PASSWORD') onMustChangePassword();
    throw new ApiError(data?.error || `Request failed (HTTP ${res.status}).`, res.status, data);
  }
  return data;
}

export const get = (url) => api('GET', url);
export const post = (url, body = {}) => api('POST', url, body);
export const put = (url, body = {}) => api('PUT', url, body);
export const patch = (url, body = {}) => api('PATCH', url, body);
export const del = (url) => api('DELETE', url);

export function qs(params) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== '' && v != null) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
}

/** Download a file via fetch so server errors can be shown instead of navigating away. */
export async function download(url, fallbackName) {
  const res = await fetch(url, { credentials: 'same-origin' });
  if (!res.ok) {
    let msg = `Download failed (HTTP ${res.status}).`;
    try { msg = (await res.json()).error || msg; } catch { /* not JSON */ }
    if (res.status === 401) onAuthLost();
    throw new ApiError(msg, res.status);
  }
  const blob = await res.blob();
  const cd = res.headers.get('content-disposition') || '';
  const name = /filename="([^"]+)"/.exec(cd)?.[1] || fallbackName;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
}
