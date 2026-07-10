// ── Local Intent Router — Offline-First agentic execution (Track O, Layer 0) ──
//
// THE VISION: a truly offline Crucible that leans on its own knowledge and on-device
// capability, reaching for an external LLM only in genuinely niche cases. This module
// is Layer 0 of that stack: deterministic intent → tool resolution with ZERO model
// calls. The most common agentic commands ("open Spotify", "play X on YouTube",
// "empty the trash", "click the Submit button", "type hello") are unambiguous — they
// do not need a 5–10s LLM round-trip to plan. We pattern-match them and dispatch the
// exact tool sequence directly.
//
// Design rules:
//   • HIGH PRECISION over recall. When in doubt, return null and let the LLM agent
//     loop handle it. A wrong deterministic action is far worse than a slow correct one.
//   • Pure resolver. resolveLocalIntent(message) is a pure function (message → plan |
//     null) so it is trivially unit-testable without a running daemon or API key.
//   • Chaining via deriveArgs. Steps that depend on a prior result (search → open)
//     derive their args from the previous ToolResult.
//
// This is the foundation the corpus-grounded answer path (Layer 1) and local-FM
// planning (Layer 2) build on. See ROADMAP Track O.

import type { ToolResult } from '../tools/protocol'

export interface LocalStep {
  tool: string
  args?: Record<string, unknown>
  /** Derive args from the previous step's result (search → open chaining). Return
   *  null to abort the plan (e.g. the search found nothing). */
  deriveArgs?: (prev: ToolResult) => Record<string, unknown> | null
}

export interface LocalPlan {
  /** Coarse intent label, surfaced on the debug bus. */
  intent: string
  /** Human-facing summary used as the agent's final text. */
  label: string
  steps: LocalStep[]
}

// ── Vocabulary ────────────────────────────────────────────────────────────────

// Known macOS app names → canonical `open -a` target. Lowercased keys.
const APP_ALIASES: Record<string, string> = {
  spotify: 'Spotify', finder: 'Finder', safari: 'Safari', chrome: 'Google Chrome',
  'google chrome': 'Google Chrome', firefox: 'Firefox', arc: 'Arc', mail: 'Mail',
  messages: 'Messages', notes: 'Notes', calendar: 'Calendar', reminders: 'Reminders',
  music: 'Music', 'apple music': 'Music', photos: 'Photos', preview: 'Preview',
  terminal: 'Terminal', iterm: 'iTerm', 'vs code': 'Visual Studio Code',
  vscode: 'Visual Studio Code', 'visual studio code': 'Visual Studio Code',
  xcode: 'Xcode', slack: 'Slack', discord: 'Discord', zoom: 'zoom.us',
  textedit: 'TextEdit', calculator: 'Calculator', 'system settings': 'System Settings',
  'system preferences': 'System Settings', maps: 'Maps', facetime: 'FaceTime',
  podcasts: 'Podcasts', 'activity monitor': 'Activity Monitor',
}

// Streaming services that should resolve to a web search + open, not a native app.
const WEB_SERVICES: Record<string, { kind: 'youtube' | 'web'; site?: string }> = {
  youtube: { kind: 'youtube' },
  netflix: { kind: 'web', site: 'https://www.netflix.com/search?q=' },
}

const stripPunct = (s: string) => s.trim().replace(/[.!?]+$/, '').trim()

// ── Ordinal / result-selector vocabulary ────────────────────────────────────────
// A prompt like "…play the third video" carries TWO facts: a search subject AND which
// result to pick. The ordinal ("third") is a SELECTOR, not part of the query. These
// helpers understand that selector generally (word, numeric, top/last) so the router
// never mistakes a selector for a search subject — the root cause of the "searched for
// 'the third video'" failure.
const ORDINAL_WORDS: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7,
  eighth: 8, ninth: 9, tenth: 10, top: 1, next: 1,
}
// Regex fragment matching any ordinal token (word, top/last/next, or 1st/2/3rd…).
const ORDINAL_FRAG = 'first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|top|last|next|\\d{1,2}(?:st|nd|rd|th)?'
// Nouns a result-selector can attach to ("the third VIDEO", "the top RESULT").
const SELECTOR_NOUN = '(?:result|video|one|song|track|link|clip|item|hit)s?'
// A trailing result-selector clause: an optional action verb, then "the <ordinal> <noun>".
// Requiring "the" + a noun keeps this from firing on quantities inside a subject
// (e.g. "search for top 10 songs" has no "the" before "10" → not a selector).
const SELECTOR_RE = new RegExp(
  `\\b(?:play|open|watch|select|pick|choose|go to)?\\s*the\\s+(${ORDINAL_FRAG})\\s+${SELECTOR_NOUN}\\s*$`, 'i')
// A phrase that is ITSELF only a selector/pronoun — never a searchable subject.
const SELECTOR_ONLY_RE = new RegExp(
  `^(?:the\\s+)?(?:${ORDINAL_FRAG}|it|that|this|those|these)(?:\\s+${SELECTOR_NOUN})?$`, 'i')

/** Map an ordinal token to a 1-based index; -1 for "last". null if unparseable. */
function parseOrdinal(token: string): number | null {
  const t = token.toLowerCase()
  if (t === 'last') return -1
  if (t in ORDINAL_WORDS) return ORDINAL_WORDS[t]
  const num = t.match(/^(\d{1,2})(?:st|nd|rd|th)?$/)
  if (num) { const n = parseInt(num[1], 10); return n >= 1 && n <= 50 ? n : null }
  return null
}

// Parse the first verified YouTube URL out of search_youtube's text output.
function firstYoutubeUrl(out: string): string | null {
  const m = out.match(/https:\/\/www\.youtube\.com\/watch\?v=[A-Za-z0-9_-]{11}/)
  return m ? m[0] : null
}

/** The nth (1-based, -1 = last) verified YouTube URL in search output. Clamps to the last
 *  available result when fewer were returned than requested, rather than failing. */
function nthYoutubeUrl(out: string, n: number): string | null {
  const urls = out.match(/https:\/\/www\.youtube\.com\/watch\?v=[A-Za-z0-9_-]{11}/g)
  if (!urls || urls.length === 0) return null
  const uniq = [...new Set(urls)]
  if (n === -1) return uniq[uniq.length - 1]
  return uniq[n - 1] ?? uniq[uniq.length - 1]
}

// ── Resolvers (ordered: most specific first) ───────────────────────────────────

// Compositional search-then-select: "search YouTube for X, play the third video",
// "find X on youtube and open the 2nd result", "look up X — play the last one".
// This is the general fix for multi-context prompts: it separates the SEARCH SUBJECT
// from the RESULT SELECTOR (ordinal) instead of pattern-matching one fragment. No
// LLM. Only YouTube today (it's the one service whose result list we parse); anything
// else returns null and defers to the smarter layers.
function resolveSearchAndSelect(m: string): LocalPlan | null {
  // Must read as a search command (explicit verb, or a bare "youtube <subject>").
  const hasSearchVerb = /\b(?:search|look up|look for|find|pull up)\b/i.test(m)
  const mentionsYouTube = /\byoutube\b/i.test(m)
  if (!hasSearchVerb && !mentionsYouTube) return null
  // Only wire result-list selection for YouTube; a Netflix "3rd result" has no parseable list.
  if (/\bnetflix\b/i.test(m) && !mentionsYouTube) return null

  // 1) Peel a trailing result-selector ("… play the third video") off the end.
  let idx = 1
  let hadSelector = false
  let core = m
  const sel = m.match(SELECTOR_RE)
  if (sel && sel.index != null) {
    const parsed = parseOrdinal(sel[1])
    if (parsed != null) { idx = parsed; hadSelector = true; core = m.slice(0, sel.index).trim() }
  }

  // 2) Extract the search subject from what's left.
  let subject: string | null = null
  const forMatch = core.match(/\bfor\s+(.+?)\s*$/i)
  if (forMatch) {
    subject = forMatch[1]
  } else {
    const afterVerb = core.match(/\b(?:search|look up|look for|find|pull up)\b\s+(.+?)\s*$/i)
    if (afterVerb) subject = afterVerb[1]
    else {
      const afterYt = core.match(/\byoutube\b\s+(.+?)\s*$/i)
      if (afterYt) subject = afterYt[1]
    }
  }
  if (!subject) return null
  // Clean service tokens that leaked into the subject ("cats on youtube" → "cats").
  subject = subject
    .replace(/\bon\s+youtube\b/ig, '')
    .replace(/\bin\s+youtube\b/ig, '')
    .replace(/\byoutube\b/ig, '')
    .replace(/^\s*for\s+/i, '')
    .replace(/[,;:—-]+\s*$/, '')
  subject = stripPunct(subject).trim()
  if (!subject || subject.length < 2) return null
  // A subject that is itself only a selector/pronoun means there's nothing real to search
  // (e.g. a bare "play the third video") — defer to the smarter layers instead of guessing.
  if (SELECTOR_ONLY_RE.test(subject)) return null

  // If there was no explicit search verb and no selector, this is just "youtube <x>" —
  // let resolvePlayMedia / resolveOpen own that; only claim it when we add real value
  // (an explicit search, or a specific result selection).
  if (!hasSearchVerb && !hadSelector) return null

  const count = Math.max(3, idx === -1 ? 5 : idx)
  const where = idx === -1 ? 'last' : idx === 1 ? 'top' : `#${idx}`
  return {
    intent: 'search_select_media',
    label: `Searching YouTube for "${subject}" and playing the ${where} result.`,
    steps: [
      { tool: 'search_youtube', args: { query: subject, count } },
      {
        tool: 'open_app',
        deriveArgs: (prev) => {
          if (!prev.ok) return null
          const url = nthYoutubeUrl(prev.output, idx)
          return url ? { target: url } : null
        },
      },
    ],
  }
}

// "play <something> on youtube" / "put on <something>" / "play <x>" (defaults YT)
function resolvePlayMedia(m: string): LocalPlan | null {
  // Capture the media subject and (optionally) the service.
  const re = /\b(?:play|put on|queue(?: up)?|pull up)\b\s+(.+?)(?:\s+on\s+(youtube|spotify|netflix|apple music|music))?\s*$/i
  const match = m.match(re)
  if (!match) return null
  const subject = stripPunct(match[1])
  if (!subject || subject.length < 2) return null
  // Precision guard: a bare selector/pronoun ("the third video", "it", "that one") is not a
  // searchable subject — it refers to prior context. Defer to the smarter layers rather than
  // searching for the literal words. (search-then-select prompts are handled upstream.)
  if (SELECTOR_ONLY_RE.test(subject)) return null
  const service = (match[2] ?? 'youtube').toLowerCase()

  if (service === 'spotify' || service === 'apple music' || service === 'music') {
    // Open the app and search via its URL scheme where possible. Spotify supports a
    // search URI; Music falls back to opening the app (search-by-URL is unreliable).
    if (service === 'spotify') {
      return {
        intent: 'play_media',
        label: `Opening Spotify search for "${subject}".`,
        steps: [{ tool: 'open_app', args: { target: `spotify:search:${encodeURIComponent(subject)}` } }],
      }
    }
    return {
      intent: 'play_media',
      label: `Opening Music for "${subject}".`,
      steps: [{ tool: 'open_app', args: { target: 'Music' } }],
    }
  }

  // YouTube (default): live search, then open the top verified result. No LLM.
  return {
    intent: 'play_media',
    label: `Searching YouTube for "${subject}" and playing the top result.`,
    steps: [
      { tool: 'search_youtube', args: { query: subject, count: 3 } },
      {
        tool: 'open_app',
        deriveArgs: (prev) => {
          if (!prev.ok) return null
          const url = firstYoutubeUrl(prev.output)
          return url ? { target: url } : null
        },
      },
    ],
  }
}

// "open <app>" / "launch <app>" / "open <url>"
function resolveOpen(m: string): LocalPlan | null {
  const match = m.match(/\b(?:open|launch|start up|fire up|bring up)\s+(.+?)\s*$/i)
  if (!match) return null
  const raw = stripPunct(match[1]).replace(/^(the|my)\s+/i, '')
  if (!raw) return null

  // URL?
  if (/^https?:\/\//i.test(raw) || /^[a-z0-9-]+\.(com|org|net|io|dev|app|co|ai)\b/i.test(raw)) {
    const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
    return { intent: 'open_url', label: `Opening ${url}.`, steps: [{ tool: 'open_app', args: { target: url } }] }
  }

  // Known web service (e.g. "open youtube") → open its site.
  const svc = WEB_SERVICES[raw.toLowerCase()]
  if (svc) {
    const url = svc.kind === 'youtube' ? 'https://www.youtube.com' : (svc.site?.replace(/search.*$/, '') ?? 'https://www.netflix.com')
    return { intent: 'open_url', label: `Opening ${raw}.`, steps: [{ tool: 'open_app', args: { target: url } }] }
  }

  // Known native app?
  const appName = APP_ALIASES[raw.toLowerCase()]
  if (appName) {
    return { intent: 'open_app', label: `Opening ${appName}.`, steps: [{ tool: 'open_app', args: { target: appName } }] }
  }

  // Unknown single-word target that looks like an app name (no spaces, short) — try it.
  // open -a fails cleanly if the app doesn't exist, so this is safe.
  if (/^[A-Za-z][A-Za-z0-9 ]{1,28}$/.test(raw) && raw.split(' ').length <= 3) {
    return { intent: 'open_app', label: `Opening ${raw}.`, steps: [{ tool: 'open_app', args: { target: raw } }] }
  }
  return null
}

// "empty the trash" / "empty trash"
function resolveEmptyTrash(m: string): LocalPlan | null {
  if (/\bempty\b.*\btrash\b/i.test(m) || /\btrash\b.*\bempty\b/i.test(m)) {
    return { intent: 'empty_trash', label: 'Emptying the Trash.', steps: [{ tool: 'empty_trash' }] }
  }
  return null
}

// "click the <X> button" / "click <X>" / "tap <X>"  (Remote Brain Mac control)
function resolveClick(m: string): LocalPlan | null {
  const match = m.match(/\b(?:click|tap|press)\b\s+(?:on\s+)?(?:the\s+)?(.+?)(?:\s+(?:button|link|tab|icon|menu item|item))?\s*$/i)
  if (!match) return null
  const target = stripPunct(match[1])
  if (!target || target.length < 2 || target.length > 40) return null
  return { intent: 'click_element', label: `Clicking "${target}".`, steps: [{ tool: 'click_element', args: { title: target } }] }
}

// "type <X>" / "enter <X>"  (Remote Brain Mac control)
function resolveType(m: string): LocalPlan | null {
  const match = m.match(/^\s*(?:type|enter|input)\s+(?:in\s+)?["“]?(.+?)["”]?\s*$/i)
  if (!match) return null
  const text = match[1].trim()
  if (!text || text.length > 500) return null
  return { intent: 'type_text', label: `Typing "${text.slice(0, 40)}${text.length > 40 ? '…' : ''}".`, steps: [{ tool: 'type_text', args: { text } }] }
}

const RESOLVERS = [resolveSearchAndSelect, resolvePlayMedia, resolveEmptyTrash, resolveOpen, resolveClick, resolveType]

/**
 * Resolve a message to a deterministic tool plan, or null if no high-confidence
 * match. Pure function — safe to unit-test in isolation.
 */
export function resolveLocalIntent(message: string): LocalPlan | null {
  const m = (message ?? '').trim()
  if (!m || m.length > 200) return null  // long prose → not a simple command
  for (const r of RESOLVERS) {
    const plan = r(m)
    if (plan) return plan
  }
  return null
}

/**
 * Execute a resolved plan against a tool-exec function. Returns the per-step outputs
 * and a final summary. Aborts (ok:false) if any required step fails or a chained
 * deriveArgs returns null. Kept exec-injected so it's testable with a mock.
 */
export async function runLocalPlan(
  plan: LocalPlan,
  exec: (call: { id: string; name: string; args: Record<string, unknown> }) => Promise<ToolResult>,
): Promise<{ ok: boolean; outputs: ToolResult[]; summary: string }> {
  const outputs: ToolResult[] = []
  let prev: ToolResult | null = null
  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i]
    let args = step.args ?? {}
    if (step.deriveArgs) {
      const derived = prev ? step.deriveArgs(prev) : null
      if (!derived) {
        return { ok: false, outputs, summary: `Could not complete "${plan.label}" — no usable result from the previous step.` }
      }
      args = derived
    }
    const result = await exec({ id: `local_${i}`, name: step.tool, args })
    outputs.push(result)
    prev = result
    if (!result.ok) {
      return { ok: false, outputs, summary: `Step ${i + 1} (${step.tool}) failed: ${result.output.slice(0, 200)}` }
    }
  }
  return { ok: true, outputs, summary: plan.label }
}
