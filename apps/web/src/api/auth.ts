/**
 * Local API token handling. The server may require `Authorization: Bearer <token>` (AuthCheckResponse mode "token").
 * The token arrives once via the link the server prints (`?token=...`), is stored in localStorage under "kw.token",
 * and is stripped from the address bar immediately so it does not linger in history or get copied with the URL.
 * Every storage access is wrapped: private windows or blocked storage must not break the app.
 */

export const TOKEN_STORAGE_KEY = "kw.token";
const TOKEN_EVENT = "kw:token-changed";

export function getToken(): string | null {
  try {
    const t = window.localStorage.getItem(TOKEN_STORAGE_KEY);
    return t && t.trim().length > 0 ? t.trim() : null;
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  try {
    if (token && token.trim().length > 0) window.localStorage.setItem(TOKEN_STORAGE_KEY, token.trim());
    else window.localStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    // storage unavailable: the token simply is not remembered
  }
  try {
    window.dispatchEvent(new Event(TOKEN_EVENT));
  } catch {
    // non-browser environment
  }
}

export function onTokenChange(cb: () => void): () => void {
  window.addEventListener(TOKEN_EVENT, cb);
  return () => window.removeEventListener(TOKEN_EVENT, cb);
}

/** Reads ?token= from the current URL, stores it, and removes it from the address bar. Returns true when one was found. */
export function captureTokenFromUrl(loc: Location = window.location, hist: History = window.history): boolean {
  let url: URL;
  try {
    url = new URL(loc.href);
  } catch {
    return false;
  }
  const token = url.searchParams.get("token");
  if (token === null) return false;
  url.searchParams.delete("token");
  if (token.trim().length > 0) setToken(token);
  try {
    hist.replaceState(hist.state, "", `${url.pathname}${url.search}${url.hash}`);
  } catch {
    // ignore: worst case the token stays visible in the address bar
  }
  return token.trim().length > 0;
}

export function authHeaders(): Record<string, string> {
  const t = getToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
}
