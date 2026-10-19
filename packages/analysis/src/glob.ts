/**
 * Minimal, dependency-free glob matcher used for path, command and host patterns.
 *
 * Path mode (`/` is a segment separator):
 *   `**`  any number of path segments (including zero)
 *   `*`   any characters within one segment
 *   `?`   one character within a segment
 *   `{a,b}` alternatives (no nesting)
 * Text mode (commands, hosts): `*` matches any characters including `/` and spaces; `?` one character.
 *
 * Patterns are compiled to anchored RegExps and cached. Matching is case-sensitive unless `caseFold` is set.
 */
// One cache per (mode, caseFold): avoids building a composite key string on every match (hot path: ~100 glob tests
// per observation from sensitivity, noise and policy matching).
const caches = { path0: new Map<string, RegExp>(), path1: new Map<string, RegExp>(), text0: new Map<string, RegExp>(), text1: new Map<string, RegExp>() };

function escapeRe(ch: string): string {
  return /[\\^$.*+?()[\]{}|/]/.test(ch) ? "\\" + ch : ch;
}

function compile(pattern: string, mode: "path" | "text", caseFold: boolean): RegExp {
  const cache = mode === "path" ? (caseFold ? caches.path1 : caches.path0) : caseFold ? caches.text1 : caches.text0;
  const key = pattern;
  const hit = cache.get(key);
  if (hit) return hit;
  let re = "";
  let i = 0;
  let inBrace = false;
  while (i < pattern.length) {
    const c = pattern[i]!;
    if (mode === "path" && c === "*" && pattern[i + 1] === "*") {
      const prevSlash = i === 0 || pattern[i - 1] === "/";
      const nextSlash = pattern[i + 2] === "/";
      const atEnd = i + 2 === pattern.length;
      if (prevSlash && nextSlash) {
        re += "(?:[^/]*/)*"; // "**/" : zero or more whole segments
        i += 3;
        continue;
      }
      if (prevSlash && atEnd) {
        re += ".*"; // trailing "/**" : everything below
        i += 2;
        continue;
      }
      re += "[^/]*"; // "**" glued to other chars behaves like "*"
      i += 2;
      continue;
    }
    if (c === "*") {
      re += mode === "path" ? "[^/]*" : ".*";
    } else if (c === "?") {
      re += mode === "path" ? "[^/]" : ".";
    } else if (c === "{" && !inBrace) {
      re += "(?:";
      inBrace = true;
    } else if (c === "}" && inBrace) {
      re += ")";
      inBrace = false;
    } else if (c === "," && inBrace) {
      re += "|";
    } else {
      re += escapeRe(c);
    }
    i++;
  }
  if (inBrace) re += ")";
  const compiled = new RegExp("^" + re + "$", caseFold ? "is" : "s");
  cache.set(key, compiled);
  return compiled;
}

export function globMatchPath(pattern: string, path: string, caseFold = false): boolean {
  return compile(pattern, "path", caseFold).test(path);
}

export function globMatchText(pattern: string, text: string, caseFold = false): boolean {
  return compile(pattern, "text", caseFold).test(text);
}
