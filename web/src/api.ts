// Calls to the server (src/app.ts). URLs are relative ("api/..."), so the page works under any path prefix.
// Every answer is { result } or { error }; a login guard in front may add { unlock: <sign-in page URL> }.

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public unlock?: string,
  ) {
    super(message);
  }
}

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  let data: any;
  try {
    data = await res.json();
  } catch {
    throw new ApiError(`${res.status} ${res.statusText}`, res.status);
  }
  if (!res.ok || data.error) throw new ApiError(data.error || `${res.status} ${res.statusText}`, res.status, typeof data.unlock === 'string' ? data.unlock : undefined);
  return data.result as T;
}

export const get = <T>(url: string) => call<T>(url);

export const post = <T = unknown>(url: string, body: unknown = {}) =>
  call<T>(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

/** Fire and forget, survives the tab closing (pagehide). */
export const beacon = (url: string, body: unknown) =>
  void fetch(url, { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => undefined);
