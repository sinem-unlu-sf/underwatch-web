/** Minimal HTTP seam so tests can capture every outbound request and simulate failures without a network. */
export interface HttpRequest {
  method: "GET" | "POST";
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export interface HttpResponse {
  status: number;
  /** Lower-cased header names. */
  headers: Record<string, string>;
  body: string;
}

/** Throws only for transport-level failure (DNS, refused, reset, abort). HTTP error statuses are returned, not thrown. */
export type HttpTransport = (req: HttpRequest, signal: AbortSignal) => Promise<HttpResponse>;

export const fetchTransport: HttpTransport = async (req, signal) => {
  const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body ?? null, signal, redirect: "error" });
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    headers[k.toLowerCase()] = v;
  });
  return { status: res.status, headers, body: await res.text() };
};

export class TimeoutError extends Error {
  constructor(ms: number) {
    super(`request timed out after ${ms} ms`);
    this.name = "TimeoutError";
  }
}

/**
 * Run one request with a hard deadline. The deadline wins even if the transport ignores the abort signal.
 * Caller cancellation (outer signal) is propagated.
 */
export async function requestWithTimeout(transport: HttpTransport, req: HttpRequest, timeoutMs: number, outer?: AbortSignal): Promise<HttpResponse> {
  const ac = new AbortController();
  const onAbort = () => ac.abort(outer?.reason);
  if (outer) {
    if (outer.aborted) throw outer.reason instanceof Error ? outer.reason : new Error("aborted");
    outer.addEventListener("abort", onAbort, { once: true });
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ac.abort(new TimeoutError(timeoutMs));
      reject(new TimeoutError(timeoutMs));
    }, timeoutMs);
  });
  try {
    return await Promise.race([transport(req, ac.signal), deadline]);
  } finally {
    if (timer) clearTimeout(timer);
    outer?.removeEventListener("abort", onAbort);
  }
}

/** Retry-After as milliseconds: delta-seconds or an HTTP date. Null when absent or unparseable. */
export function parseRetryAfter(value: string | undefined, now = Date.now()): number | null {
  if (!value) return null;
  const v = value.trim();
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(parseFloat(v) * 1000);
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : Math.max(0, t - now);
}
