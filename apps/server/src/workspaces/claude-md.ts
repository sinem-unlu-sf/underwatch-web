/**
 * Pure CLAUDE.md editing logic (no I/O): minimal block insertion, duplicate + contradiction detection, unified diff.
 * Everything outside the inserted block is preserved byte-for-byte. CLAUDE.md content is untrusted text: it is only
 * compared and copied, never interpreted.
 */
import { structuredPatch } from "diff";
import { claudeMdBlockMarkers, mergeClaudeMdBlock, normalizeInstruction } from "@kw/schema";

export const KW_SECTION_HEADING = "## Underwatch safeguards";
const SECTION_RE = /^## Underwatch safeguards[ \t]*\r?$/m;
const MARKER_PREFIX = "<!-- underwatch:safeguard ";
/** Pre-rename marker prefix; existing CLAUDE.md files may still contain it. */
const LEGACY_MARKER_PREFIX = "<!-- kernel-witness:safeguard ";
const hasMarker = (s: string) => s.includes(MARKER_PREFIX) || s.includes(LEGACY_MARKER_PREFIX);

export interface Contradiction {
  line_number: number;
  line: string;
  reason: string;
}

function blockText(safeguardId: string, content: string): string {
  const { begin, end } = claudeMdBlockMarkers(safeguardId);
  return `${begin}\n${content.replace(/\r\n/g, "\n").trim()}\n${end}\n`;
}

/** True when the content would break block parsing (it must not contain Underwatch markers). */
export function containsMarker(content: string): boolean {
  return hasMarker(content);
}

/**
 * Inserts (or replaces) this safeguard's managed block:
 * - an existing block for the same safeguard is replaced in place (re-version);
 * - else the block goes at the end of an existing "## Underwatch safeguards" section;
 * - else that section is appended at the end of the file (after one blank line).
 */
export function mergeManagedBlock(before: string | null, safeguardId: string, content: string): string {
  const { begin, end } = claudeMdBlockMarkers(safeguardId);
  if (before !== null) {
    const start = before.indexOf(begin);
    if (start !== -1 && before.indexOf(end, start) !== -1) return mergeClaudeMdBlock(before, safeguardId, content);
  }
  const block = blockText(safeguardId, content);
  if (before === null || before.length === 0) return `${KW_SECTION_HEADING}\n\n${block}`;

  const heading = SECTION_RE.exec(before);
  if (heading) {
    const afterHeading = before.indexOf("\n", heading.index);
    let insertAt = before.length;
    if (afterHeading !== -1) {
      const next = /^#{1,2}[ \t]/m.exec(before.slice(afterHeading + 1));
      if (next) insertAt = afterHeading + 1 + next.index;
    }
    let head = before.slice(0, insertAt);
    const tail = before.slice(insertAt);
    if (!head.endsWith("\n")) head += "\n";
    if (!head.endsWith("\n\n")) head += "\n";
    return tail.length > 0 ? `${head}${block}\n${tail}` : `${head}${block}`;
  }
  const base = before.endsWith("\n") ? before : `${before}\n`;
  return `${base}\n${KW_SECTION_HEADING}\n\n${block}`;
}

/** Removes this safeguard's own managed block (so re-versions are not reported as duplicates of themselves). */
function withoutOwnBlock(text: string, safeguardId: string): string {
  const { begin, end } = claudeMdBlockMarkers(safeguardId);
  const start = text.indexOf(begin);
  const stop = start === -1 ? -1 : text.indexOf(end, start);
  return start === -1 || stop === -1 ? text : text.slice(0, start) + text.slice(stop + end.length);
}

/**
 * Returns the existing line(s) that already state the instruction (normalized: case, whitespace and bullets ignored),
 * or null. Underwatch blocks of OTHER safeguards count as existing text.
 */
export function findDuplicate(before: string | null, safeguardId: string, content: string): string | null {
  if (before === null) return null;
  const needle = normalizeInstruction(content);
  if (needle.length === 0) return null;
  const text = withoutOwnBlock(before, safeguardId);
  if (!normalizeInstruction(text).includes(needle)) return null;
  const lines = text.split("\n");
  for (const line of lines) {
    const n = normalizeInstruction(line);
    if (n.length > 0 && !hasMarker(line) && (n.includes(needle) || needle.startsWith(n))) return line.trim();
  }
  return "existing CLAUDE.md text (spread over several lines)";
}

const PERMISSIVE = /\b(allowed|allow|allows|may|can|ok|okay|fine|permitted|feel free|is safe)\b/i;
const NEGATION = /\b(not|never|no|don't|do not|cannot|can't|must not|mustn't|avoid|forbidden|prohibited|refuse)\b/i;

/** Path-like or backticked targets an instruction talks about, e.g. ".env", "secrets/", "secrets/token.txt". */
export function instructionTargets(content: string): string[] {
  const out = new Set<string>();
  for (const m of content.matchAll(/`([^`\n]{2,80})`/g)) out.add(m[1]!.trim().toLowerCase());
  for (const m of content.matchAll(/(?:^|[\s("'])((?:~\/)?\.?[A-Za-z0-9_*-]*[./][A-Za-z0-9_./*-]+)/g)) {
    const t = m[1]!.replace(/[.,;:]+$/, "").toLowerCase();
    if (t.length >= 2 && /[./]/.test(t) && !/^\.+$/.test(t) && !t.includes("://")) out.add(t);
  }
  return [...out].filter((t) => t.length >= 2);
}

/**
 * Simple contradiction heuristic: when the new instruction is restrictive, flags existing lines (outside Kernel
 * Witness blocks) that use permissive wording without negation and mention one of the same targets.
 */
export function findContradictions(before: string | null, content: string): Contradiction[] {
  if (before === null || !NEGATION.test(content)) return [];
  const targets = instructionTargets(content);
  if (targets.length === 0) return [];
  const found: Contradiction[] = [];
  let inBlock = false;
  before.split("\n").forEach((line, i) => {
    if (hasMarker(line)) {
      inBlock = line.includes(" BEGIN -->");
      return;
    }
    if (inBlock || !PERMISSIVE.test(line) || NEGATION.test(line)) return;
    const lower = line.toLowerCase();
    const hit = targets.find((t) => lower.includes(t));
    if (hit) {
      found.push({
        line_number: i + 1,
        line: line.trim().slice(0, 500),
        reason: `This existing line appears to allow "${hit}", which the new instruction restricts. Underwatch does not edit it; review it yourself.`,
      });
    }
  });
  return found;
}

/** Unified diff with git-style headers (a/<rel>, b/<rel>; /dev/null for a new file), applicable with `git apply`. */
export function unifiedDiff(relPath: string, before: string | null, after: string): string {
  if (before !== null && before === after) return "";
  const patch = structuredPatch(`a/${relPath}`, `b/${relPath}`, before ?? "", after, "", "", { context: 3 });
  const out: string[] = [`diff --git a/${relPath} b/${relPath}`];
  if (before === null) out.push("new file mode 100644");
  out.push(before === null ? "--- /dev/null" : `--- a/${relPath}`, `+++ b/${relPath}`);
  for (const h of patch.hunks) {
    const oldStart = h.oldLines === 0 ? Math.max(0, h.oldStart - 1) : h.oldStart;
    const newStart = h.newLines === 0 ? Math.max(0, h.newStart - 1) : h.newStart;
    out.push(`@@ -${oldStart},${h.oldLines} +${newStart},${h.newLines} @@`);
    out.push(...h.lines);
  }
  return `${out.join("\n")}\n`;
}
