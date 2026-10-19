import { useCallback } from "react";
import { useSearchParams } from "react-router";

/** URL search params as the single source of truth for page filters, so filtered views are linkable. */
export function useUrlFilters() {
  const [params, setParams] = useSearchParams();

  const get = useCallback((key: string): string | undefined => params.get(key) ?? undefined, [params]);

  /** Set (or with undefined/"" remove) keys. Changing any filter other than offset resets pagination. */
  const set = useCallback(
    (patch: Record<string, string | undefined>, opts?: { replace?: boolean }) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [k, v] of Object.entries(patch)) {
            if (v === undefined || v === "") next.delete(k);
            else next.set(k, v);
          }
          if (!("offset" in patch)) next.delete("offset");
          return next;
        },
        { replace: opts?.replace ?? false },
      );
    },
    [setParams],
  );

  const clear = useCallback((keys: string[]) => set(Object.fromEntries(keys.map((k) => [k, undefined]))), [set]);

  return { params, get, set, clear };
}

/** Returns the value only if it is one of the allowed enum options; protects queries from hand-edited URLs. */
export function pickEnum<T extends string>(value: string | undefined, options: readonly T[]): T | undefined {
  return value !== undefined && (options as readonly string[]).includes(value) ? (value as T) : undefined;
}
