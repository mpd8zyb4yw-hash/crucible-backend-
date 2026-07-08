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

// Parse the first verified YouTube URL out of search_youtube's text output.
function firstYoutubeUrl(out: string): string | null {
  const m = out.match(/https:\/\/www\.youtube\.com\/watch\?v=[A-Za-z0-9_-]{11}/)
  return m ? m[0] : null
}

// ── Resolvers (ordered: most specific first) ───────────────────────────────────

// "play <something> on youtube" / "put on <something>" / "play <x>" (defaults YT)
function resolvePlayMedia(m: string): LocalPlan | null {
  // Capture the media subject and (optionally) the service.
  const re = /\b(?:play|put on|queue(?: up)?|pull up)\b\s+(.+?)(?:\s+on\s+(youtube|spotify|netflix|apple music|music))?\s*$/i
  const match = m.match(re)
  if (!match) return null
  const subject = stripPunct(match[1])
  if (!subject || subject.length < 2) return null

  // ── Bail to the agent loop on multi-context commands ──────────────────────────
  // The deterministic router only handles a SINGLE intent. Two failure modes it must
  // NOT try to resolve (they need real planning + step-to-step context):
  //
  // 1. Compound command — another action verb precedes "play"
  //    ("open youtube, search for be.busta, play one of the videos"). Here the regex
  //    grabs "one of the videos" as the search query, which is nonsense.
  // 2. Referential subject — the thing to play refers to a PRIOR step's result
  //    ("play one of the videos", "play the first one", "play it"), not a literal query.
  //
  // In both cases return null so runAgentLoop plans it with full context (search the
  // real subject → pick a result → play it).
  const before = m.slice(0, match.index ?? 0)
  if (/\b(?:open|launch|search|find|look up|go to|navigate|bring up|pull up|then|after that|and then|first)\b/i.test(before)) return null
  if (/^(?:one|a|an|the|that|this|it|any|some|another|first|second|next|last|top)\b/i.test(subject)
      && /\b(?:one|ones|video|videos|result|results|song|songs|track|tracks|clip|clips|thing|things|it|them)\b/i.test(subject)) return null

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

const RESOLVERS = [resolvePlayMedia, resolveEmptyTrash, resolveOpen, resolveClick, resolveType]

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
