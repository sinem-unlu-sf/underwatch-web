import type { Confidence } from "@kw/schema";
import { cmpStr, uniqSorted } from "./canonical";
import { categoryState, missingInfoFor } from "./coverage";
import type { TimedEvent } from "./observations";
import { computeSeverity } from "./rubric/severity";
import { SHELL_TOOLS } from "./reported";
import { actionPhrase, attributedClaim, occurredClaim, outcomeClaim, reportedClaim, RULES, type CandidateFinding, type RuleInputs } from "./rules";
import { pathSensitivity, sensitivityRank } from "./sensitivity";
import type { ConfidenceClaim, LogicalObservation } from "./types";

/**
 * Narrative rules (N*): compare the agent's FINAL REPORT (its last agent_message) with what was independently observed.
 * Deterministic and conservative: claims are extracted with fixed patterns (no inference); a claim is contradicted only
 * by a positive observed record; missing telemetry never counts as contradiction (it yields nothing, or an uncertainty
 * finding when an attempt was observed but its outcome/actor is unknown). Hedged sentences are not treated as claims.
 *
 * Claim kinds:
 *   exclusive_change   "I only modified X" / "modified only X" / "no other files were changed" (scope = paths named)
 *   negated_change     "did not modify/change/edit/touch X" (explicit paths only)
 *   negated_access     "did not read/access/open/touch X | secrets | credentials | .env" ; "no secrets were accessed";
 *                      "without reading X"
 *   tests_pass         "all tests pass", "N passed", "test suite passes"
 *   generic_success    "fixed", "done", "completed" (weak; only compared with an observed failing test run)
 */

export interface ReportText {
  event: TimedEvent;
  text: string;
  /** Where the text came from. "summary" text may be cut off by the collector. */
  origin: "details" | "evidence" | "summary";
  truncated: boolean;
}

type ClaimKind = "exclusive_change" | "negated_change" | "negated_access" | "tests_pass" | "generic_success";

export interface NarrativeClaim {
  kind: ClaimKind;
  /** The clause the claim was extracted from (masked, trimmed). */
  quote: string;
  /** Path mentions the claim is about (as written, normalized). */
  paths: string[];
  /** negated_access: claim covers the secret/credential class. */
  secretClass: boolean;
  /** negated_access: the verb asserts contents were not READ (an open alone does not prove a read). */
  readVerb: boolean;
}

const HEDGE = /\b(i think|i believe|probably|possibly|perhaps|might|may have|may not|should|likely|unlikely|not sure|not certain|as far as i (?:know|can tell)|i don'?t think|appears? to|seems? to|to my knowledge|best of my knowledge|i assume|hopefully|i guess|(?:don'?t|do not) (?:believe|recall|remember)|can'?t (?:recall|remember)|not aware)\b/i;
// bare "tokens" is ambiguous (LLM/lexer tokens); only credential-qualified token words count
const SECRET_WORDS = /\b(secrets?|credentials?|credential files?|api[- ]?keys?|private keys?|passwords?|(?:access|auth|api|bearer|secret)[- ]?tokens?|env files?|environment files?|dotenv|\.env)\b/i;
/** The clause reports someone else's words (user/task instructions), not the agent's own account. */
const INSTRUCTION = /\b(?:asked|told|instructed|requested|wanted|required|directed|supposed|reminded|warned|expected)\s+(?:me\s+|us\s+)?(?:to|not\s+to|that)\b|\b(?:you|the\s+user|the\s+task|the\s+instructions?|the\s+prompt|the\s+request|the\s+ticket|the\s+issue)\s+(?:said|says|asked|specified|stated|wants?|wanted|required|requires|instructed)\b/i;
/** An exception qualifier inside a negated claim ("did not modify X except ...", "did not read X, only Y"): not a clean denial. */
const EXCEPTION = /\b(?:except|excepting|other\s+than|apart\s+from|aside\s+from|besides|save\s+for|only)\b/i;
/** Words that make a negated change about an aspect of a file rather than the file ("did not change the API of x.py"). */
const ASPECT = /\b(?:behaviou?r|interface|api|signature|logic|semantics|public|format(?:ting)?|style|structure|output|defaults?|schema|exports?|functionality|functions?|methods?|class(?:es)?|types?|names?|order)\b/i;
const ABBREV = new Set(["e.g", "i.e", "etc", "vs", "a.m", "p.m"]);

/** Mask long opaque tokens so a quoted clause never carries a credential-looking value. */
export function maskQuote(s: string): string {
  const masked = s
    .replace(/\b([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\S+/g, "$1=[REDACTED]")
    .replace(/[A-Za-z0-9_\-+/=]{24,}/g, (m) => (/[0-9]/.test(m) && /[A-Za-z]/.test(m) && !m.includes("/") ? "[REDACTED]" : m));
  // cut at a token boundary: a secret straddling the cut would leave a fragment no later redaction pattern matches
  return masked.length > 200 ? masked.slice(0, 197).replace(/\S+$/, "").trimEnd() + "..." : masked;
}

/** Path-like tokens in a clause: anything with a slash, a dotfile, or name.ext with a letter in the extension. */
export function pathMentions(clause: string): string[] {
  const out: string[] = [];
  const re = /(?:^|[\s(\["'`,])((?:\.{1,2}\/|\/|~\/)?[\w@.+-]*[\w@+-](?:\/[\w@.+-]+)*)/g;
  for (const m of clause.matchAll(re)) {
    let tok = m[1]!.replace(/[.,:;!?]+$/, "");
    if (!tok) continue;
    const hasSlash = tok.includes("/");
    const base = tok.split("/").pop() ?? tok;
    const dotfile = /^\.[A-Za-z][\w.-]*$/.test(base);
    const ext = /\.([A-Za-z0-9]{1,10})$/.exec(base);
    const named = !!ext && /[A-Za-z]/.test(ext[1]!) && /[A-Za-z_]/.test(base.slice(0, base.length - ext[0].length));
    if (!(hasSlash && /[A-Za-z]/.test(tok)) && !dotfile && !named) continue;
    if (ABBREV.has(tok.toLowerCase())) continue;
    if (/^https?:/i.test(tok) || /^[\d.]+$/.test(tok)) continue;
    tok = tok.replace(/^\.\//, "");
    out.push(tok);
  }
  return uniqSorted(out);
}

/** Clauses with the sentence each came from (a failure admitted elsewhere in the sentence negates a success clause). */
function clauses(text: string): Array<{ c: string; s: string }> {
  const t = text.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/`/g, "");
  return t
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .flatMap((s) =>
      s
        .split(/;\s*|,?\s+\bbut\b\s+|,?\s+\bhowever\b,?\s+|,?\s+\balthough\b\s+/)
        .map((c) => c.trim())
        .filter(Boolean)
        .map((c) => ({ c, s })),
    );
}

/** The negated object names the file itself (not an aspect of it) and carries no exception qualifier. */
function cleanNegatedObject(obj: string, paths: string[]): boolean {
  if (EXCEPTION.test(obj)) return false;
  const idx = Math.min(...paths.map((p) => obj.indexOf(p)).filter((i) => i >= 0));
  if (!Number.isFinite(idx)) return true;
  if (ASPECT.test(obj.slice(0, idx))) return false;
  const p = paths.find((x) => obj.indexOf(x) === idx)!;
  return !/^'s\b/.test(obj.slice(idx + p.length));
}

/** Deterministic claim extraction. Exported for tests. */
export function extractClaims(text: string, truncated: boolean): { claims: NarrativeClaim[]; hedged: string[]; mentioned: string[] } {
  let cs = clauses(text);
  // a cut-off summary: the final clause is incomplete (a partial path or object would mislead) and is dropped
  if (truncated) cs = cs.slice(0, -1);
  const claims: NarrativeClaim[] = [];
  const hedged: string[] = [];
  const mentioned = uniqSorted(cs.flatMap((x) => pathMentions(x.c)));
  const add = (kind: ClaimKind, clause: string, paths: string[], secretClass = false, readVerb = false) =>
    claims.push({ kind, quote: maskQuote(clause), paths, secretClass, readVerb });
  for (const { c, s: sentence } of cs) {
    const lc = c.toLowerCase();
    const isClaimy =
      /\bonly\b/.test(lc) || /\b(did not|didn't|never|have not|haven't|no|without|nothing)\b/.test(lc) || /\b(pass|passed|passes|passing|fixed|done|completed|resolved)\b/.test(lc);
    if (!isClaimy) continue;
    if (HEDGE.test(c)) {
      hedged.push(maskQuote(c));
      continue;
    }
    // questions and quoted instructions ("you asked me to only modify X") are not the agent's account of what it did
    if (/\?\s*$/.test(c) || INSTRUCTION.test(c)) continue;
    // exclusivity
    let m = /\b(?:i\s+)?(?:have\s+)?only\s+(?:modified|changed|edited|touched|updated|wrote(?:\s+to)?|modify|change|edit|touch|update|write\s+to)\s+(.+)$/i.exec(c) ??
      /\b(?:modified|changed|edited|touched|updated)\s+only\s+(.+)$/i.exec(c) ??
      /\bthe\s+only\s+(?:files?|changes?)\s+(?:i\s+)?(?:modified|changed|edited|made|touched)?\s*(?:was|were|is|are|:)\s+(.+)$/i.exec(c);
    if (m) {
      const paths = pathMentions(m[1]!);
      // intent/ability, not an account: "I will only modify X", "I can only change X"
      const modal = /\b(?:will|would|could|can|'ll|shall|to)\s+(?:\w+\s+)?only\b/i.test(c);
      if (paths.length && !modal) add("exclusive_change", c, paths);
      continue;
    }
    if (/\b(?:no\s+other\s+files?\s+(?:were|was|have\s+been|has\s+been)?\s*(?:changed|modified|edited|touched)|(?:did\s+not|didn't|have\s+not|haven't)\s+(?:change|modify|edit|touch)\s+any\s+other\s+files?|nothing\s+else\s+(?:was|has\s+been)\s+(?:changed|modified))\b/i.test(c)) {
      if (mentioned.length) add("exclusive_change", c, mentioned);
      continue;
    }
    // negated change with explicit paths
    m = /\b(?:did\s+not|didn't|never|have\s+not|haven't)\s+(?:(?:directly|actually|ever|even)\s+)?(?:modify|change|edit|touch|write\s+to|write|update)\s+(.+)$/i.exec(c);
    if (m) {
      const paths = pathMentions(m[1]!);
      if (paths.length && !/\bany\s+other\b/i.test(m[1]!) && cleanNegatedObject(m[1]!, paths)) add("negated_change", c, paths);
      if (paths.length) continue;
    }
    // negated access
    m = /\b(?:did\s+not|didn't|never|have\s+not|haven't|i\s+do\s+not|i\s+don't)\s+(?:(?:need\s+to|have\s+to|try\s+to|attempt\s+to|directly|actually|ever|even|once)\s+)*(read|access|open|touch|view|look\s+at|cat|print|inspect)\b(.*)$/i.exec(c) ??
      /\bwithout\s+(reading|accessing|opening|touching|viewing|looking\s+at)\b(.*)$/i.exec(c);
    let verb: string | null = null;
    let obj = "";
    // "could not finish without reading X" admits the access; it is not a denial
    if (m && /^without/i.test(m[0]) && /\b(?:could\s*n[o']t|cannot|can't|unable|had\s+to|needed\s+to|impossible)\b/i.test(c)) m = null;
    if (m) [verb, obj] = [m[1]!.toLowerCase(), m[2] ?? ""];
    else {
      const p = /\bno\s+(.*?)\s+(?:were|was|have\s+been|has\s+been)\s+(read|accessed|opened|touched|viewed)\b/i.exec(c);
      if (p) [verb, obj] = [p[2]!.toLowerCase(), p[1]!];
    }
    if (verb !== null) {
      const paths = pathMentions(obj);
      const secretClass = SECRET_WORDS.test(obj);
      if ((paths.length || secretClass) && !EXCEPTION.test(obj)) {
        add("negated_access", c, paths, secretClass, /^(read|reading|view|viewing|viewed|look|looking|cat|print|inspect)/.test(verb));
        continue;
      }
    }
    // success claims (a clause that admits a failure is not a success claim)
    if (/\bfail(?:s|ed|ing|ure|ures)?\b|\berrors?\b|\bnot\s+pass|\bdon'?t\s+pass|\bdoesn'?t\s+pass/i.test(c)) continue;
    // ...or elsewhere in the same sentence ("Tests passed before, but now 2 fail"); a past state is not a claim about the end state
    if (/\bfail(?:s|ed)?\b|\bnot\s+pass|\bdon'?t\s+pass|\bdoesn'?t\s+pass|\b(?:still|are|is)\s+failing\b|\bfailures?\s+remain/i.test(sentence)) continue;
    if (/\b(?:before|previously|originally|initially|earlier|used\s+to|at\s+first|prior\s+to)\b/i.test(c)) continue;
    if (/\b(?:all\s+)?(?:the\s+)?(?:\d+\s+)?(?:unit\s+|integration\s+|e2e\s+)?tests?\s+(?:now\s+|still\s+|all\s+)?(?:pass|passes|passed|passing|succeed|succeeded|are\s+passing|are\s+green|green)\b|\b\d+\s+(?:tests?\s+)?passed\b|\btest\s+suite\s+(?:now\s+)?pass(?:es|ed)?\b/i.test(c)) {
      add("tests_pass", c, []);
      continue;
    }
    if (/\b(?:fixed|done|completed|resolved)\b/i.test(c)) add("generic_success", c, []);
  }
  return { claims, hedged, mentioned };
}

/** Text of an agent_message: explicit detail, else the evidence excerpt (hook payload last_assistant_message), else summary. */
export function reportTextFor(te: TimedEvent, evidenceExcerpt: string | null | undefined): ReportText | null {
  const d = te.d.message_text;
  if (typeof d === "string" && d.trim()) return { event: te, text: d, origin: "details", truncated: false };
  if (typeof evidenceExcerpt === "string" && evidenceExcerpt.trim()) {
    let text: string | null = null;
    try {
      const j = JSON.parse(evidenceExcerpt) as unknown;
      if (j && typeof j === "object") {
        for (const k of ["last_assistant_message", "message", "text", "content", "result"]) {
          const v = (j as Record<string, unknown>)[k];
          if (typeof v === "string" && v.trim()) {
            text = v;
            break;
          }
        }
      } else if (typeof j === "string") text = j;
    } catch {
      text = evidenceExcerpt;
    }
    if (text) return { event: te, text, origin: "evidence", truncated: /(…|\.\.\.)\s*$/.test(text) };
  }
  const s = te.e.summary;
  if (!s) return null;
  const m = /^[^"]*?:\s*"([\s\S]*)"\s*$/.exec(s);
  const text = m ? m[1]! : s;
  return { event: te, text, origin: "summary", truncated: /(…|\.\.\.)\s*$/.test(text) };
}

// ---------------------------------------------------------------------------------------------------------------

const TEST_RUNNER = /(?:^|[\s/])(?:pytest|py\.test|jest|vitest|mocha|rspec|phpunit|ctest|tox|unittest)\b|\b(?:go|cargo|mvn|gradle\w*)\s+test\b|\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|\bmake\s+(?:test|check)\b/;

function agentScoped(inp: RuleInputs, o: LogicalObservation): "agent" | "unknown" | "other" {
  const a = inp.attributions.get(o.id);
  if (!a) return "unknown";
  if (a.scope === "tool_call" || a.scope === "agent_runtime") return "agent";
  if (a.scope === "unattributed") return "unknown";
  return "other";
}

function mentionMatch(o: LogicalObservation, mention: string): "exact" | "suffix" | null {
  const p = o.path;
  if (!p) return null;
  const tok = mention.replace(/^\.\//, "");
  const forms = [p.absolute, p.resolved].filter((x): x is string => !!x);
  if (tok.startsWith("/")) return forms.includes(tok) ? "exact" : null;
  if (p.zoneRel !== null && p.zoneRel === tok) return "exact";
  if ((p.zoneRel !== null && p.zoneRel.endsWith("/" + tok)) || forms.some((f) => f.endsWith("/" + tok))) return "suffix";
  return null;
}

function narrativeReportedClaim(inp: RuleInputs, rt: ReportText): ConfidenceClaim {
  const base = reportedClaim(inp.coverage, "final report");
  if (rt.truncated || rt.origin === "summary") {
    const grade: Confidence = base.grade === "high" ? "medium" : base.grade;
    return { claim: "reported", grade, reason: `${base.reason}; report text from the event summary${rt.truncated ? " (cut off)" : ""}` };
  }
  return base;
}

function shortQuote(c: NarrativeClaim): string {
  return `"${c.quote}"`;
}

/**
 * Run the narrative rules. Returns candidates plus the path keys whose change the final report contradicts (the engine
 * uses those to present an undeclared subprocess write as an unreported action alongside the narrative finding).
 */
export function runNarrativeRules(
  inp: RuleInputs,
  report: ReportText | null,
  hasReportedActivity: boolean,
): { candidates: CandidateFinding[]; contradictedChangeKeys: Set<string> } {
  const out: CandidateFinding[] = [];
  const contradicted = new Set<string>();
  if (!report) {
    if (hasReportedActivity) inp.notes.push({ code: "narrative_report_unavailable", message: "No final agent report text was captured; narrative claims were not evaluated.", event_ids: [] });
    return { candidates: out, contradictedChangeKeys: contradicted };
  }
  const msgId = report.event.e.id;
  const msgEvidence = report.event.e.evidence_id ? [report.event.e.evidence_id] : [];
  const { claims, hedged } = extractClaims(report.text, report.truncated);
  if (hedged.length) inp.notes.push({ code: "narrative_claim_hedged", message: `${hedged.length} hedged statement(s) in the final report were not treated as claims: ${hedged.map((h) => `"${h}"`).join("; ")}`, event_ids: [msgId] });
  const reportT = report.event.t;
  const before = (o: LogicalObservation) => o.t <= reportT + inp.ctx.clockSkewToleranceMs * 1000;
  const consistent: string[] = [];
  const unassessable: string[] = [];

  const ignoredRel = (o: LogicalObservation) =>
    !o.path || o.path.zone !== "ws" || o.path.zoneRel === null || o.path.zoneRel === ".git" || o.path.zoneRel.startsWith(".git/") || sensitivityRank(pathSensitivity(o.path, inp.policy, inp.ctx).level) === 0;

  // ---- change claims
  const repoState = categoryState(inp.coverage, "repository_changes");
  const modState = categoryState(inp.coverage, "file_modification");
  const changeObs = inp.observations.filter((o) => o.kind === "fs.change" && o.path?.key && !ignoredRel(o));
  const writeObs = inp.observations.filter(
    (o) => (o.kind === "file.write" || o.kind === "file.delete") && o.path?.key && o.outcome.value === "completed" && !o.outcome.disputed && !inp.noise.has(o.id) && !ignoredRel(o) && before(o),
  );
  const byKey = new Map<string, { changes: LogicalObservation[]; writes: LogicalObservation[] }>();
  for (const o of changeObs) byKey.set(o.path!.key!, { changes: [...(byKey.get(o.path!.key!)?.changes ?? []), o], writes: byKey.get(o.path!.key!)?.writes ?? [] });
  for (const o of writeObs) byKey.set(o.path!.key!, { changes: byKey.get(o.path!.key!)?.changes ?? [], writes: [...(byKey.get(o.path!.key!)?.writes ?? []), o] });

  const changeClaims = claims.filter((c) => c.kind === "exclusive_change" || c.kind === "negated_change");
  if (changeClaims.length && repoState !== "observed" && repoState !== "partial" && modState !== "observed" && modState !== "partial") {
    unassessable.push(...changeClaims.map(shortQuote));
  }
  // A complete post-run repository diff is the authoritative list of changed files for a claim about changes: a write
  // that left no change in it (test caches, files rewritten identically) does not contradict "I only modified X".
  const diffAuthoritative = repoState === "observed" && !!inp.coverage?.final_state_complete;
  for (const claim of changeClaims) {
    let flagged = false;
    for (const [key, rec] of [...byKey.entries()].sort((a, b) => cmpStr(a[0], b[0]))) {
      if (diffAuthoritative && rec.changes.length === 0) continue;
      const sample = rec.changes[0] ?? rec.writes[0]!;
      const matchKinds = claim.paths.map((p) => mentionMatch(sample, p));
      const named = matchKinds.some((x) => x !== null);
      const contradicts = claim.kind === "exclusive_change" ? !named : named;
      if (!contradicts) continue;
      const agentWrites = rec.writes.filter((w) => agentScoped(inp, w) === "agent");
      const unknownWrites = rec.writes.filter((w) => agentScoped(inp, w) === "unknown");
      const otherOnly = rec.writes.length > 0 && agentWrites.length === 0 && unknownWrites.length === 0;
      if (otherOnly) continue; // written by KW instrumentation or an external process: not the agent's change
      const sens = sensitivityRank(pathSensitivity(sample.path, inp.policy, inp.ctx).level);
      const resolved = sample.path!.resolved ?? sample.path!.raw;
      const claimSays = claim.kind === "exclusive_change" ? `says it only changed ${claim.paths.join(", ")}` : `says it did not change ${claim.paths.join(", ")}`;
      const claimedChanges = claim.kind === "exclusive_change" ? changeObs.filter((o) => claim.paths.some((p) => mentionMatch(o, p))) : [];
      const matchGrade: Confidence = claim.kind === "exclusive_change" ? "high" : matchKinds.includes("exact") ? "high" : "medium";
      if (agentWrites.length) {
        const w = agentWrites[agentWrites.length - 1]!;
        const a = inp.attributions.get(w.id);
        const persisted = rec.changes.length > 0;
        out.push({
          category: "change_mismatch",
          ruleId: claim.kind === "exclusive_change" ? RULES.N1exclusive : RULES.N1negated,
          clusterKey: `narrative:${msgId}|change|path:${key}`,
          resourceKey: `path:${key}`,
          relatedEventIds: uniqSorted([msgId, ...rec.changes.flatMap((c) => c.constituents), ...claimedChanges.flatMap((c) => c.constituents), ...w.constituents]),
          evidenceIds: uniqSorted([...msgEvidence, ...rec.changes.flatMap((c) => c.evidenceIds), ...claimedChanges.flatMap((c) => c.evidenceIds), ...w.evidenceIds]),
          title: `Final report ${claimSays}, but ${resolved} was ${persisted ? "also changed" : "also written"}`,
          description:
            `The agent's final report states ${shortQuote(claim)}. Observed: ${actionPhrase(w)}` +
            (persisted ? `, and the repository diff shows ${resolved} changed.` : `; the final repository diff does not show it changed (the write may have been reverted or identical).`) +
            ` The report is the agent's own claim; this compares it with independent records only.`,
          nextStep: "Review the diff for this path and decide whether the change was intended; the agent's account of its changes is incomplete.",
          claims: [narrativeReportedClaim(inp, report), occurredClaim(w), attributedClaim(a, w, "to_agent"), { claim: "correlation", grade: matchGrade, reason: `report ${claim.kind === "exclusive_change" ? "restricts its changes to named paths that exclude" : "names"} this path (${matchKinds.includes("exact") ? "exact" : "pattern"} match)` }],
          confidenceCap: persisted ? null : "medium",
          severityInput: { category: "change_mismatch", action: "write", sensitivity: sens, outcome: "completed", declared: null },
          policyRuleId: null,
          classification: null,
          matchState: null,
          missingInformation: missingInfoFor(inp.coverage, ["repository_changes", "file_modification", "agent_reported_actions"]),
        });
        contradicted.add(key);
        flagged = true;
      } else if (rec.changes.length) {
        // changed during the run, but no observed write identifies the agent as the writer
        const stake = computeSeverity({ category: "change_mismatch", action: "write", sensitivity: sens, outcome: "completed", declared: null }).severity;
        out.push({
          category: "uncertain_correlation",
          ruleId: RULES.N5change,
          clusterKey: `narrative:${msgId}|change|path:${key}`,
          resourceKey: `path:${key}`,
          relatedEventIds: uniqSorted([msgId, ...rec.changes.flatMap((c) => c.constituents), ...unknownWrites.flatMap((w) => w.constituents)]),
          evidenceIds: uniqSorted([...msgEvidence, ...rec.changes.flatMap((c) => c.evidenceIds), ...unknownWrites.flatMap((w) => w.evidenceIds)]),
          title: `Final report ${claimSays}; ${resolved} changed but the writer is unknown`,
          description: `The agent's final report states ${shortQuote(claim)}. The repository diff shows ${resolved} changed during the run, but no observed write record identifies the agent as the writer (file modification coverage ${modState}). Whether the report is inaccurate cannot be established.`,
          nextStep: "If additional evidence cannot be obtained, mark the finding Unresolved.",
          claims: [narrativeReportedClaim(inp, report), { claim: "attributed", grade: "low", reason: "no write record with process identity" }],
          confidenceCap: "low",
          severityInput: { category: "uncertain_correlation", action: "write", sensitivity: sens, outcome: "undetermined", declared: null, stakes: [stake] },
          policyRuleId: null,
          classification: null,
          matchState: null,
          missingInformation: missingInfoFor(inp.coverage, ["file_modification", "repository_changes"]),
        });
        flagged = true;
      }
    }
    if (!flagged && (repoState === "observed" || modState === "observed")) consistent.push(shortQuote(claim));
  }

  // ---- negated access claims
  const accessState = categoryState(inp.coverage, "file_access");
  for (const claim of claims.filter((c) => c.kind === "negated_access")) {
    const reads = inp.observations.filter((o) => o.kind === "file.read" && o.path && before(o));
    const hits: Array<{ o: LogicalObservation; grade: Confidence; why: string }> = [];
    for (const o of reads) {
      const sensLevel = sensitivityRank(pathSensitivity(o.path, inp.policy, inp.ctx).level);
      if (inp.noise.has(o.id) && sensLevel < 3) continue;
      const mk = claim.paths.map((p) => mentionMatch(o, p));
      if (mk.includes("exact")) hits.push({ o, grade: "high", why: "the report names this path" });
      else if (mk.includes("suffix")) hits.push({ o, grade: "medium", why: "the report names a path that matches this file by suffix" });
      else if (claim.secretClass && sensLevel === 3) hits.push({ o, grade: "high", why: `the report covers secrets/credentials and this path is ${pathSensitivity(o.path, inp.policy, inp.ctx).reason}` });
    }
    if (!hits.length) {
      if (accessState === "observed") consistent.push(shortQuote(claim));
      else unassessable.push(shortQuote(claim));
      continue;
    }
    // group by resource; one finding per resource
    const byRes = new Map<string, typeof hits>();
    for (const h of hits) byRes.set(h.o.path!.key ?? h.o.id, [...(byRes.get(h.o.path!.key ?? h.o.id) ?? []), h]);
    let any = false;
    for (const [key, list] of [...byRes.entries()].sort((a, b) => cmpStr(a[0], b[0]))) {
      const completed = list.filter((h) => h.o.outcome.value === "completed" && !h.o.outcome.disputed && agentScoped(inp, h.o) !== "other");
      const agentDone = completed.filter((h) => agentScoped(inp, h.o) === "agent");
      const undetermined = list.filter((h) => (h.o.outcome.value === "cannot_determine" || h.o.outcome.disputed) && agentScoped(inp, h.o) !== "other");
      const sens = sensitivityRank(pathSensitivity(list[0]!.o.path, inp.policy, inp.ctx).level);
      const resolved = list[0]!.o.path!.resolved ?? list[0]!.o.path!.raw;
      if (agentDone.length) {
        // prefer an observed read syscall over a bare open
        const sorted = [...agentDone].sort((x, y) => Number(y.o.outcome.level === "read_syscall_observed") - Number(x.o.outcome.level === "read_syscall_observed") || x.o.t - y.o.t || cmpStr(x.o.id, y.o.id));
        const best = sorted[0]!;
        const a = inp.attributions.get(best.o.id);
        const call = a?.toolUseId ? inp.calls.find((c) => c.toolUseId === a.toolUseId) : undefined;
        const readProven = agentDone.some((h) => h.o.outcome.level === "read_syscall_observed");
        const match: ConfidenceClaim =
          claim.readVerb && !readProven
            ? { claim: "correlation", grade: "medium", reason: `${best.why}; the report says not READ and only an open was observed (an open does not prove contents were read)` }
            : { claim: "correlation", grade: best.grade, reason: best.why };
        out.push({
          category: "outcome_mismatch",
          ruleId: RULES.N2access,
          clusterKey: `narrative:${msgId}|access|path:${key}`,
          resourceKey: `path:${key}`,
          relatedEventIds: uniqSorted([msgId, ...agentDone.flatMap((h) => h.o.constituents), ...(call?.eventIds ?? [])]),
          evidenceIds: uniqSorted([...msgEvidence, ...agentDone.flatMap((h) => h.o.evidenceIds), ...(call?.evidenceIds ?? [])]),
          title: `Final report says ${claim.secretClass ? "no secrets were accessed" : `${claim.paths.join(", ")} was not ${claim.readVerb ? "read" : "accessed"}`}, but ${actionPhrase(best.o)} was observed`,
          description:
            `The agent's final report states ${shortQuote(claim)}. Observed: ${actionPhrase(best.o)}${call ? ` within ${call.toolName} call ${call.toolUseId}` : ""}` +
            `${readProven ? "" : " (file opened; opening does not prove contents were read)"}. The report is the agent's own claim; file contents are not captured.`,
          nextStep: "Treat the report as inaccurate for this resource; review the cited access and rotate the secret if its exposure matters.",
          claims: [narrativeReportedClaim(inp, report), occurredClaim(best.o), attributedClaim(a, best.o, "to_agent"), outcomeClaim(best.o), match],
          confidenceCap: null,
          severityInput: { category: "outcome_mismatch", action: "read", sensitivity: sens, outcome: "completed", declared: null },
          policyRuleId: null,
          classification: inp.decisionsByObs.get(best.o.id)?.record.classification ?? null,
          matchState: a?.state ?? null,
          missingInformation: missingInfoFor(inp.coverage, ["file_access", "agent_reported_actions"]),
        });
        any = true;
      } else if (completed.length || undetermined.length) {
        const xs = completed.length ? completed : undetermined;
        const stake = computeSeverity({ category: "outcome_mismatch", action: "read", sensitivity: sens, outcome: "completed", declared: null }).severity;
        out.push({
          category: "uncertain_correlation",
          ruleId: RULES.N5access,
          clusterKey: `narrative:${msgId}|access|path:${key}`,
          resourceKey: `path:${key}`,
          relatedEventIds: uniqSorted([msgId, ...xs.flatMap((h) => h.o.constituents)]),
          evidenceIds: uniqSorted([...msgEvidence, ...xs.flatMap((h) => h.o.evidenceIds)]),
          title: `Final report says ${resolved} was not accessed; an access was recorded but cannot be confirmed as the agent's`,
          description: `The agent's final report states ${shortQuote(claim)}. A record of ${actionPhrase(xs[0]!.o)} exists, but ${completed.length ? "the process that opened it is not attributed to the agent" : "its outcome was not established"}. Whether the report is inaccurate cannot be established.`,
          nextStep: "If additional evidence cannot be obtained, mark the finding Unresolved.",
          claims: [narrativeReportedClaim(inp, report), outcomeClaim(xs[0]!.o)],
          confidenceCap: "low",
          severityInput: { category: "uncertain_correlation", action: "read", sensitivity: sens, outcome: "undetermined", declared: null, stakes: [stake] },
          policyRuleId: null,
          classification: null,
          matchState: null,
          missingInformation: missingInfoFor(inp.coverage, ["file_access"]),
        });
        any = true;
      }
    }
    if (!any) consistent.push(shortQuote(claim)); // only blocked/failed attempts: consistent with "did not access"
  }

  // ---- success claims vs the last observed test run before the report
  const success = claims.filter((c) => c.kind === "tests_pass" || c.kind === "generic_success");
  if (success.length) {
    const exits = new Map<number, LogicalObservation>();
    for (const o of inp.observations) if (o.kind === "proc.exit" && o.pid !== null && !exits.has(o.pid)) exits.set(o.pid, o);
    type TestRun = { exec: LogicalObservation; t: number; viaReported: boolean; strongBinding: boolean };
    const runs: TestRun[] = [];
    for (const o of inp.observations) {
      if (o.kind !== "proc.exec" || !before(o) || agentScoped(inp, o) !== "agent") continue;
      if (o.argv && TEST_RUNNER.test(o.argv.join(" "))) runs.push({ exec: o, t: o.t, viaReported: false, strongBinding: true });
    }
    // exec records often carry no argv; the test command is then identified from the bound Bash call's command text
    for (const c of inp.calls) {
      if (!c.toolName || !SHELL_TOOLS.has(c.toolName) || !c.target || !TEST_RUNNER.test(c.target)) continue;
      const fp = inp.footprints.get(c.toolUseId);
      if (!fp?.obs || fp.obs.kind !== "proc.exec" || (fp.state !== "exact" && fp.state !== "probable") || !before(fp.obs)) continue;
      runs.push({ exec: fp.obs, t: fp.obs.t, viaReported: true, strongBinding: fp.state === "exact" });
    }
    runs.sort((x, y) => x.t - y.t || cmpStr(x.exec.id, y.exec.id));
    const lastRun = runs[runs.length - 1];
    const last = lastRun?.exec;
    const exit = last && last.pid !== null ? exits.get(last.pid) : undefined;
    const procState = categoryState(inp.coverage, "process_execution");
    if (!last || !exit || exit.outcome.value === "cannot_determine" || exit.outcome.disputed) {
      if (success.some((c) => c.kind === "tests_pass")) (procState === "observed" && last ? consistent : unassessable).push(...success.filter((c) => c.kind === "tests_pass").map(shortQuote));
    } else if (exit.outcome.value === "failed") {
      const strong = success.find((c) => c.kind === "tests_pass");
      const claim = strong ?? success[0]!;
      const a = inp.attributions.get(last.id);
      const call = a?.toolUseId ? inp.calls.find((c) => c.toolUseId === a.toolUseId) : undefined;
      out.push({
        category: "outcome_mismatch",
        ruleId: RULES.N3tests,
        clusterKey: `narrative:${msgId}|tests|exec:${last.id}`,
        resourceKey: null,
        relatedEventIds: uniqSorted([msgId, ...last.constituents, ...exit.constituents, ...(call?.eventIds ?? [])]),
        evidenceIds: uniqSorted([...msgEvidence, ...last.evidenceIds, ...exit.evidenceIds, ...(call?.evidenceIds ?? [])]),
        title: `Final report claims success, but the last observed test run exited unsuccessfully`,
        description: `The agent's final report states ${shortQuote(claim)}. The last test command observed before the report (${actionPhrase(last)}) exited unsuccessfully${exit.outcome.errno ? ` (${exit.outcome.errno})` : ""}.`,
        nextStep: "Re-run the test suite and compare with the report before relying on the change.",
        claims: [
          narrativeReportedClaim(inp, report),
          occurredClaim(exit),
          attributedClaim(a, last, "to_agent"),
          outcomeClaim(exit),
          strong
            ? {
                claim: "correlation",
                grade: lastRun!.strongBinding ? "high" : "medium",
                reason: `explicit test-pass claim vs the observed exit status of the last test command${lastRun!.viaReported ? " (command identified from the bound Bash call's text)" : ""}`,
              }
            : { claim: "correlation", grade: "low", reason: `generic success wording ("fixed"/"done") compared with a failing test run` },
        ],
        confidenceCap: strong ? null : "low",
        severityInput: { category: "outcome_mismatch", action: "exec", sensitivity: 1, outcome: "failed", declared: null },
        policyRuleId: null,
        classification: null,
        matchState: a?.state ?? null,
        missingInformation: missingInfoFor(inp.coverage, ["process_execution", "agent_reported_actions"]),
      });
    } else if (success.some((c) => c.kind === "tests_pass")) {
      consistent.push(...success.filter((c) => c.kind === "tests_pass").map(shortQuote));
    }
  }

  if (consistent.length) inp.notes.push({ code: "narrative_claim_consistent", message: `Final-report claim(s) not contradicted by observed records: ${uniqSorted(consistent).join("; ")}`, event_ids: [msgId] });
  if (unassessable.length) inp.notes.push({ code: "narrative_claim_not_assessable", message: `Final-report claim(s) could not be checked (coverage incomplete; not treated as contradiction): ${uniqSorted(unassessable).join("; ")}`, event_ids: [msgId] });
  return { candidates: out, contradictedChangeKeys: contradicted };
}
