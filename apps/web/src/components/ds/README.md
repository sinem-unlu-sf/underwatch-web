# Underwatch design system

Spec: `docs/UI-REDESIGN-PRD.md` (Linear meets Vercel). Tokens live in `src/styles.css`; components in this folder,
exported from `components/ds/index.ts` (which also re-exports the restyled `ui.tsx` and `states.tsx` components).

## Tokens (Tailwind utilities + CSS variables)

| Token | Value | Utility examples | Legacy alias (still works) |
|---|---|---|---|
| bg | `#09090B` | `bg-bg` | `surface-0` |
| surface | `#111114` | `bg-surface` | `surface-1` |
| elevated | `#1A1A1F` | `bg-elevated` | `surface-2` (`surface-3` = hover) |
| text | `#EDEDF0` | `text-text` | `fg-0` (`fg-1` = in-between) |
| text-secondary | `#92929D` | `text-text-secondary` | `fg-2` |
| accent | `#8B8CF6` | `text-accent`, `outline-accent` | `focus` |
| success | `#47C9A5` (verified only) | `text-success` | `verified` |
| caution | `#F0B85A` (uncertainty) | `text-caution` | `warn` |
| danger | `#EF6B64` / solid `#B3362F` (real security risk) | `text-danger` | `risk` / `risk-solid` |
| border | `rgba(255,255,255,.07)` / strong `.12` | `border-border` | `line` / `line-strong` |
| unknown / reported / observed | provenance + not-established hues | `text-unknown`, `.hatch` | unchanged names |

- Radii: `rounded-sm` 6px (controls), `rounded-md` 8px (panels, code), `rounded-lg` 10px (overlays).
- Shadows: `--shadow-subtle` (buttons), `--shadow-raised` (restrained neumorphism, elevated surfaces only; `.surface-raised`), `--shadow-overlay` (drawers/dialogs).
- Spacing: 4px grid. Tailwind's default scale is already 4px (`gap-2` = 8, `gap-3` = 12, `p-4` = 16, `gap-6` = 24, `p-8` = 32). CSS vars `--space-1..8`.
- Motion: `--dur-fast` 120ms, `--dur-base` 160ms, `--dur-slow` 220ms, `--ease` (also Tailwind `ease-out`, `duration-120/150/200`). `prefers-reduced-motion` zeroes all transitions/animations globally. `.kw-fade-in` for entering overlays/messages.
- Focus: global `:focus-visible` = 2px accent outline, 2px offset. Never remove it.
- Fonts: Geist Sans (`font-sans`, default) and Geist Mono (`font-mono`), bundled locally via `@fontsource-variable/geist*`, with Inter/system fallbacks. Mono for ids, hashes, paths, timestamps, logs, commands, code.

## CSS component classes (global)

`.btn` (secondary) + `.btn-primary | .btn-ghost | .btn-danger`, sizes `.btn-sm | .btn-lg`, `.btn-icon`; states: hover, `:active`/`aria-pressed`, `:disabled`, `aria-busy`. `.field` (inputs/selects; `aria-invalid="true"` turns the border red). `.label` (small caps label). `table.data` (+ `.sticky` header, `tr[data-selected]`, `td.num` right-aligned tabular). `.skeleton`, `.hatch` (unknown / not established), `.surface-raised`, `.code-block`.

## Components

| Component | Purpose / API |
|---|---|
| `Button` | `variant: primary/secondary/ghost/danger`, `size: sm/md/lg`, `loading`, `loadingText`, `icon`. Defaults to `type="button"`. |
| `IconButton` | `icon`, `label` (required: aria-label + title), same variants/sizes. |
| `SegmentedControl` | `options [{value,label,description?,disabled?}]`, `value`, `onChange`, `label` (group name). role=radiogroup, arrows/Home/End. Use for `Quick Read \| Full Technical Details`. |
| `Section` | `title`, `description` (one line), `actions`, `id`, `level 2/3`. No card. Default page structure. |
| `Panel` (ui.tsx) | Lightweight bordered surface, `title`, `aside`. Use only where grouping needs a boundary. |
| `PageHeader`, `KeyValue`, `Stat`, `Mono`, `Time` (ui.tsx) | Restyled, same props. |
| `Field` (ui.tsx) | `label`, `help?`, `error?`, `required?`, `htmlFor?`. Wires aria-describedby / aria-invalid to a single child. |
| `StatusPill` | `kind`: verified, failed, inconclusive, unknown, fixture, reported, observed, derived, inferred, policy, risk, caution, active, pending, neutral. Symbol + text always; `children` overrides the label (keep honest wording, e.g. "Verified for tested scenario"). |
| `Badge` (badges.tsx) | Unchanged API + optional `icon` (IconName or `false`). Tones now render a symbol automatically (risk/warn/verified/unknown/reported/observed). All domain badges (`SeverityBadge`, `VerificationBadge`, `BasisBadge`, `FixtureBadge`, `FindingKindBadge`, ...) keep working. |
| `Tooltip` | `content`, single focusable child. Opens on hover + focus, Escape closes. Supplementary info only. |
| `Kbd`, `Skeleton`, `Icon`, `Divider` | Small primitives. `Icon` is decorative unless given `label`. |
| `DataTable` | `columns [{key, header, cell, align?, width?, truncate?, fullValue?, className?}]`, `rows`, `rowKey`, `onRowClick?` (adds keyboard activation), `selectedKey?`, `caption?`, `empty?`, `maxHeight?`. Presentation only: sorting/filtering/paging stay in the page. Horizontal scroll container built in. |
| `CodeBlock` | `code`, `language?`, `title?`, `wrap?`, `copy` (default true), `maxHeight?`. Mono, whitespace preserved, no syntax colours. |
| `MonoValue` | `value`, `display?`, `copy?`, `truncate` (default true), `maxWidth`. Full value in title + copy. |
| `CopyButton` | `value`, `label`. Shows "Copied" only after the clipboard write resolved; "Copy failed" otherwise (aria-live). |
| `Notice` | `tone: info/success/caution/danger/unknown`, `title`, `children`, `actions`, `onDismiss?`. Inline + persistent: for unresolved issues. |
| `SuccessFlash` | Transient confirmation, render ONLY after a mutation succeeded. |
| States (states.tsx) | `LoadingState`, `SkeletonRows`, `SkeletonBlock`, `PageSkeleton`, `EmptyState` (+ `action?`), `ErrorState` (all API error kinds incl. permission denied / token form), `StaleState` (`asOf?`, `onRefresh?` user-initiated), `IncompleteState`, `MutationError`, `PermissionDenied`, `Cmd`. |

## Rules

1. Redesign, not rebuild: keep every route, control, API call, FIXTURE label and honesty label. No mock data, no placeholder or no-op controls.
2. Never colour-only: every status has a text label (symbols reinforce). Green = verified for the tested scenario only. Unknown = hatched, never "safe". Security outcome and task outcome stay separate; Inconclusive stays Inconclusive.
3. Prefer `Section` + whitespace over cards. Elevation (`surface-raised`, shadows) only for overlays and raised controls.
4. Accent is for interaction, selection, links and focus only; no large accent areas, no gradients, no glow.
5. Mono for technical values; truncate long values with full-value access (title, copy, or scroll), never overflow the page. Layouts must work at ~400px.
6. Motion 120-220ms, only for navigation/selection/expansion/loading/state changes. No continuous decorative animation, no background polling, no auto popups.
7. Feedback: unresolved problems stay inline (`Notice`, `ErrorState`, `MutationError`); transient success only after the operation succeeded (`SuccessFlash`, `CopyButton`). Destructive actions use `variant="danger"` plus the existing confirmation flow.
8. Keyboard: every interactive element reachable and visibly focused; clickable rows use `DataTable onRowClick` (Enter/Space) or a real link.
