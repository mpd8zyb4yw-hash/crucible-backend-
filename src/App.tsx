import { useState, useRef, useEffect, useCallback } from 'react'
import { API_BASE, apiFetch } from './api'
import CrucibleMark from './CrucibleMark'
import './modelData'
import ReactMarkdown from 'react-markdown'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'

// ── Colour palette — assigned dynamically to whatever models the server picks ─
const PALETTE = [
  { color: '#7c7cf8', rgb: '124,124,248' },
  { color: '#4db89e', rgb: '77,184,158'  },
  { color: '#c084fc', rgb: '192,132,252' },
  { color: '#f59e0b', rgb: '245,158,11'  },
  { color: '#38bdf8', rgb: '56,189,248'  },
  { color: '#f87171', rgb: '248,113,113' },
]

interface DynamicModel {
  id: string
  label: string
  provider: string
  isWildcard: boolean
  color: string
  rgb: string
}


// ── Mode definitions ──────────────────────────────────────────────────────────
const MODES = [
  { id: 'quorum', label: 'QUORUM', color: '#7c7cf8' },
  { id: 'code',   label: 'CODE',   color: '#4db89e' },
  { id: 'seeker', label: 'SEEKER', color: '#f87171' },
] as const
type Mode = typeof MODES[number]['id']

const MODE_META: Record<string, { label: string; hint: string; color: string }> = {
  quorum: { label: 'Ensemble', hint: 'Multi-model pipeline', color: '#7c7cf8' },
  code:   { label: 'Code',     hint: 'Dev-optimised',       color: '#4db89e' },
  seeker: { label: 'Search',   hint: 'Web-augmented',       color: '#f59e0b' },
}

function ModeSwitcher({ mode, setMode, modeMenuOpen, setModeMenuOpen }: {
  mode: Mode
  setMode: (m: Mode) => void
  modeMenuOpen: boolean
  setModeMenuOpen: (o: boolean) => void
}) {
  const active = MODE_META[mode]
  const accentRgb = mode === 'code' ? '77,184,158' : mode === 'seeker' ? '245,158,11' : '124,124,248'
  const otherModes = MODES.filter(m => m.id !== mode)

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
      {/* Collapsed pill — always visible */}
      <button
        onPointerDown={e => { e.stopPropagation(); setModeMenuOpen(!modeMenuOpen) }}
        className={`crucible-pill${modeMenuOpen ? ' crucible-pill--active' : ''}`}
        title={active.hint}
        style={{
          display: 'flex', alignItems: 'center', gap: 5,
          padding: '4px 9px', borderRadius: 8, border: 'none', cursor: 'pointer',
          background: modeMenuOpen ? `rgba(${accentRgb},0.15)` : 'rgba(255,255,255,0.05)',
          transition: 'background 0.2s',
          userSelect: 'none' as const,
        }}
      >
        <span style={{
          width: 5, height: 5, borderRadius: '50%', flexShrink: 0,
          background: active.color, boxShadow: `0 0 6px ${active.color}99`,
        }} />
        <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.05em', color: active.color }}>
          {active.label}
        </span>
        <span style={{
          fontSize: 8, color: active.color, opacity: 0.5,
          transform: modeMenuOpen ? 'rotate(180deg)' : 'none',
          transition: 'transform 0.18s', display: 'inline-block', lineHeight: 1,
        }}>▴</span>
      </button>

      {/* Inline expansion — other modes appear to the right, no popup */}
      {modeMenuOpen && otherModes.map((m, i) => {
        const meta = MODE_META[m.id]
        const rgb = m.id === 'code' ? '77,184,158' : m.id === 'seeker' ? '245,158,11' : '124,124,248'
        return (
          <button
            key={m.id}
            onPointerDown={e => { e.stopPropagation(); setMode(m.id); setModeMenuOpen(false); haptic('light') }}
            title={meta.hint}
            style={{
              display: 'flex', alignItems: 'center', gap: 5,
              padding: '4px 9px', borderRadius: 8, border: 'none', cursor: 'pointer',
              background: 'rgba(255,255,255,0.05)',
              opacity: 0, animation: `fanIn 0.12s ease forwards`,
              animationDelay: `${i * 0.05}s`,
              transition: 'background 0.15s',
              userSelect: 'none' as const,
              outline: `1px solid rgba(${rgb},0.2)`,
            }}
          >
            <span style={{
              width: 5, height: 5, borderRadius: '50%', flexShrink: 0,
              background: meta.color, opacity: 0.7,
            }} />
            <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.05em', color: 'rgba(255,255,255,0.45)' }}>
              {meta.label}
            </span>
          </button>
        )
      })}
    </div>
  )
}


// ── Rotating verb placeholder ─────────────────────────────────────────────────



function assignColors(models: Omit<DynamicModel, 'color' | 'rgb'>[]): DynamicModel[] {
  return models.map((m, i) => ({
    ...m,
    ...PALETTE[i % PALETTE.length],
  }))
}

// Robust clipboard copy — Electron/file:// contexts often lack navigator.clipboard,
// so fall back to the legacy textarea+execCommand path.
function copyText(text: string) {
  const fallback = () => {
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      // The app root sets user-select:none, which the temp textarea would inherit —
      // making .select() select nothing and execCommand('copy') copy an empty string.
      ta.style.userSelect = 'text'
      ;(ta.style as any).webkitUserSelect = 'text'
      document.body.appendChild(ta)
      ta.focus()
      ta.select()
      ta.setSelectionRange(0, ta.value.length)
      document.execCommand('copy')
      document.body.removeChild(ta)
    } catch { /* noop */ }
  }
  try {
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).catch(fallback)
    } else {
      fallback()
    }
  } catch {
    fallback()
  }
}

// Lightweight haptic feedback for mobile (no-op where unsupported).
function haptic(style: 'light' | 'medium' | 'heavy' = 'light') {
  try {
    if ('vibrate' in navigator) navigator.vibrate(style === 'light' ? 10 : style === 'medium' ? 20 : 40)
  } catch { /* noop */ }
}

function CopyButton({ text, inline = false, title = 'Copy' }: { text: string; inline?: boolean; title?: string }) {
  const [copied, setCopied] = useState(false)
  const copy = (e: React.MouseEvent) => {
    e.stopPropagation()
    copyText(text)
    haptic('light')
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  return (
    <button onClick={copy} title={title} aria-label={title} style={{
      // Inline: sits in a flex row (code header) so it never overlaps sibling labels.
      // Default: absolute overlay pinned to the top-right of a relative container.
      ...(inline
        ? { position: 'relative' as const, flexShrink: 0 }
        : { position: 'absolute' as const, top: 8, right: 8 }),
      background: 'none', border: 'none', cursor: 'pointer',
      padding: 4, display: 'flex', alignItems: 'center', justifyContent: 'center',
      opacity: copied ? 1 : 0.35, transition: 'opacity 0.2s',
      color: copied ? '#4db89e' : '#aaa',
    }}>
      {copied ? (
        // Checkmark
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <path d="M2.5 7L5.5 10L11.5 4" stroke="#4db89e" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      ) : (
        // Two offset sheets of paper
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <rect x="4" y="1" width="8" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.2"/>
          <rect x="2" y="3" width="8" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.2" fill="rgba(22,22,30,0.9)"/>
        </svg>
      )}
    </button>
  )
}

function FeedbackButtons({ query, synthesis, promptType }: { query: string; synthesis: string; promptType: string }) {
  const [voted, setVoted] = useState<'up' | 'down' | null>(null)
  const vote = (v: 'up' | 'down') => {
    if (voted) return
    setVoted(v)
    apiFetch('/api/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, synthesis, vote: v, promptType }),
    }).catch(() => {})
  }
  return (
    <div style={{ display: 'flex', gap: 2 }}>
      {(['up', 'down'] as const).map(v => (
        <button
          key={v}
          onClick={() => vote(v)}
          title={v === 'up' ? 'Good answer' : 'Bad answer'}
          style={{
            background: voted === v ? (v === 'up' ? 'rgba(77,184,158,0.15)' : 'rgba(248,124,124,0.12)') : 'none',
            border: 'none', cursor: voted ? 'default' : 'pointer',
            padding: '3px 5px', borderRadius: 5,
            color: voted === v ? (v === 'up' ? '#4db89e' : '#f87c7c') : 'rgba(255,255,255,0.18)',
            transition: 'color 0.15s, background 0.15s',
            fontSize: 12, lineHeight: 1,
          }}
        >
          {v === 'up' ? '▲' : '▼'}
        </button>
      ))}
    </div>
  )
}

interface Critique { text: string; done: boolean }

interface Round {
  id: string
  userMessage: string
  models: DynamicModel[]
  synthesisModelId: string
  promptType: string
  complexity: 'simple' | 'complex'
  responses: Record<string, string>
  done: Record<string, boolean>
  scores: Record<string, number | null>
  expandedModel: string | null
  critiques: Record<string, Record<string, Critique>>
  stage3Started: boolean
  stage3Done: boolean
  expandedCritique: { critic: string; target: string } | null
  revisions: Record<string, string>
  revisionsDone: Record<string, boolean>
  stage4Started: boolean
  stage4Done: boolean
  synthesis: string
  synthStreaming: boolean
  synthesisDone: boolean
  verifyStatus: 'idle' | 'running' | 'clean' | 'fixed' | 'needs_model' | 'failed'
  verifyMessage: string
  remediated: Record<string, boolean>
  linterStatus: Record<string, { status: string; score?: number }>
  avgScores: Record<string, number>
  stage2Done: boolean
  activityFeed: Array<{ ts: number; type: string; modelId?: string; message: string }>
  cached: boolean
  semanticSim?: number       // similarity (0–1) when this answer was reused from a paraphrase
  semanticMatch?: string     // the original query this paraphrase matched
  proactiveSuggestion?: string  // M3: ambient context suggestion, if any
  agent?: AgentState | null
  confidence?: {
    overallTier: 'HIGH' | 'MEDIUM' | 'LOW' | 'UNVERIFIED'
    overallScore: number
    summary: { high: number; medium: number; low: number; unverified: number }
    flaggedClaims: Array<{ claim: string; tier: 'LOW' | 'UNVERIFIED' }>
    fragilityAssumption?: string
    frontierQuestion?: string    // H5: open research question surfaced by the pipeline
  }
  criticProblems?: string[]   // I5: adversarial critic findings — process trail only, never touches synthesis
  genealogy?: Record<string, number>  // contribution rate per model in final synthesis (0–1)
  masterpiece?: {              // Track P — MASTERPIECE metadata (display only, not synthesis)
    active: boolean
    shardCount?: number
    shardsCompleted?: number   // P12 — live progress counter during deep mode
    shardsTotal?: number       // P12 — total shards to process
    connectionsFound?: number
    connectionsSurvived?: number
    resonancesFound?: number
    escalatedCount?: number
    elapsedMs?: number
    domains?: string[]
    patterns?: string[]
    shards?: Array<{ id: string; domain: string; preview: string }>
    tiers?: Array<{ shardId: string; tier: string; score: number }>
    specialists?: Array<{ shardId: string; specialist: string; confidence: number }>
  }
  // Track P — light-mode cross-domain connection (only surfaced when novelty > 0.6)
  crossDomainConnection?: string
  // Track U — ANIMA transparency entries (only set on a "what have you learned" query)
  animaTruths?: Array<{ observation: string; domain: string; confidencePct: number; confirmingInstances: number; fragility: string }>
  // Confidence-gated response commitment (low-confidence factual/reasoning answers)
  uncertainCommitment?: { overallScore: number; resolvingStep: string }
}

// ── Agent state (Section 7) — one reducer over the agent SSE event stream ─────
interface AgentStep { id: number; intent: string; status: string; doneCheck?: string }
interface AgentTool { id: string; tool: string; args?: any; ok?: boolean; output?: string; truncated?: boolean; done: boolean }
interface AgentDiff { ts: number; path: string; old?: string; new?: string; patch?: string }
interface AgentVerify { ts: number; passed: boolean; signal: string; report: string; escalate?: boolean }
interface AgentState {
  active: boolean
  driver?: string
  projectPath?: string
  steps: AgentStep[]
  replanned?: boolean
  tools: AgentTool[]
  diffs: AgentDiff[]
  terminal: string[]
  verifies: AgentVerify[]
  thoughts: string[]
  final?: string
  done?: { ok: boolean; stopped: string; iters?: number; toolCallCount?: number; ms?: number }
  error?: string
}

const AGENT_EVENT_TYPES = new Set([
  'agent_start', 'plan', 'step_status', 'tool_call', 'tool_result', 'tool_created',
  'diff', 'verify', 'thought', 'agent_done', 'plan_done', 'agent_error', 'final',
])

function emptyAgentState(): AgentState {
  return { active: true, steps: [], tools: [], diffs: [], terminal: [], verifies: [], thoughts: [] }
}

/** Pure fold of one agent SSE event into AgentState. */
function agentReducer(state: AgentState | null | undefined, ev: any): AgentState {
  const s = state ? { ...state } : emptyAgentState()
  switch (ev.type) {
    case 'agent_start':
      return { ...s, active: true, driver: ev.driver, projectPath: ev.projectPath }
    case 'plan':
      return { ...s, steps: ev.steps ?? s.steps, replanned: ev.replanned ?? s.replanned }
    case 'step_status': {
      const steps = s.steps.map(st => st.id === ev.id ? { ...st, status: ev.status } : st)
      if (!steps.some(st => st.id === ev.id) && ev.intent) steps.push({ id: ev.id, intent: ev.intent, status: ev.status })
      return { ...s, steps }
    }
    case 'tool_call':
      return { ...s, tools: [...s.tools, { id: ev.id, tool: ev.tool, args: ev.args, done: false }] }
    case 'tool_result': {
      const tools = s.tools.map(t => t.id === ev.id && !t.done ? { ...t, ok: ev.ok, output: ev.output, truncated: ev.truncated, done: true } : t)
      // Surface run output in a terminal pane.
      const terminal = ev.tool === 'run' && ev.output ? [...s.terminal, ev.output] : s.terminal
      return { ...s, tools, terminal }
    }
    case 'tool_created':
      return { ...s, tools: [...s.tools, { id: `created_${ev.name}`, tool: 'create_tool', args: { name: ev.name }, ok: true, output: `Created tool: ${ev.name} — ${ev.description}`, done: true }] }
    case 'diff':
      return { ...s, diffs: [...s.diffs, { ts: Date.now(), path: ev.path, old: ev.old, new: ev.new, patch: ev.patch }] }
    case 'verify':
      return { ...s, verifies: [...s.verifies, { ts: Date.now(), passed: ev.passed, signal: ev.signal, report: ev.report, escalate: ev.escalate }] }
    case 'thought':
      return ev.text?.trim() ? { ...s, thoughts: [...s.thoughts, ev.text] } : s
    case 'agent_error':
      return { ...s, error: ev.error, active: false }
    case 'agent_done':
      return { ...s, done: { ok: ev.ok, stopped: ev.stopped, iters: ev.iters, toolCallCount: ev.toolCallCount, ms: ev.ms } }
    case 'plan_done':
      return { ...s, active: false }
    case 'final':
      return { ...s, final: ev.text, active: false }
    default:
      return s
  }
}

function emptyRound(id: string, userMessage: string): Round {
  return {
    id, userMessage,
    models: [], synthesisModelId: '', promptType: '', complexity: 'complex', cached: false,
    responses: {}, done: {}, scores: {},
    expandedModel: null,
    critiques: {},
    stage3Started: false, stage3Done: false, expandedCritique: null,
    revisions: {}, revisionsDone: {},
    stage4Started: false, stage4Done: false,
    synthesis: '', synthStreaming: false, synthesisDone: false,
    verifyStatus: 'idle' as const, verifyMessage: '',
    remediated: {}, linterStatus: {},
    avgScores: {}, stage2Done: false,
    activityFeed: [],
    agent: null,
  }
}

function ShimmerBg({ thinking, mode }: { thinking: boolean; mode: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const ref = useRef(thinking); ref.current = thinking
  const modeRef = useRef(mode); modeRef.current = mode
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')!
    let animId: number, t = 0
    const resize = () => { canvas.width = window.innerWidth; canvas.height = window.innerHeight }
    resize(); window.addEventListener('resize', resize)
    const draw = () => {
      t += 0.003; ctx.clearRect(0, 0, canvas.width, canvas.height)
      // base hue per mode: quorum=255 (violet), code=165 (teal), seeker=38 (amber)
      const modeBase = modeRef.current === 'code' ? 165 : modeRef.current === 'seeker' ? 38 : 255
      const blobs = [
        { x: 0.15, y: 0.35, r: 0.30, h: modeBase + Math.sin(t) * 20 },
        { x: 0.85, y: 0.55, r: 0.25, h: modeBase - 60 + Math.cos(t * 1.3) * 15 },
        { x: 0.50, y: 0.80, r: 0.22, h: modeBase + 45 + Math.sin(t * 0.8) * 25 },
      ]
      const alpha = ref.current ? 0.05 : 0.035
      blobs.forEach(b => {
        const x = b.x * canvas.width, y = b.y * canvas.height
        const r = b.r * Math.min(canvas.width, canvas.height)
        const g = ctx.createRadialGradient(x, y, 0, x, y, r)
        g.addColorStop(0, `hsla(${b.h},70%,60%,${alpha * 2.2})`)
        g.addColorStop(1, `hsla(${b.h},70%,60%,0)`)
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fillStyle = g; ctx.fill()
      })
      animId = requestAnimationFrame(draw)
    }
    draw()
    return () => { cancelAnimationFrame(animId); window.removeEventListener('resize', resize) }
  }, [])
  return <canvas ref={canvasRef} style={{ position: 'fixed', inset: 0, zIndex: 0, pointerEvents: 'none' }} />
}


// ── Pipeline Theater (Section 3) ─────────────────────────────────────────────
// Full-width grid of per-model response cards shown when the user message is clicked.

function LinterBadge({ status }: { status: string }) {
  const cfg =
    status === 'passed'     ? { label: 'pass',   bg: 'rgba(77,184,158,0.15)',  border: 'rgba(77,184,158,0.4)',  color: '#4db89e' } :
    status === 'remediated' ? { label: 'fixed',  bg: 'rgba(245,158,11,0.12)',  border: 'rgba(245,158,11,0.35)', color: '#f59e0b' } :
    status === 'failed'     ? { label: 'failed', bg: 'rgba(248,113,113,0.12)', border: 'rgba(248,113,113,0.35)',color: '#f87171' } :
                              null
  if (!cfg) return null
  return (
    <span style={{
      fontSize: 9, fontWeight: 700, letterSpacing: '0.08em',
      padding: '2px 6px', borderRadius: 4,
      background: cfg.bg, border: `1px solid ${cfg.border}`, color: cfg.color,
    }}>{cfg.label.toUpperCase()}</span>
  )
}

function ModelTheaterCard({ model, round }: { model: DynamicModel; round: Round }) {
  const [showMore, setShowMore] = useState(false)
  const linter = round.linterStatus[model.id]
  const score = round.avgScores[model.id]
  const response = round.responses[model.id] ?? ''
  const isDone = round.done[model.id]

  // Find the richest critique of this model — prefer self-critique; fall back to best peer
  let critiqueText = round.critiques[model.id]?.[model.id]?.text ?? ''
  if (!critiqueText && round.stage3Done) {
    let bestScore = -1
    for (const critic of round.models) {
      if (critic.id === model.id) continue
      const t = round.critiques[critic.id]?.[model.id]?.text
      if (t && (round.avgScores[critic.id] ?? 0) > bestScore) {
        bestScore = round.avgScores[critic.id] ?? 0
        critiqueText = t
      }
    }
  }

  const PREVIEW = 280
  const isLong = response.length > PREVIEW
  const displayText = showMore || !isDone ? response : response.slice(0, PREVIEW) + (isLong ? '…' : '')

  return (
    <div style={{
      borderRadius: 12, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8,
      background: `linear-gradient(145deg, rgba(${model.rgb},0.07) 0%, rgba(10,10,14,0.6) 100%)`,
      backdropFilter: 'blur(24px)', WebkitBackdropFilter: 'blur(24px)',
      border: `1px solid rgba(${model.rgb},0.18)`,
      boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.05)',
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{
          width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
          background: isDone ? model.color : 'transparent',
          border: isDone ? 'none' : `1.5px solid ${model.color}`,
          boxShadow: !isDone ? `0 0 6px ${model.color}` : 'none',
          animation: !isDone ? 'dotpulse 1.2s ease-in-out infinite' : 'none',
        }} />
        <span style={{ fontSize: 11, fontWeight: 700, color: model.color, letterSpacing: '0.04em', flex: 1 }}>
          {model.label}
          {model.isWildcard && <span style={{ fontSize: 8, color: '#555', marginLeft: 3 }}>✦</span>}
        </span>
        {round.stage2Done && score !== undefined && (
          <span style={{
            fontSize: 9, fontWeight: 700,
            color: score >= 0.7 ? '#4db89e' : score >= 0.5 ? '#c084fc' : '#f87171',
            marginRight: 2,
          }}>{(score * 100).toFixed(0)}%</span>
        )}
        {linter && <LinterBadge status={linter.status} />}
      </div>

      {/* Score bar */}
      {round.stage2Done && score !== undefined && (
        <div style={{ height: 2, borderRadius: 2, background: 'rgba(255,255,255,0.05)', overflow: 'hidden' }}>
          <div style={{
            height: '100%', borderRadius: 2,
            width: `${(score * 100).toFixed(1)}%`,
            background: score >= 0.7 ? '#4db89e' : score >= 0.5 ? '#c084fc' : '#f87171',
            transition: 'width 0.8s cubic-bezier(0.22,1,0.36,1)',
          }} />
        </div>
      )}

      {/* Response text */}
      <div style={{
        fontSize: 12, lineHeight: 1.65, color: '#a8a8c0',
        overflowWrap: 'anywhere', wordBreak: 'break-word', whiteSpace: 'pre-wrap',
      }}>
        {displayText || <span style={{ color: '#1e1e2e' }}>···</span>}
      </div>

      {isDone && isLong && (
        <button onClick={() => setShowMore(s => !s)} style={{
          alignSelf: 'flex-start', background: 'none', border: 'none', cursor: 'pointer',
          fontSize: 10, color: `rgba(${model.rgb},0.45)`, letterSpacing: '0.06em', padding: 0,
        }}>
          {showMore ? 'show less' : 'show more'}
        </button>
      )}

      {/* Critique snippet — appears after debate stage */}
      {round.stage3Done && critiqueText && (
        <div style={{
          fontSize: 11, lineHeight: 1.55, color: 'rgba(255,255,255,0.22)',
          borderTop: `1px solid rgba(${model.rgb},0.1)`, paddingTop: 8,
          fontStyle: 'italic',
          overflowWrap: 'anywhere', wordBreak: 'break-word',
        }}>
          {critiqueText.length > 280 ? critiqueText.slice(0, 280) + '…' : critiqueText}
        </div>
      )}
    </div>
  )
}

function PipelineTheater({ round }: { round: Round }) {
  const models = round.models
  if (!models.length) return null
  return (
    <div className="crucible-pipeline-theater" style={{ animation: 'panelUp 0.25s cubic-bezier(0.22,1,0.36,1)' }}>
      <div style={{
        // Responsive auto-fill: cards flow into as many columns as fit, so a 3rd
        // (or 5th) model never sits orphaned in a half-empty row. Mobile.css overrides
        // this to a horizontal scroll strip.
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
        gap: 8,
      }}>
        {models.map(m => <ModelTheaterCard key={m.id} model={m} round={round} />)}
      </div>
    </div>
  )
}

function CritiqueGrid({ round, onToggle }: { round: Round; onToggle: (critic: string, target: string) => void }) {
  const models = round.models
  let doneCount = 0
  const totalPairs = models.length * (models.length - 1)
  for (const critic of models)
    for (const target of models)
      if (critic.id !== target.id && round.critiques[critic.id]?.[target.id]?.done) doneCount++

  const expanded = round.expandedCritique
  return (
    <div className="crucible-critique-grid" style={{ padding: '0 2px', animation: 'panelUp 0.3s cubic-bezier(0.22,1,0.36,1)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <div style={{ height: 1, flex: 1, background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.06))' }} />
        <span style={{
          fontSize: 9, fontWeight: 700, letterSpacing: '0.12em',
          color: round.stage3Done ? '#2e2e4a' : '#7c7cf8', textTransform: 'uppercase' as const,
          animation: round.stage3Done ? 'none' : 'fadeIn 0.5s ease-in-out infinite alternate',
        }}>
          {round.stage3Done ? 'cross-critique complete' : `debating · ${doneCount}/${totalPairs}`}
        </span>
        <div style={{ height: 1, flex: 1, background: 'linear-gradient(90deg, rgba(255,255,255,0.06), transparent)' }} />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        {models.map(critic => {
          const targets = models.filter(t => t.id !== critic.id)
          return (
            <div key={critic.id} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{
                minWidth: 56, maxWidth: 88, flexShrink: 1, textAlign: 'right', paddingRight: 6,
                fontSize: 9, fontWeight: 700, letterSpacing: '0.07em',
                color: `rgba(${critic.rgb},0.35)`, textTransform: 'uppercase' as const,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const,
              }}>{critic.label}</span>
              {targets.map(target => {
                const critique = round.critiques[critic.id]?.[target.id]
                const isDone = critique?.done ?? false
                const isActive = round.stage3Started && !isDone
                const isExpanded = expanded?.critic === critic.id && expanded?.target === target.id
                return (
                  <button key={target.id} onClick={() => isDone && onToggle(critic.id, target.id)} style={{
                    flex: 1, padding: '5px 8px', borderRadius: 7,
                    border: `1px solid ${isExpanded ? `rgba(${target.rgb},0.4)` : isDone ? `rgba(${target.rgb},0.15)` : 'rgba(255,255,255,0.04)'}`,
                    background: isExpanded ? `rgba(${target.rgb},0.08)` : isDone ? `rgba(${target.rgb},0.03)` : 'transparent',
                    cursor: isDone ? 'pointer' : 'default',
                    display: 'flex', alignItems: 'center', gap: 5, outline: 'none', transition: 'all 0.2s',
                  }}>
                    <span style={{
                      width: 4, height: 4, borderRadius: '50%', flexShrink: 0,
                      background: isDone ? target.color : isActive ? target.color : '#1a1a28',
                      boxShadow: isActive ? `0 0 5px ${target.color}` : 'none',
                      animation: isActive ? 'dotpulse 1.2s ease-in-out infinite' : 'none',
                      transition: 'all 0.3s',
                    }} />
                    <span style={{
                      fontSize: 9.5, fontWeight: 600, letterSpacing: '0.04em',
                      color: isExpanded ? target.color : isDone ? `rgba(${target.rgb},0.5)` : '#1e1e2e',
                      whiteSpace: 'nowrap' as const, transition: 'color 0.2s',
                      overflow: 'hidden', textOverflow: 'ellipsis',
                    }}>→ {target.label}</span>
                  </button>
                )
              })}
            </div>
          )
        })}
      </div>
      {expanded && (() => {
        const critique = round.critiques[expanded.critic]?.[expanded.target]
        if (!critique?.text) return null
        const criticModel = round.models.find(m => m.id === expanded.critic)!
        const targetModel = round.models.find(m => m.id === expanded.target)!
        if (!criticModel || !targetModel) return null
        return (
          <div style={{
            marginTop: 8, borderRadius: 10, padding: '10px 14px',
            background: `linear-gradient(135deg, rgba(${criticModel.rgb},0.05) 0%, rgba(10,10,14,0.75) 100%)`,
            backdropFilter: 'blur(24px)', WebkitBackdropFilter: 'blur(24px)',
            border: `1px solid rgba(${criticModel.rgb},0.15)`,
            boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.04)',
            animation: 'panelUp 0.18s cubic-bezier(0.22,1,0.36,1)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 8 }}>
              <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', color: `rgba(${criticModel.rgb},0.6)`, textTransform: 'uppercase' as const }}>{criticModel.label}</span>
              <span style={{ fontSize: 9, color: '#2a2a3a' }}>critiques</span>
              <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', color: `rgba(${targetModel.rgb},0.6)`, textTransform: 'uppercase' as const }}>{targetModel.label}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 4 }}>
              <CopyButton text={critique.text} inline title="Copy critique" />
            </div>
            <div style={{ fontSize: 12.5, lineHeight: 1.7, color: '#b0b0c4', whiteSpace: 'pre-wrap', maxHeight: '28vh', overflowY: 'auto', overflowWrap: 'anywhere', wordBreak: 'break-word', userSelect: 'text', scrollbarWidth: 'thin', scrollbarColor: 'rgba(255,255,255,0.1) transparent' }}>
              {critique.text}
            </div>
          </div>
        )
      })()}
    </div>
  )
}

// ── Agent panel (Section 7) — live loop surface ───────────────────────────────
const STEP_GLYPH: Record<string, string> = { pending: '○', active: '◐', done: '●', failed: '✕' }
const STEP_COLOR: Record<string, string> = { pending: '#555', active: '#7c7cf8', done: '#4ade80', failed: '#f87171' }
const TOOL_GLYPH: Record<string, string> = {
  write_file: '+', edit_file: '~', apply_patch: '~', read_file: '<',
  list_dir: '/', search: '?', run: '>', ensemble_solve: '*',
}

function DiffBlock({ d }: { d: AgentDiff }) {
  const rel = d.path.split('/').slice(-2).join('/')
  return (
    <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: 10.5, lineHeight: 1.5, marginTop: 4, maxHeight: 200, overflowY: 'auto', overflowX: 'hidden' }}>
      <div style={{ color: '#888', marginBottom: 2 }}>{rel}</div>
      {d.patch ? (
        <pre style={{ margin: 0, whiteSpace: 'pre-wrap' as const }}>
          {d.patch.split('\n').map((ln, i) => (
            <div key={i} style={{
              background: ln.startsWith('+') ? 'rgba(74,222,128,0.12)' : ln.startsWith('-') ? 'rgba(248,113,113,0.12)' : 'transparent',
              color: ln.startsWith('+') ? '#86efac' : ln.startsWith('-') ? '#fca5a5' : '#999', padding: '0 4px',
            }}>{ln || ' '}</div>
          ))}
        </pre>
      ) : (
        <pre style={{ margin: 0, whiteSpace: 'pre-wrap' as const }}>
          {(d.old ?? '').split('\n').map((ln, i) => <div key={'o' + i} style={{ background: 'rgba(248,113,113,0.12)', color: '#fca5a5', padding: '0 4px' }}>- {ln}</div>)}
          {(d.new ?? '').split('\n').map((ln, i) => <div key={'n' + i} style={{ background: 'rgba(74,222,128,0.12)', color: '#86efac', padding: '0 4px' }}>+ {ln}</div>)}
        </pre>
      )}
    </div>
  )
}

function ToolRow({ t }: { t: AgentTool }) {
  const [open, setOpen] = useState(false)
  const color = t.done ? (t.ok ? '#4ade80' : '#f87171') : '#7c7cf8'
  const label = t.tool === 'run' && t.args?.command ? t.args.command
    : t.tool === 'search' && t.args?.pattern ? `/${t.args.pattern}/`
    : (t.args?.path ?? t.args?.subprompt?.slice?.(0, 60) ?? '')
  return (
    <div style={{ borderLeft: `2px solid ${color}`, paddingLeft: 8, marginBottom: 3 }}>
      <div onClick={() => t.output && setOpen(o => !o)} style={{
        display: 'flex', alignItems: 'center', gap: 6, cursor: t.output ? 'pointer' : 'default',
        fontSize: 11, color: '#bbb', fontFamily: 'ui-monospace, monospace',
      }}>
        <span style={{ color }}>{t.done ? (t.ok ? '✓' : '✕') : (TOOL_GLYPH[t.tool] ?? '·')}</span>
        <span style={{ fontWeight: 600, color: '#ddd' }}>{t.tool}</span>
        <span style={{ color: '#777', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const, flex: 1 }}>{String(label)}</span>
        {t.output && <span style={{ color: '#555', fontSize: 9 }}>{open ? '▾' : '▸'}</span>}
      </div>
      {open && t.output && (
        <pre style={{
          margin: '3px 0 0', padding: 6, background: 'rgba(0,0,0,0.4)', borderRadius: 4,
          fontSize: 10, color: '#9a9', whiteSpace: 'pre-wrap' as const, maxHeight: 200, overflow: 'auto',
        }}>{t.output}{t.truncated ? '\n…(truncated)' : ''}</pre>
      )}
    </div>
  )
}

// When the verify/refinement pass returns fixed code, splice it back INTO the original
// answer's first fenced code block — preserving the language tag, surrounding prose, and
// the CollapsibleCode rendering. Only the code changes; the UI shape stays identical.
// Falls back to wrapping in a fence if the original had no code block.
// VAPID public key (base64url) → Uint8Array for PushManager.subscribe.
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  const arr = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i)
  return arr
}

function applyFixedCode(original: string, fixedCode: string): string {
  if (!fixedCode) return original
  // If the fixer wrapped its output in its own fence, splice only the inner code so we
  // never nest fences or inherit a stray language tag (this caused "code reset to TypeScript").
  let inner = fixedCode.trim()
  const selfFence = /^```[a-zA-Z0-9_+-]*\n([\s\S]*?)\n```$/.exec(inner)
  if (selfFence) inner = selfFence[1].trim()

  // CRITICAL backstop: the verify pass sometimes returns a NON-code response — a refusal,
  // an explanation, or "// No change needed…" — or a degenerate stub. Never let that
  // overwrite a real code answer (this destroyed a full code block, replacing it with a
  // one-line comment). Reject any "fix" that is comment/whitespace-only or drastically
  // smaller than the code it would replace.
  const fenceRe = /```([a-zA-Z0-9_+-]*)\n([\s\S]*?)\n```/
  const m = fenceRe.exec(original)
  const realCodeLines = inner.split('\n').filter(l => {
    const t = l.trim()
    return t && !t.startsWith('//') && !t.startsWith('#') && !t.startsWith('/*') && !t.startsWith('*')
  })
  if (realCodeLines.length === 0) return original            // only comments / blank → not a fix
  const originalCode = m ? m[2].trim() : ''
  if (originalCode.length > 120 && inner.length < originalCode.length * 0.5) return original  // gutted answer

  if (m) {
    // Preserve the ORIGINAL language tag verbatim — never relabel python/etc. as TypeScript.
    return original.replace(fenceRe, (_full, lang) => '```' + (lang || '') + '\n' + inner + '\n```')
  }
  // No fenced block in the original — it's a prose answer. Do NOT wrap it into a code
  // block; that's the "plain text turned into a TypeScript block" bug. Leave prose alone.
  return original
}

// Personality-driven, deterministic narration of how this specific answer came together.
// Pure inference from the round's own data (scores, spread, critiques, model sizes, verify
// outcome) — no model call, no randomness, so it reads the same every time you reopen it but
// is different for every prompt. Replaces the old one-size-fits-all "Process" sentence.
function narrateProcess(round: any, active: any[], dropped: any[], synthesizer: any, topScore: number): string {
  const scores = active.map(m => round.avgScores[m.id] ?? 0)
  const minScore = scores.length ? Math.min(...scores) : topScore
  const spread = topScore - minScore
  const critiqueCount = Object.keys(round.critiques ?? {}).length
  const sizeOf = (label: string): number | null => {
    const m = /(\d+(?:\.\d+)?)\s*B\b/i.exec(label || '')
    return m ? parseFloat(m[1]) : null
  }
  const synthSize = sizeOf(synthesizer?.label ?? '')
  const parts: string[] = []

  // 1) Opener — set by how hard the answer was to reach.
  if (round.complexity === 'simple' || topScore >= 0.85) {
    if (spread < 0.10) {
      parts.push('A straightforward one — the models were in immediate agreement and moved fast.')
    } else {
      parts.push('A simple enough question, though the models took slightly different angles before settling on the same answer.')
    }
  } else if (topScore >= 0.92 && spread < 0.12) {
    parts.push('This came together cleanly: the models were in strong agreement from the very first pass, so little arbitration was needed.')
  } else if (topScore >= 0.82) {
    parts.push('A solid run — the first answers were close, and a round of mutual critique sharpened the lead before synthesis.')
  } else if (topScore >= 0.68) {
    parts.push('This one took some real thinking. The opening answers were uneven, so the models picked each other apart and revised before they converged.')
  } else {
    parts.push('A genuinely hard prompt — no model had it cleanly at first. The answer was rebuilt from the strongest fragments after the models challenged every weak point.')
  }

  // 2) Underdog callout — a small model that matched the big ones.
  const underdog = active
    .map(m => ({ m, size: sizeOf(m.label), s: round.avgScores[m.id] ?? 0 }))
    .filter(x => x.size !== null && x.size <= 9 && x.s >= topScore - 0.04)
    .sort((a, b) => (a.size as number) - (b.size as number))[0]
  if (underdog && (!synthSize || (underdog.size as number) < synthSize)) {
    parts.push(`Worth noting — ${underdog.m.label} (${underdog.size}B) punched well above its weight, holding its own against models many times larger.`)
  }

  // 3) Disagreement texture.
  if (spread >= 0.25 && critiqueCount >= 2) {
    parts.push('The models genuinely disagreed early; the cross-critique is what pulled them onto the same page.')
  }

  // 4) Verification outcome, if code was run.
  if (round.verifyStatus === 'fixed') {
    parts.push('The first synthesis didn’t execute clean, so the verification pass caught the bug and repaired it before you saw it.')
  } else if (round.verifyStatus === 'clean') {
    parts.push('The final code ran clean on the first try.')
  }

  // 5) Resilience note if models dropped.
  if (dropped.length > 0) {
    parts.push(`All of this held together even after ${dropped.map((m: any) => m.label).join(' and ')} dropped out mid-run.`)
  }

  // U11 — ANIMA active indicator: when ANIMA has live truths it shaped this response,
  // surface a quiet note so the user knows the system is learning about them over time.
  if (round.animaTruths && round.animaTruths.length > 0) {
    parts.push(`ANIMA shaped this response with ${round.animaTruths.length} observed pattern${round.animaTruths.length === 1 ? '' : 's'} about human experience.`)
  }

  return parts.join(' ')
}

// ── Session history binder ─────────────────────────────────────────────────────
type HistorySession = { ts: number; query: string; promptType: string; models: string[]; synthesis: string }

const PTYPE_COLOR: Record<string, string> = {
  code: '124,124,248', math: '192,132,252', creative: '77,184,158',
  logic: '245,158,11', factual: '96,165,250', general: '100,100,130',
}

function ptypeRgb(pt: string) { return PTYPE_COLOR[pt] ?? PTYPE_COLOR.general }

// HistoryBinder — rendered inside the topbar button cluster.
// The trigger is just a small clock icon button that sits beside the hamburger.
// Clicking opens a floating frosted-glass card anchored below-right of the trigger.
// Hovering a row smoothly expands it to show the synthesis snippet.
function HistoryBinder({ onRestore }: { onRestore: (session: HistorySession) => void }) {
  const [open, setOpen]           = useState(false)
  const [sessions, setSessions]   = useState<HistorySession[]>([])
  const [search, setSearch]       = useState('')
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null)
  const [loading, setLoading]     = useState(false)
  const [loaded, setLoaded]       = useState(false)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const panelRef   = useRef<HTMLDivElement | null>(null)

  const fetchHistory = () =>
    apiFetch('/api/history')
      .then(r => r.json())
      .then(d => { setSessions(d.sessions ?? []); setLoading(false); setLoaded(true) })
      .catch(() => { setLoading(false); setLoaded(true) })

  useEffect(() => {
    if (!open || loaded) return
    setLoading(true)
    fetchHistory()
  }, [open, loaded])

  // Poll every 30s while open
  useEffect(() => {
    if (!open) return
    const id = setInterval(() => fetchHistory(), 30_000)
    return () => clearInterval(id)
  }, [open])

  // Close on outside click
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (
        triggerRef.current?.contains(e.target as Node) ||
        panelRef.current?.contains(e.target as Node)
      ) return
      setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  // Close on ESC
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  const filtered = sessions.filter(s =>
    !search ||
    s.query.toLowerCase().includes(search.toLowerCase()) ||
    s.synthesis.toLowerCase().includes(search.toLowerCase())
  )

  // Relative timestamp — "just now" / "2 hours ago" / "3 days ago" / a date.
  const relTime = (ts: number) => {
    const diff = Date.now() - ts
    const min = Math.floor(diff / 60000)
    if (min < 1) return 'just now'
    if (min < 60) return `${min} min ago`
    const hr = Math.floor(min / 60)
    if (hr < 24) return `${hr} hour${hr === 1 ? '' : 's'} ago`
    const day = Math.floor(hr / 24)
    if (day < 7) return `${day} day${day === 1 ? '' : 's'} ago`
    return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' })
  }

  // Auto-label — first 7 words of the query, ellipsised.
  const autoLabel = (q: string) => {
    const words = q.trim().split(/\s+/)
    return words.slice(0, 7).join(' ') + (words.length > 7 ? '…' : '')
  }

  // Bucket a timestamp into Today / Yesterday / This Week / Earlier.
  const bucketOf = (ts: number): string => {
    const d = new Date(ts), now = new Date()
    if (d.toDateString() === now.toDateString()) return 'Today'
    const yest = new Date(now); yest.setDate(now.getDate() - 1)
    if (d.toDateString() === yest.toDateString()) return 'Yesterday'
    if (Date.now() - ts < 7 * 86400000) return 'This Week'
    return 'Earlier'
  }
  const BUCKET_ORDER = ['Today', 'Yesterday', 'This Week', 'Earlier']
  // Ordered [bucketLabel, sessions[]] pairs, preserving the filtered (recency) order within.
  const grouped = BUCKET_ORDER
    .map(b => [b, filtered.filter(s => bucketOf(s.ts) === b)] as const)
    .filter(([, items]) => items.length > 0)

  return (
    <div className="crucible-history-binder" style={{ position: 'relative' }}>
      <style>{`
        @keyframes histSlideIn {
          from { transform: translateX(100%); }
          to   { transform: translateX(0); }
        }
        @keyframes histScrimIn {
          from { opacity: 0; }
          to   { opacity: 1; }
        }
        @keyframes histPrism {
          0%   { background-position: 0%   50%; }
          100% { background-position: 300% 50%; }
        }
        .hrow-expand {
          display: grid;
          grid-template-rows: 0fr;
          transition: grid-template-rows 0.26s cubic-bezier(0.22,1,0.36,1);
        }
        .hrow-expand.open { grid-template-rows: 1fr; }
        .hrow-expand > div { overflow: hidden; }
      `}</style>

      {/* Trigger — clock icon, matches topbar button style */}
      <button
        ref={triggerRef}
        onClick={() => setOpen(o => !o)}
        title="Session history"
        style={{
          background: open ? 'rgba(124,124,248,0.1)' : 'none',
          border: 'none', cursor: 'pointer',
          color: open ? '#9090f8' : '#555',
          padding: '6px 7px', borderRadius: 8,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          transition: 'color 0.18s, background 0.18s',
        }}
      >
        {/* Clock SVG */}
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
          <circle cx="8" cy="8" r="6.2" stroke="currentColor" strokeWidth="1.4"/>
          <path d="M8 5v3.2l2.2 1.3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </button>

      {/* Scrim — dims the app behind the drawer, click to close */}
      {open && (
        <div
          onClick={() => setOpen(false)}
          style={{
            position: 'fixed', inset: 0, zIndex: 89,
            background: 'rgba(0,0,0,0.45)',
            animation: 'histScrimIn 0.28s ease',
          }}
        />
      )}

      {/* Full-height drawer — slides in from the right edge */}
      {open && (
        <div
          ref={panelRef}
          className="crucible-history-drawer"
          style={{
            position: 'fixed',
            top: 0, right: 0, bottom: 0,
            width: 'min(380px, 92vw)',
            zIndex: 90,
            display: 'flex', flexDirection: 'column',
            // Frosted glass — same language as the rest of the app
            background: 'rgba(13,13,20,0.82)',
            backdropFilter: 'blur(40px) saturate(1.5)',
            WebkitBackdropFilter: 'blur(40px) saturate(1.5)',
            borderLeft: '1px solid rgba(255,255,255,0.08)',
            boxShadow: '-24px 0 80px rgba(0,0,0,0.5), inset 1px 0 0 rgba(255,255,255,0.05)',
            animation: 'histSlideIn 0.28s cubic-bezier(0.22,1,0.36,1)',
            overflow: 'hidden',
          }}
        >
          {/* Prismatic top edge */}
          <div style={{
            height: 2, flexShrink: 0,
            background: 'linear-gradient(90deg, #7c7cf8, #4db89e, #c084fc, #f59e0b, #7c7cf8)',
            backgroundSize: '300% 100%',
            animation: 'histPrism 8s linear infinite',
            opacity: 0.65,
          }} />

          {/* Header */}
          <div style={{
            padding: 'calc(14px + env(safe-area-inset-top, 0px)) 16px 10px', flexShrink: 0,
            borderBottom: '1px solid rgba(255,255,255,0.05)',
            display: 'flex', alignItems: 'center', gap: 8,
          }}>
            <span style={{
              fontSize: 10, fontWeight: 700, letterSpacing: '0.14em',
              color: 'rgba(160,160,200,0.6)', textTransform: 'uppercase', flex: 1,
            }}>Conversations{sessions.length > 0 ? ` · ${sessions.length}` : ''}</span>
            <input
              value={search} onChange={e => setSearch(e.target.value)}
              placeholder="search…"
              style={{
                background: 'rgba(255,255,255,0.05)',
                border: '1px solid rgba(255,255,255,0.07)',
                borderRadius: 8, padding: '6px 10px',
                fontSize: 12, color: '#c8c8e8', outline: 'none',
                fontFamily: 'inherit', width: 110,
              }}
            />
            <button
              onClick={() => setOpen(false)}
              aria-label="Close"
              style={{
                background: 'none', border: 'none', cursor: 'pointer', color: '#666',
                width: 32, height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center',
                borderRadius: 8, flexShrink: 0,
              }}
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
              </svg>
            </button>
          </div>

          {/* List */}
          <div style={{ flex: 1, overflowY: 'auto', minHeight: 0, WebkitOverflowScrolling: 'touch' }}>
            {loading && (
              <div style={{ textAlign: 'center', color: '#333', fontSize: 12, padding: '32px 0' }}>loading…</div>
            )}
            {!loading && filtered.length === 0 && (
              <div style={{
                display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                gap: 16, padding: '60px 24px', textAlign: 'center',
              }}>
                <svg width="56" height="56" viewBox="0 0 56 56" fill="none" style={{ opacity: 0.5 }}>
                  <circle cx="28" cy="28" r="20" stroke="rgba(124,124,248,0.3)" strokeWidth="1.5"/>
                  <path d="M28 17v12l8 5" stroke="rgba(124,124,248,0.35)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                  <path d="M28 8a20 20 0 0 1 0 40" stroke="rgba(77,184,158,0.25)" strokeWidth="1.5" strokeLinecap="round"/>
                </svg>
                <span style={{ color: 'rgba(160,160,200,0.45)', fontSize: 12, lineHeight: 1.7 }}>
                  {search ? 'No matches' : 'Your conversations will appear here'}
                </span>
              </div>
            )}
            {grouped.map(([bucket, items]) => (
              <div key={bucket}>
                {/* Date-group header */}
                <div style={{
                  position: 'sticky', top: 0, zIndex: 1,
                  padding: '10px 16px 5px',
                  background: 'rgba(13,13,20,0.6)',
                  backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)',
                  fontSize: 9, fontWeight: 700, letterSpacing: '0.16em',
                  color: 'rgba(160,160,200,0.4)', textTransform: 'uppercase',
                }}>{bucket}</div>
                {items.map(s => {
                  const rgb = ptypeRgb(s.promptType)
                  const isHov = hoveredIdx === s.ts
                  return (
                    <div
                      key={s.ts}
                      onMouseEnter={() => setHoveredIdx(s.ts)}
                      onMouseLeave={() => setHoveredIdx(null)}
                      onClick={() => { onRestore(s); setOpen(false) }}
                      style={{
                        minHeight: 48, padding: '11px 16px 11px 18px',
                        borderBottom: '1px solid rgba(255,255,255,0.03)',
                        background: isHov ? `rgba(${rgb},0.05)` : 'transparent',
                        transition: 'background 0.16s ease',
                        position: 'relative', cursor: 'pointer',
                      }}
                    >
                      {/* Type-color left stripe */}
                      <div style={{
                        position: 'absolute', left: 0, top: 10, bottom: 10, width: 2, borderRadius: 2,
                        background: `rgba(${rgb},${isHov ? 0.8 : 0.25})`,
                        transition: 'background 0.2s',
                      }} />

                      {/* Auto-label (first 7 words) */}
                      <div style={{
                        fontSize: 12.5, lineHeight: 1.5, fontWeight: 500,
                        color: isHov ? '#e4e4f8' : 'rgba(170,170,210,0.8)',
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        transition: 'color 0.16s',
                      }}>
                        {autoLabel(s.query)}
                      </div>

                      {/* Badges + model count + relative timestamp */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 5 }}>
                        <span style={{
                          fontSize: 8, fontWeight: 700, letterSpacing: '0.1em',
                          color: `rgba(${rgb},0.6)`, textTransform: 'uppercase',
                          background: `rgba(${rgb},0.08)`, padding: '2px 6px',
                          borderRadius: 3, border: `1px solid rgba(${rgb},0.13)`,
                        }}>{s.promptType || 'general'}</span>
                        {s.models.length > 0 && (
                          <span style={{ fontSize: 9, color: 'rgba(160,160,200,0.4)' }}>
                            {s.models.length} model{s.models.length === 1 ? '' : 's'}
                          </span>
                        )}
                        <span style={{ fontSize: 9, color: '#2f2f48', marginLeft: 'auto' }}>{relTime(s.ts)}</span>
                      </div>

                      {/* Hover-expand: synthesis preview + actions */}
                      <div className={`hrow-expand${isHov ? ' open' : ''}`}>
                        <div>
                          <div style={{ paddingTop: 8 }}>
                            <div style={{
                              fontSize: 11, lineHeight: 1.65,
                              color: 'rgba(160,160,200,0.45)',
                              maxHeight: 110, overflowY: 'auto',
                              whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                            }}>
                              {s.synthesis.length > 280 ? s.synthesis.slice(0, 280) + '…' : s.synthesis || '—'}
                            </div>
                            <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 10 }}>
                              <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.10em', color: `rgba(${rgb},0.5)`, textTransform: 'uppercase' }}>tap to restore</span>
                              <button
                                onClick={e => {
                                  e.stopPropagation()
                                  const md = `# ${s.query}\n\n**${s.promptType || 'general'}** · ${new Date(s.ts).toLocaleString()}\n\n**Models:** ${s.models.join(', ')}\n\n---\n\n${s.synthesis}`
                                  const a = document.createElement('a')
                                  a.href = URL.createObjectURL(new Blob([md], { type: 'text/markdown' }))
                                  a.download = `crucible-${s.ts}.md`
                                  a.click()
                                }}
                                style={{
                                  background: 'none', border: `1px solid rgba(${rgb},0.2)`, borderRadius: 4,
                                  color: `rgba(${rgb},0.5)`, fontSize: 9, fontWeight: 700,
                                  letterSpacing: '0.08em', textTransform: 'uppercase', padding: '3px 8px',
                                  cursor: 'pointer', transition: 'border-color 0.15s, color 0.15s',
                                }}
                              >export md</button>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// Collapsible code block — collapsed by default on mobile, always expanded on desktop
function CollapsibleCode({ language, code }: { language: string; code: string }) {
  const lineCount = code.split('\n').length
  const [expanded, setExpanded] = useState(false)
  return (
    <div className="crucible-code-block" style={{ position: 'relative', margin: '12px 0', borderRadius: 10, overflow: 'hidden', maxWidth: '100%', boxSizing: 'border-box' as const }}>
      {/* Always-visible header */}
      <div
        className="crucible-code-header"
        onClick={() => setExpanded(e => !e)}
        style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          padding: '6px 12px', background: 'rgba(0,0,0,0.4)',
          borderBottom: '1px solid rgba(255,255,255,0.08)',
          cursor: 'pointer', userSelect: 'none' as const,
        }}>
        <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.3)', letterSpacing: '0.08em' }}>{language.toUpperCase()}</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="crucible-code-lines" style={{ fontSize: 9, color: 'rgba(255,255,255,0.2)' }}>{lineCount} lines</span>
          <span className="crucible-expand-hint" style={{ fontSize: 9, color: 'rgba(124,124,248,0.6)' }}>{expanded ? 'collapse' : 'expand'}</span>
          <CopyButton text={code} inline />
        </div>
      </div>
      {/* Body — hidden on mobile until expanded */}
      <div className={expanded ? 'crucible-code-body crucible-code-body--open' : 'crucible-code-body'}>
        <SyntaxHighlighter
          style={oneDark}
          language={language}
          PreTag="div"
          wrapLongLines
          customStyle={{ margin: 0, borderRadius: 0, fontSize: 12, background: 'rgba(0,0,0,0.3)', maxWidth: '100%', boxSizing: 'border-box', whiteSpace: 'pre-wrap', wordBreak: 'break-word', overflowWrap: 'anywhere', userSelect: 'text' }}
          codeTagProps={{ style: { whiteSpace: 'pre-wrap', wordBreak: 'break-word', overflowWrap: 'anywhere', display: 'block' } }}
        >{code}</SyntaxHighlighter>
      </div>
    </div>
  )
}

function AgentPanel({ agent }: { agent: AgentState }) {
  const verifyByLatest = agent.verifies[agent.verifies.length - 1]
  return (
    <div style={{
      animation: 'panelUp 0.3s cubic-bezier(0.22,1,0.36,1)',
      border: '1px solid rgba(124,124,248,0.18)', borderRadius: 12, padding: 12,
      background: 'rgba(124,124,248,0.04)', display: 'flex', flexDirection: 'column', gap: 10,
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 9.5, letterSpacing: '0.12em', textTransform: 'uppercase' as const, color: '#7c7cf8', fontWeight: 700 }}>
        <span style={{ animation: agent.active ? 'fadeIn 0.5s ease-in-out infinite alternate' : 'none' }}>
          {agent.active ? 'agent working' : agent.done?.ok ? 'agent complete' : agent.error ? 'agent error' : 'agent finished'}
        </span>
        {agent.driver && <span style={{ color: '#555', textTransform: 'none' as const, letterSpacing: 0 }}>· {agent.driver}</span>}
        <div style={{ flex: 1 }} />
        {agent.done?.ms != null && <span style={{ color: '#555', textTransform: 'none' as const, letterSpacing: 0 }}>{(agent.done.ms / 1000).toFixed(1)}s</span>}
      </div>

      {/* Plan checklist */}
      {agent.steps.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          {agent.steps.map(st => (
            <div key={st.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 7, fontSize: 11.5, color: st.status === 'done' ? '#777' : '#ccc' }}>
              <span style={{ color: STEP_COLOR[st.status] ?? '#555', flexShrink: 0 }}>{STEP_GLYPH[st.status] ?? '○'}</span>
              <span style={{ textDecoration: st.status === 'done' ? 'line-through' : 'none' }}>{st.intent}</span>
            </div>
          ))}
          {agent.replanned && <div style={{ fontSize: 9, color: '#fbbf24' }}>↻ replanned</div>}
        </div>
      )}

      {/* Tool timeline */}
      {agent.tools.length > 0 && (
        <div>
          <div style={{ fontSize: 9, color: '#555', letterSpacing: '0.1em', textTransform: 'uppercase' as const, marginBottom: 4 }}>tools · {agent.tools.length}</div>
          <div style={{
            maxHeight: 180, overflowY: 'auto', overflowX: 'hidden',
            background: 'rgba(0,0,0,0.5)', borderRadius: 6,
            border: '1px solid rgba(255,255,255,0.06)', padding: '8px 14px 8px 8px',
          }}>
            {/* Most-recent-first: tools are appended chronologically, so render reversed. */}
            {agent.tools.map((t, i) => [t, i] as const).reverse().map(([t, i]) => <ToolRow key={`${t.id}:${i}`} t={t} />)}
          </div>
        </div>
      )}

      {/* Diffs */}
      {agent.diffs.length > 0 && (
        <div>
          <div style={{ fontSize: 9, color: '#555', letterSpacing: '0.1em', textTransform: 'uppercase' as const, marginBottom: 4 }}>changes · {agent.diffs.length}</div>
          <div style={{ maxHeight: 280, overflowY: 'auto', overflowX: 'hidden', paddingRight: 2 }}>
            {agent.diffs.slice(-4).map((d, i) => <DiffBlock key={i} d={d} />)}
          </div>
        </div>
      )}

      {/* Terminal */}
      {agent.terminal.length > 0 && (
        <div>
          <div style={{ fontSize: 9, color: '#555', letterSpacing: '0.1em', textTransform: 'uppercase' as const, marginBottom: 4 }}>terminal</div>
          <div style={{ position: 'relative' }}>
            <CopyButton text={agent.terminal.join('\n')} />
            <pre className="crucible-terminal-pre" style={{
              margin: 0, padding: 8, background: 'rgba(0,0,0,0.5)', borderRadius: 6,
              fontSize: 10, lineHeight: 1.5, color: '#9fef9f', fontFamily: 'ui-monospace, monospace',
              whiteSpace: 'pre-wrap' as const, maxHeight: 180, overflow: 'auto',
            }}>{agent.terminal.slice(-3).join('\n')}</pre>
          </div>
        </div>
      )}

      {/* Verify badge */}
      {verifyByLatest && (
        <div style={{
          display: 'inline-flex', alignItems: 'center', gap: 6, alignSelf: 'flex-start',
          padding: '4px 10px', borderRadius: 8, fontSize: 10.5, fontWeight: 600,
          background: verifyByLatest.passed ? 'rgba(74,222,128,0.12)' : 'rgba(248,113,113,0.12)',
          color: verifyByLatest.passed ? '#86efac' : '#fca5a5',
          border: `1px solid ${verifyByLatest.passed ? 'rgba(74,222,128,0.3)' : 'rgba(248,113,113,0.3)'}`,
        }}>
          {verifyByLatest.passed ? '✓ verified' : verifyByLatest.escalate ? '✕ unfixable — stopped' : '↻ healing'} · {verifyByLatest.signal}
        </div>
      )}

      {agent.error && <div style={{ fontSize: 11, color: '#fca5a5' }}>{agent.error}</div>}
    </div>
  )
}

// ── Auth UI ────────────────────────────────────────────────────────────────────

function AuthScreen({ onAuth }: { onAuth: (user: { id: string; email: string }) => void }) {
  // Check for ?auth_error= param from OAuth callback redirect
  const [error] = useState(() => {
    const p = new URLSearchParams(window.location.search)
    return p.get('auth_error') ?? ''
  })

  // After OAuth the server redirects back here — poll /api/auth/me once on mount
  // in case the cookie was just set by the callback redirect.
  useEffect(() => {
    apiFetch(`${API_BASE}/api/auth/me`)
      .then(r => r.ok ? r.json() : null)
      .then(user => { if (user) onAuth(user) })
      .catch(() => {})
  }, [])

  const oauthBtnStyle = (bg: string): React.CSSProperties => ({
    width: '100%', padding: '13px 16px', borderRadius: 10,
    border: '1px solid rgba(255,255,255,0.08)',
    background: bg, color: '#fff',
    fontSize: 14, fontWeight: 600, cursor: 'pointer',
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
    transition: 'opacity 0.18s, transform 0.12s',
    fontFamily: 'inherit', letterSpacing: '0.01em',
    minHeight: 48,
  })

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 999,
      background: '#0a0a0e',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      animation: 'authFadeIn 0.4s ease',
    }}>
      <style>{`
        @keyframes authFadeIn { from { opacity: 0 } to { opacity: 1 } }
        .oauth-btn:hover { opacity: 0.82 !important; transform: translateY(-1px); }
        .oauth-btn:active { transform: translateY(0); }
      `}</style>
      <div style={{ width: '100%', maxWidth: 340, padding: '0 24px', textAlign: 'center' }}>
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 12 }}>
          <CrucibleMark thinking={false} done={false} />
        </div>
        <div style={{ fontSize: 22, fontWeight: 700, color: '#e4e4f8', letterSpacing: '-0.02em', marginBottom: 4 }}>
          Crucible
        </div>
        <div style={{ fontSize: 12, color: 'rgba(160,160,200,0.4)', marginBottom: 40 }}>
          Adversarial ensemble reasoning
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {/* Sign in with Google */}
          <button
            className="oauth-btn"
            style={oauthBtnStyle('rgba(255,255,255,0.06)')}
            onClick={() => { window.location.href = `${API_BASE}/api/auth/google` }}
          >
            {/* Google G logo */}
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
              <path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615Z" fill="#4285F4"/>
              <path d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18Z" fill="#34A853"/>
              <path d="M3.964 10.706A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.706V4.962H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.038l3.007-2.332Z" fill="#FBBC05"/>
              <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.962L3.964 7.294C4.672 5.163 6.656 3.58 9 3.58Z" fill="#EA4335"/>
            </svg>
            Continue with Google
          </button>

          {/* Sign in with GitHub */}
          <button
            className="oauth-btn"
            style={oauthBtnStyle('rgba(255,255,255,0.06)')}
            onClick={() => { window.location.href = `${API_BASE}/api/auth/github` }}
          >
            {/* GitHub mark */}
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0 1 12 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12Z"/>
            </svg>
            Continue with GitHub
          </button>
        </div>

        {error && (
          <div style={{ marginTop: 20, fontSize: 12, color: '#fca5a5' }}>
            {decodeURIComponent(error)}
          </div>
        )}

        <div style={{ marginTop: 28, fontSize: 11, color: 'rgba(160,160,200,0.3)', lineHeight: 1.6 }}>
          No passwords stored. Your identity is verified by Google or GitHub.
        </div>
      </div>
    </div>
  )
}

export default function App() {
  const [rounds, setRounds]               = useState<Round[]>([])
  const [input, setInput]                 = useState('')
  const [menuOpen, setMenuOpen]           = useState(false)
  const [thinking, setThinking]           = useState(false)
  // ── Agent live timer ──────────────────────────────────────────────────────
  const [agentStartTime, setAgentStartTime]   = useState<number | null>(null)
  const [agentElapsed, setAgentElapsed]       = useState(0)
  const [agentProgress, setAgentProgress]     = useState<{
    stepIndex: number; stepTotal: number; stepIntent: string
    iter: number; maxIters: number
  } | null>(null)
  // ── Resume banner ─────────────────────────────────────────────────────────
  const [resumeOffer, setResumeOffer] = useState<{
    goal: string; projectPath: string; stepIntent: string
    stepIndex: number; stepTotal: number; iter: number; maxIters: number
    savedAt: number
  } | null>(null)
  const [mode, setMode] = useState<'quorum'|'code'|'seeker'>('quorum')

  // ── Step 9: Remote Brain mode (phone only) ────────────────────────────────
  const [remoteBrain, setRemoteBrain] = useState(false)
  const [streamStatus, setStreamStatus] = useState<'connecting'|'live'|'error'>('connecting')
  const [streamFps, setStreamFps] = useState(0)
  const screenCanvasRef = useRef<HTMLCanvasElement>(null)
  const preBrainModeRef = useRef<'quorum'|'code'|'seeker'>('quorum')
  const fpsCounterRef = useRef({ count: 0, last: 0 })
  const [pipPos, setPipPos] = useState<{x:number,y:number}>({ x: 12, y: 60 })
  const pipPosRef = useRef<{x:number,y:number}>({ x: 12, y: 60 })
  const pipDragRef = useRef<{startX:number,startY:number,startPipX:number,startPipY:number}|null>(null)

  // visualViewport — tracks height AND offsetTop so we can compute the exact keyboard
  // height on iOS. When the keyboard opens, Safari fires both 'resize' (height shrinks)
  // AND 'scroll' (offsetTop shifts). Missing 'scroll' makes the offset calculation wrong.
  // Correct keyboard height = window.innerHeight - vv.offsetTop - vv.height.
  const [visualVpHeight, setVisualVpHeight] = useState<number>(
    typeof window !== 'undefined' && window.visualViewport
      ? window.visualViewport.height
      : (typeof window !== 'undefined' ? window.innerHeight : 812)
  )
  const [visualVpOffsetTop, setVisualVpOffsetTop] = useState<number>(
    typeof window !== 'undefined' && window.visualViewport
      ? window.visualViewport.offsetTop
      : 0
  )
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const update = () => {
      setVisualVpHeight(vv.height)
      setVisualVpOffsetTop(vv.offsetTop)
      // Clamp PiP so it never gets pushed off screen when keyboard opens
      const pipH = 200
      const maxY = vv.height - pipH - 12
      const pipW = window.innerWidth * 0.88
      const maxX = vv.width - pipW - 8
      setPipPos(pos => {
        const clampedY = Math.min(pos.y, Math.max(8, maxY))
        const clampedX = Math.min(Math.max(8, pos.x), Math.max(8, maxX))
        const next = { x: clampedX, y: clampedY }
        pipPosRef.current = next
        return next
      })
    }
    vv.addEventListener('resize', update)
    vv.addEventListener('scroll', update)
    return () => {
      vv.removeEventListener('resize', update)
      vv.removeEventListener('scroll', update)
    }
  }, [])

  // isMobile: true only on real touch devices (phones/tablets).
  // Width alone is unreliable — a resized desktop window can be 400px wide.
  // We combine touch support + coarse pointer (finger, not mouse) so a narrow
  // desktop window never triggers Remote Brain mode.
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== 'undefined' &&
    window.matchMedia('(pointer: coarse)').matches &&
    ('ontouchstart' in window || navigator.maxTouchPoints > 0)
  )
  const [isLandscape, setIsLandscape] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia('(orientation: landscape)').matches
  )
  useEffect(() => {
    const mqW = window.matchMedia('(pointer: coarse)')
    const mqL = window.matchMedia('(orientation: landscape)')
    const hW = (e: MediaQueryListEvent) => setIsMobile(e.matches)
    const hL = (e: MediaQueryListEvent) => setIsLandscape(e.matches)
    mqW.addEventListener('change', hW)
    mqL.addEventListener('change', hL)
    return () => { mqW.removeEventListener('change', hW); mqL.removeEventListener('change', hL) }
  }, [])

  // Auto-switch to agent mode when Remote Brain opens so the main input bar sends
  // commands straight to the Mac agent loop. Restore previous mode on close.
  useEffect(() => {
    if (remoteBrain) {
      preBrainModeRef.current = mode
      setMode(preBrainModeRef.current)
    } else {
      setMode(preBrainModeRef.current)
    }
  }, [remoteBrain])

  // Screen stream — client-PULL transport for minimum latency.
  //
  // The phone fetches one binary JPEG frame, renders it, then immediately requests the
  // next (long-poll: the server holds the request until a newer frame exists). Only one
  // frame is ever in flight, so latency = 1 RTT + render — a slow link just drops fps
  // instead of building the multi-second stale-frame backlog that the old SSE push
  // suffered (frames buffered invisibly in the kernel TCP send buffer). Binary body, so
  // no base64 inflation and no main-thread atob decode. GPU decode via createImageBitmap,
  // painted on requestAnimationFrame.
  useEffect(() => {
    if (!remoteBrain) return
    setStreamStatus('connecting')
    setStreamFps(0)
    fpsCounterRef.current = { count: 0, last: performance.now() }

    let cancelled = false
    let pendingBitmap: ImageBitmap | null = null
    let rafId = 0
    let baseUrl = `${API_BASE}/api/screen-frame`   // may be swapped to a direct LAN URL below

    const paintLoop = () => {
      if (pendingBitmap) {
        const canvas = screenCanvasRef.current
        if (canvas) {
          if (canvas.width !== pendingBitmap.width) canvas.width = pendingBitmap.width
          if (canvas.height !== pendingBitmap.height) canvas.height = pendingBitmap.height
          canvas.getContext('2d')?.drawImage(pendingBitmap, 0, 0)
          pendingBitmap.close()
          pendingBitmap = null
          const fr = fpsCounterRef.current
          fr.count++
          const now = performance.now()
          if (now - fr.last >= 1000) {
            setStreamFps(Math.round(fr.count * 1000 / (now - fr.last)))
            fr.count = 0
            fr.last = now
          }
        }
      }
      rafId = requestAnimationFrame(paintLoop)
    }
    rafId = requestAnimationFrame(paintLoop)

    // Prefer streaming straight from the Mac's LAN IP (port 3001) — skips the Vite dev
    // proxy, which buffers and adds latency. Derive it from the status endpoint's URL.
    apiFetch(`${API_BASE}/api/remote-brain/status`).then(r => r.json()).then((s) => {
      const lanUrl: string | undefined = s.screenStream
      if (lanUrl && !lanUrl.includes(window.location.hostname)) {
        baseUrl = lanUrl.replace(/\/api\/screen-stream$/, '/api/screen-frame')
      }
    }).catch(() => {})

    let seq = 0
    const pull = async () => {
      while (!cancelled) {
        try {
          const resp = await fetch(`${baseUrl}?since=${seq}`, { cache: 'no-store' })
          if (cancelled) return
          if (resp.status === 204) continue          // no new frame within poll window; retry
          if (!resp.ok) { setStreamStatus('error'); await new Promise(r => setTimeout(r, 500)); continue }
          const hdr = resp.headers.get('X-Frame-Seq')
          if (hdr) seq = parseInt(hdr, 10) || seq
          const blob = await resp.blob()
          if (cancelled || !blob.size) continue
          const bmp = await createImageBitmap(blob)
          if (cancelled) { bmp.close(); return }
          pendingBitmap?.close()
          pendingBitmap = bmp
          setStreamStatus('live')
        } catch {
          if (cancelled) return
          setStreamStatus('error')
          await new Promise(r => setTimeout(r, 500))
        }
      }
    }
    pull()

    return () => {
      cancelled = true
      cancelAnimationFrame(rafId)
      pendingBitmap?.close()
    }
  }, [remoteBrain])

  // ── Auth state ────────────────────────────────────────────────────────────
  const [authUser, setAuthUser] = useState<{ id: string; email: string } | null | 'loading'>('loading')

  // ── Cross-device session ID (Task 3) ──────────────────────────────────────
  const [sessionId] = useState<string>(() => {
    // localStorage (NOT sessionStorage) — sessionStorage is wiped on tab close, which
    // breaks reconnect/cross-device continuity every time the browser is reopened.
    let sid = localStorage.getItem('crucible_sid')
                ?? sessionStorage.getItem('crucible_sid')  // migrate any legacy value
    if (!sid) sid = Math.random().toString(36).slice(2, 10)
    localStorage.setItem('crucible_sid', sid)
    return sid
  })

  // ── Reconnect state (Task 5) ──────────────────────────────────────────────
  const [reconnecting, setReconnecting] = useState(false)

  const wasThinkingRef = useRef(false)
  const passiveEsRef = useRef<EventSource | null>(null)

  const classifyMode = (text: string, lastMode?: 'quorum'|'code'|'seeker'): 'quorum'|'code'|'seeker' => {
    const m = text.toLowerCase()
    const isShortFollowUp = text.trim().split(' ').length <= 3
    if (isShortFollowUp && lastMode && lastMode !== 'quorum') return lastMode
    // Complexity override: long multi-part prompts → ensemble regardless of opening keyword.
    // "Research X: (1) ... (2) ..." is a synthesis task, not a search/retrieval task.
    const approxTokens = text.trim().split(/\s+/).length * 0.75
    const hasNumberedParts = /\(\d+\)|\d+[\.\)]\s+\w/.test(text)
    if (approxTokens > 200 && hasNumberedParts) return lastMode === 'code' ? 'code' : 'quorum'
    // "Research" as an imperative verb with downstream productive intent → synthesis, not retrieval.
    // "Research and produce/write/analyze X" ≠ "research [topic]" as a search noun.
    if (/\bresearch\b[\s\S]{0,80}\b(and|then|to)\b[\s\S]{0,60}\b(produce|write|create|analy[sz]e|compare|synthesi[sz]e|outline|draft|generate|build|develop|make|compile|prepare|compose|report|evaluate|assess|summari[sz]e|explore)\b/i.test(text)) return lastMode === 'code' ? 'code' : 'quorum'
    if (/\b(search|find|look up|latest|news|current|today|who is|what is|when did|where is|research|weather|price|stock|forecast|temperature)\b/.test(m)) return 'seeker'
    if (/\b(code|write|build|create|function|script|debug|fix|implement|refactor|file|class|component|api|error|bug|compile|run|execute)\b/.test(m)) return 'code'
    return lastMode ?? 'quorum'
  }
  const [modeMenuOpen, setModeMenuOpen] = useState(false)
  const [showMinLengthTip, setShowMinLengthTip] = useState(false)
  const minLengthTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [feedHovered, setFeedHovered] = useState(false)
  // N1 — governance panel
  const [govPanelOpen, setGovPanelOpen] = useState(false)
  const [govRequests, setGovRequests] = useState<any[]>([])
  const [govPending, setGovPending] = useState(0)
  const [googleStatus, setGoogleStatus] = useState<Record<string, boolean> | null>(null)

  const bottomRef  = useRef<HTMLDivElement>(null)
  const scrollRef  = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  // Ref holds the lock synchronously — never stale inside effects or rAF callbacks.
  // State is only for showing/hiding the scroll-to-bottom button (UI only).
  const scrollLockedRef = useRef(false)
  const [showScrollBtn, setShowScrollBtn] = useState(false)
  const synthesisRef = useRef<Record<string, string>>({})
  const abortRef = useRef<AbortController | null>(null)
  const prewarmTokenRef = useRef<string | null>(null)
  const prewarmDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inputBarRef = useRef<HTMLDivElement>(null)
  const [inputBarHeight, setInputBarHeight] = useState(100)

  // N1 — poll governance pending count
  useEffect(() => {
    const poll = () => apiFetch(`${API_BASE}/api/governance/pending`).then(r => r.json()).then((d: any[]) => setGovPending(d.length)).catch(() => {})
    poll()
    const t = setInterval(poll, 15000)
    return () => clearInterval(t)
  }, [])

  // Fetch Google services status when menu opens
  useEffect(() => {
    if (!menuOpen) return
    apiFetch(`${API_BASE}/api/google/status`).then(r => r.json()).then(setGoogleStatus).catch(() => {})
  }, [menuOpen])

  // Track input bar height so spacer + fade stay in sync
  useEffect(() => {
    const el = inputBarRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setInputBarHeight(el.offsetHeight))
    ro.observe(el)
    setInputBarHeight(el.offsetHeight)
    return () => ro.disconnect()
  }, [])

  const touchStartYRef = useRef(0)

  // Engage the lock the instant the user shows upward intent — a small wheel tick or
  // a short finger drag is enough. The old code only locked once you were >80px from
  // the bottom, so auto-scroll kept yanking you back during streaming and you had to
  // make one big decisive up-scroll to break free. Now any upward nudge frees it.
  const lockAutoScroll = () => {
    if (scrollLockedRef.current) return
    scrollLockedRef.current = true
    setShowScrollBtn(true)
  }

  const handleScroll = () => {
    const el = scrollRef.current
    if (!el) return
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight
    // Only RE-ENGAGE auto-follow here, when the user scrolls back to the bottom.
    // Disengaging is driven by explicit upward intent (wheel/touch) so a tiny scroll
    // up isn't immediately overridden by the next streamed chunk.
    if (dist <= 80 && scrollLockedRef.current) {
      scrollLockedRef.current = false
      setShowScrollBtn(false)
    }
  }

  const handleWheel = (e: React.WheelEvent) => {
    if (e.deltaY < 0) lockAutoScroll()
  }
  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartYRef.current = e.touches[0]?.clientY ?? 0
  }
  const handleTouchMove = (e: React.TouchEvent) => {
    // Finger moving DOWN the screen scrolls content UP → user wants to read back.
    if ((e.touches[0]?.clientY ?? 0) - touchStartYRef.current > 6) lockAutoScroll()
  }

  const scrollToBottom = () => {
    const el = scrollRef.current
    if (!el) return
    scrollLockedRef.current = false
    setShowScrollBtn(false)
    el.scrollTop = el.scrollHeight
  }

  useEffect(() => {
    // Guard reads from the ref — always current, never stale.
    if (scrollLockedRef.current) return
    const el = scrollRef.current
    if (!el) return
    // Use rAF so the scroll happens after the browser has painted the new content,
    // preventing the layout-recalculation jitter caused by setting scrollTop
    // synchronously while React is still committing DOM mutations.
    requestAnimationFrame(() => {
      if (scrollLockedRef.current) return
      el.scrollTop = el.scrollHeight
    })
  }, [rounds, inputBarHeight])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!e.metaKey) return
      if (e.key === 'x') {
        e.preventDefault()
        const last = rounds[rounds.length - 1]
        if (last) {
          const text = Object.values(last.responses).filter(Boolean).join('\n\n')
          copyText(text)
        }
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [rounds])


  // Dismiss mode fan on outside tap
  useEffect(() => {
    if (!modeMenuOpen) return
    const handler = () => setModeMenuOpen(false)
    window.addEventListener('pointerdown', handler)
    return () => window.removeEventListener('pointerdown', handler)
  }, [modeMenuOpen])

  // ── Live agent timer ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!agentStartTime) return
    const id = setInterval(() => setAgentElapsed(Date.now() - agentStartTime), 1000)
    return () => clearInterval(id)
  }, [agentStartTime])

  // ── Auth check on mount (Task 4) ──────────────────────────────────────────
  useEffect(() => {
    // On iOS, tab switching can evict the page and reload it. Check sessionStorage
    // for a cached auth user first so there's no blank flash while the network call
    // resolves. We still verify with the server in the background.
    try {
      const cached = sessionStorage.getItem('crucible_auth')
      if (cached) setAuthUser(JSON.parse(cached))
    } catch {}
    apiFetch(`${API_BASE}/api/auth/me`, { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then(user => {
        setAuthUser(user)
        try {
          if (user) sessionStorage.setItem('crucible_auth', JSON.stringify(user))
          else sessionStorage.removeItem('crucible_auth')
        } catch {}
      })
      .catch(() => setAuthUser(null))
  }, [])

  // ── bfcache / iOS tab-eviction recovery ───────────────────────────────────
  useEffect(() => {
    const onPageShow = (e: PageTransitionEvent) => {
      if (e.persisted) {
        // Page restored from bfcache — no reload needed, just re-verify auth quietly
        apiFetch(`${API_BASE}/api/auth/me`, { credentials: 'include' })
          .then(r => r.ok ? r.json() : null)
          .then(user => {
            if (user) { setAuthUser(user); sessionStorage.setItem('crucible_auth', JSON.stringify(user)) }
            else { setAuthUser(null); sessionStorage.removeItem('crucible_auth') }
          })
          .catch(() => {})
      }
    }
    window.addEventListener('pageshow', onPageShow)
    return () => window.removeEventListener('pageshow', onPageShow)
  }, [])

  // ── Session restore on mount + poll until any in-flight answer lands ───────
  // Restores the saved thread, then — if the last round was still being generated
  // when we left — keeps polling. The server patches the active session the moment
  // the pipeline/agent finishes (even with no client connected), so a query we left
  // unanswered fills itself in instead of sitting dead.
  useEffect(() => {
    if (!authUser || authUser === 'loading') return
    let cancelled = false
    let pollTimer: ReturnType<typeof setTimeout> | null = null
    let attempts = 0
    const MAX_ATTEMPTS = 100  // ~5 min ceiling at 3s cadence

    const tick = (isFirst: boolean) => {
      apiFetch(`${API_BASE}/api/session/restore`, { credentials: 'include' })
        .then(r => r.json())
        .then(({ session }) => {
          if (cancelled || !session?.rounds?.length) return
          // This device is actively streaming — the live stream is authoritative here.
          if (wasThinkingRef.current) return
          const serverRounds: any[] = session.rounds
          if (isFirst) {
            setRounds(serverRounds)
            if (session.mode) setMode(session.mode)
          } else {
            // Merge by id: only fill in answers that just finished — never drop a
            // round the user added locally after returning.
            const byId = new Map(serverRounds.map(r => [r.id, r]))
            setRounds(prev => prev.length === 0 ? serverRounds : prev.map(r => {
              const s = byId.get(r.id)
              return (s && s.synthesisDone && !r.synthesisDone) ? { ...r, ...s } : r
            }))
          }
          const last = serverRounds[serverRounds.length - 1]
          const stillGenerating = !!last && !!last.userMessage && !last.synthesisDone
          if (stillGenerating && attempts++ < MAX_ATTEMPTS) {
            pollTimer = setTimeout(() => tick(false), 3000)
          }
        })
        .catch(() => {})
    }
    tick(true)
    return () => { cancelled = true; if (pollTimer) clearTimeout(pollTimer) }
  }, [authUser])

  // ── Debounced session save helper (Task 2) ────────────────────────────────
  const sessionSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const saveSession = useCallback((currentRounds: typeof rounds, currentMode: typeof mode) => {
    if (sessionSaveTimer.current) clearTimeout(sessionSaveTimer.current)
    sessionSaveTimer.current = setTimeout(() => {
      apiFetch(`${API_BASE}/api/session/save`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rounds: currentRounds, mode: currentMode }),
      }).catch(() => {})
    }, 1000)
  }, [])

  // ── Continuous active-session persistence ─────────────────────────────────
  // Save on EVERY meaningful change to the conversation (user msg, stage progress,
  // synthesis stream, completion) — not just synthesis tokens. Debounced inside
  // saveSession. This is what makes "close mid-response, come back" actually resume.
  useEffect(() => {
    if (!authUser || authUser === 'loading') return
    if (rounds.length === 0) return
    saveSession(rounds, mode)
  }, [rounds, mode, authUser, saveSession])

  // Synchronous best-effort flush when the tab is hidden/closed (mobile eviction,
  // backgrounding) so the final ~1s of streamed tokens survive the debounce window.
  useEffect(() => {
    const flush = () => {
      if (rounds.length === 0) return
      try {
        fetch(`${API_BASE}/api/session/save`, {
          method: 'POST', credentials: 'include', keepalive: true,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rounds, mode, timestamp: Date.now() }),
        }).catch(() => {})
      } catch {}
    }
    const onHidden = () => { if (document.visibilityState === 'hidden') flush() }
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', onHidden)
    return () => {
      window.removeEventListener('pagehide', flush)
      document.removeEventListener('visibilitychange', onHidden)
    }
  }, [rounds, mode])

  // ── Passive SSE listener for cross-device broadcast (Task 3) ──────────────
  useEffect(() => {
    if (!authUser || authUser === 'loading') return
    const connectPassive = () => {
      const es = new EventSource(`${API_BASE}/api/session/stream?sessionId=${sessionId}`)
      passiveEsRef.current = es
      es.onmessage = (e) => {
        if (!e.data || e.data === '[DONE]') return
        try {
          const parsed = JSON.parse(e.data)
          if (parsed.type === 'connected') return
          // On another device driving the session, merge events into current rounds.
          // The sending device handles its own state via the fetch loop — this is
          // only for passive listeners. If this device is actively thinking, skip.
          if (!thinking && parsed.type === 'synthesis_token') {
            setRounds(prev => {
              const last = prev[prev.length - 1]
              if (!last) return prev
              return [...prev.slice(0, -1), { ...last, synthesis: (last.synthesis ?? '') + (parsed.token ?? '') }]
            })
          }
        } catch {}
      }
      return es
    }
    connectPassive()
    return () => { passiveEsRef.current?.close(); passiveEsRef.current = null }
  }, [authUser, sessionId])

  // ── Server-owned task reconnect (replaces the old passive-stream reconnect) ──
  // The task runs on the server independent of this tab. If we left one mid-run, its full
  // SSE stream is buffered; we replay it from index 0 and rebuild the round so nothing is
  // lost — backgrounding, reload, network drop, phone restart all survive.
  const reconnectingTaskRef = useRef<string | null>(null)

  const refreshSessionMerge = useCallback(() => {
    apiFetch(`${API_BASE}/api/session/restore`, { credentials: 'include' })
      .then(r => r.json())
      .then(({ session }) => {
        if (!session?.rounds?.length) return
        setRounds(prev => {
          if (prev.length === 0) return session.rounds
          const serverLast = session.rounds[session.rounds.length - 1]
          const localLast = prev[prev.length - 1]
          if (serverLast?.id === localLast?.id && (serverLast?.synthesis?.length ?? 0) > (localLast?.synthesis?.length ?? 0)) {
            return [...prev.slice(0, -1), { ...localLast, ...serverLast }]
          }
          return prev
        })
      })
      .catch(() => {})
  }, [])

  const reconnectActiveTask = async () => {
    if (!authUser || authUser === 'loading') return
    let saved: { taskId: string; userMessage: string; ts: number } | null = null
    try { saved = JSON.parse(localStorage.getItem('crucible_active_task') || 'null') } catch {}
    // No (fresh) active task → just refresh the session to pick up anything finished while away.
    if (!saved?.taskId || Date.now() - (saved.ts ?? 0) > 3_600_000) {
      if (saved) { try { localStorage.removeItem('crucible_active_task') } catch {} }
      refreshSessionMerge()
      return
    }
    if (reconnectingTaskRef.current) return            // already reconnecting
    let status: any = null
    try { status = await apiFetch(`${API_BASE}/api/task/${saved.taskId}/status`).then(r => r.json()) } catch {}
    if (!status?.exists) {                              // task gone (TTL / server restart)
      try { localStorage.removeItem('crucible_active_task') } catch {}
      refreshSessionMerge()                             // server-patched final answer still recovered
      return
    }
    reconnectingTaskRef.current = saved.taskId
    setReconnecting(true)
    // Reset the round so the from=0 replay rebuilds it exactly (no double-applied tokens).
    setRounds(prev => {
      const fresh = emptyRound(saved!.taskId, saved!.userMessage)
      return prev.some(r => r.id === saved!.taskId) ? prev.map(r => r.id === saved!.taskId ? fresh : r) : [...prev, fresh]
    })
    setThinking(true); wasThinkingRef.current = true
    try {
      const res = await apiFetch(`${API_BASE}/api/task/stream?taskId=${encodeURIComponent(saved.taskId)}&from=0`)
      if (res.ok && res.body) await consumeStream(res.body.getReader(), saved.taskId, saved.userMessage)
    } catch {}
    setThinking(false); wasThinkingRef.current = false
    setReconnecting(false)
    reconnectingTaskRef.current = null
    try { localStorage.removeItem('crucible_active_task') } catch {}
  }

  // ── PWA push: register the service worker, and subscribe on a user gesture ──
  useEffect(() => {
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {})
  }, [])

  const ensurePushSubscription = async () => {
    try {
      if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return
      if (Notification.permission === 'denied') return
      const reg = await navigator.serviceWorker.ready
      let perm: NotificationPermission = Notification.permission
      if (perm === 'default') perm = await Notification.requestPermission()
      if (perm !== 'granted') return
      let sub = await reg.pushManager.getSubscription()
      if (!sub) {
        const { key } = await apiFetch(`${API_BASE}/api/push/vapid-public`).then(r => r.json())
        if (!key) return
        sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(key) as BufferSource })
      }
      await apiFetch(`${API_BASE}/api/push/subscribe`, {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscription: sub }),
      })
    } catch {}
  }

  // Reconnect on first load (after auth resolves) and every time the tab becomes visible.
  useEffect(() => { void reconnectActiveTask() }, [authUser])
  useEffect(() => {
    const onVisibility = () => { if (document.visibilityState === 'visible') void reconnectActiveTask() }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [sessionId, authUser])

  // Track thinking state for reconnect decisions
  useEffect(() => { wasThinkingRef.current = thinking }, [thinking])

  // ── Poll for resumable checkpoints on mount ────────────────────────────────
  useEffect(() => {
    apiFetch(`${API_BASE}/api/checkpoint`)
      .then(r => r.json())
      .then(({ checkpoints }) => {
        if (!checkpoints?.length) return
        const cp = checkpoints[0]
        const age = Date.now() - (cp.savedAt ?? 0)
        // Auto-resume silently if checkpoint is fresh (within 90s grace window)
        if (age < 90_000) {
          console.log('[Resume] Fresh checkpoint detected, auto-resuming...')
          continueFromCheckpointData(cp)
          return
        }
        setResumeOffer({
          goal: cp.goal,
          projectPath: cp.projectPath,
          stepIntent: cp.stepIntent,
          stepIndex: cp.stepIndex,
          stepTotal: cp.stepTotal,
          iter: cp.iter,
          maxIters: cp.maxIters,
          savedAt: cp.savedAt,
        })
      })
      .catch(() => {})
  }, [])
  const send = async (overrideMessage?: string, modeOverride?: string) => {
    // In Remote Brain mode every send goes straight to the Mac agent loop.
    if (remoteBrain && !modeOverride) modeOverride = 'agent'
    if (thinking) return
    const userMessage = (overrideMessage ?? input).trim()
    if (!userMessage || userMessage.length < 4) return
    const roundId = Date.now().toString()
    localStorage.setItem('crucible_has_sent', '1')
    setInput(''); setThinking(true); scrollLockedRef.current = false; setShowScrollBtn(false); haptic('medium')
    setAgentStartTime(Date.now()); setAgentElapsed(0); setAgentProgress(null)
    prewarmTokenRef.current = null
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
    const nextRounds = [...rounds, emptyRound(roundId, userMessage)]
    setRounds(nextRounds)
    // Record this as the active server-owned task so that if the tab is backgrounded /
    // reloaded mid-run, we can reconnect to its buffered stream and replay on return.
    try { localStorage.setItem('crucible_active_task', JSON.stringify({ taskId: roundId, userMessage, ts: Date.now() })) } catch {}
    // First send is a user gesture — a good moment to enable "answer ready" push.
    void ensurePushSubscription()
    // Persist the new turn IMMEDIATELY (non-debounced) so closing the tab before the
    // pipeline even starts still resumes the question + full prior thread. Saving []
    // here used to blank the conversation for the entire deliberation window.
    apiFetch(`${API_BASE}/api/session/save`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rounds: nextRounds, mode, timestamp: Date.now() }),
    }).catch(() => {})

    abortRef.current = new AbortController()
    let res: Response
    try {
      res = await apiFetch(`${API_BASE}/api/chat`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: userMessage,
          mode: modeOverride ?? mode,
          sessionId,
          roundId,  // lets the server patch the finished answer into THIS round if we disconnect
          prewarmToken: prewarmTokenRef.current,
          device: /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ? "mobile" : "desktop",
          history: rounds.slice(-6).filter(r => r.synthesis).map(r => ({
            user: r.userMessage,
            assistant: r.synthesis
          }))
        }),
        signal: abortRef.current.signal,
      })
    } catch (err: any) {
      if (err.name === 'AbortError') { setThinking(false); return }
      console.error('[send] fetch failed:', err)
      haptic('heavy')
      setThinking(false); return
    }
    const reader = res.body!.getReader()
    await consumeStream(reader, roundId, userMessage)
    setThinking(false)
    setAgentStartTime(null); setAgentProgress(null)
    try { localStorage.removeItem('crucible_active_task') } catch {}
  }

  // Shared SSE consumer — used by the live send loop AND by reconnect/replay (below), so a
  // backgrounded task's buffered events rebuild the exact same UI state when the user returns.
  const consumeStream = async (reader: ReadableStreamDefaultReader<Uint8Array>, roundId: string, userMessage: string) => {
    const decoder = new TextDecoder()
    let sseBuf = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      // Buffer across chunks: SSE events (esp. agent diffs/output) can span reads.
      sseBuf += decoder.decode(value, { stream: true })
      const chunkLines = sseBuf.split('\n')
      sseBuf = chunkLines.pop() ?? ''
      const lines = chunkLines.filter(l => l.startsWith('data: '))
      for (const line of lines) {
        const raw = line.slice(6)
        if (raw === '[DONE]') break
        try {
          const parsed = JSON.parse(raw)

          // ── Agent loop events (Section 7) — fold through one reducer ────────
          if (AGENT_EVENT_TYPES.has(parsed.type)) {
            setRounds(prev => prev.map(r => r.id !== roundId ? r : { ...r, agent: agentReducer(r.agent, parsed) }))
            if (parsed.type === 'final') {
              // Agent's final summary doubles as the round's synthesis text.
              setRounds(prev => prev.map(r => r.id !== roundId ? r : { ...r, synthesis: parsed.text ?? r.synthesis, synthesisDone: true }))
            }
            continue
          }

          // ── Model selection (first event) ──────────────────────────────────
          if (parsed.type === 'semantic_cache') {
            setRounds(prev => prev.map(r => r.id === roundId ? { ...r, semanticSim: parsed.similarity, semanticMatch: parsed.matchedQuery } : r))
            continue
          }
          if (parsed.type === 'model_selection') {
            setRounds(prev => prev.map(r => r.id === roundId ? { ...r, complexity: parsed.complexity ?? 'complex' } : r))
            const coloredModels = assignColors(parsed.models)
            const emptyResponses: Record<string, string>  = {}
            const emptyDone: Record<string, boolean>      = {}
            const emptyScores: Record<string, number|null> = {}
            const emptyCritiques: Record<string, Record<string, Critique>> = {}
            const emptyRevisions: Record<string, string>  = {}
            const emptyRevDone: Record<string, boolean>   = {}
            for (const m of coloredModels) {
              emptyResponses[m.id]  = ''
              emptyDone[m.id]       = false
              emptyScores[m.id]     = null
              emptyCritiques[m.id]  = {}
              emptyRevisions[m.id]  = ''
              emptyRevDone[m.id]    = false
            }
            setRounds(prev => prev.map(r => r.id !== roundId ? r : {
              ...r,
              models: coloredModels,
              synthesisModelId: parsed.synthesisModelId,
              promptType: parsed.promptType,
              complexity: parsed.complexity ?? 'complex',
              cached: parsed.cached === true,
              responses: emptyResponses,
              done: emptyDone,
              scores: emptyScores,
              critiques: emptyCritiques,
              revisions: emptyRevisions,
              revisionsDone: emptyRevDone,
            }))
            continue
          }

          // ── Layer 1 responses ──────────────────────────────────────────────
          if (!parsed.type || parsed.type === 'layer1') {
            const { modelId, text, done: modelDone, score, remediated, newText } = parsed
            setRounds(prev => prev.map(r => {
              if (r.id !== roundId) return r
              // If remediation fired, replace the response entirely
              const updatedText = remediated && newText
                ? newText
                : (r.responses[modelId] ?? '') + (text || '')
              return {
                ...r,
                responses: { ...r.responses, [modelId]: updatedText },
                scores: { ...r.scores, [modelId]: (typeof score === 'number' ? score : score?.compositeScore) ?? r.scores[modelId] },
                done: { ...r.done, [modelId]: modelDone || r.done[modelId] },
                remediated: { ...(r.remediated ?? {}), [modelId]: remediated ? true : (r.remediated?.[modelId] ?? false) },
              }
            }))
            continue
          }

          // ── Linter gate events ─────────────────────────────────────────────
          if (parsed.type === 'linter') {
            const { modelId, status, score: linterScore } = parsed
            setRounds(prev => prev.map(r => {
              if (r.id !== roundId) return r
              return {
                ...r,
                linterStatus: {
                  ...(r.linterStatus ?? {}),
                  [modelId]: { status, score: linterScore },
                },
                activityFeed: [...(r.activityFeed ?? []), { ts: Date.now(), type: 'linter', modelId, message: status === 'passed' ? 'Quality check passed' : status === 'failed' ? 'Quality check failed' : status === 'remediated' ? 'Auto-corrected and accepted' : 'No changes needed' }],
              }
            }))
            continue
          }

          // ── Contract event ─────────────────────────────────────────────────
          if (parsed.type === 'contract') {
            setRounds(prev => prev.map(r => {
              if (r.id !== roundId) return r
              return {
                ...r,
                activityFeed: [...(r.activityFeed ?? []), { ts: Date.now(), type: 'contract', message: `Response format set for ${parsed.promptType ?? 'this query'}` }],
              }
            }))
            continue
          }
          // ── Rollback event ─────────────────────────────────────────────────
          if (parsed.type === 'rollback') {
            const quarantined: Array<{ id: string; reason: string }> = parsed.quarantined ?? []
            setRounds(prev => prev.map(r => {
              if (r.id !== roundId) return r
              const entries = quarantined.map(q => ({ ts: Date.now(), type: 'rollback', modelId: q.id, message: q.reason === 'error' ? 'Model dropped — returned an error' : q.reason === 'empty' ? 'Model dropped — no response' : 'Model dropped — low quality' }))
              return { ...r, activityFeed: [...(r.activityFeed ?? []), ...entries] }
            }))
            continue
          }
          // ── Stage transitions ──────────────────────────────────────────────

          // ── Scores map (stage 2) ───────────────────────────────────────────
          if (parsed.type === 'scores') {
            setRounds(prev => prev.map(r => {
              if (r.id !== roundId) return r
              const merged = { ...r.scores }
              for (const [mid, val] of Object.entries(parsed.scores as Record<string, number>)) {
                merged[mid] = val
              }
              return { ...r, scores: merged }
            }))
            continue
          }

          if (parsed.type === 'stage') {
            if (parsed.stage === 2 && parsed.status === 'done')
              setRounds(prev => prev.map(r => r.id === roundId ? { ...r, stage2Done: true, avgScores: parsed.avgScores ?? {} } : r))
            if (parsed.stage === 3 && parsed.status === 'start')
              setRounds(prev => prev.map(r => r.id === roundId ? { ...r, stage3Started: true } : r))
            if (parsed.stage === 3 && parsed.status === 'done')
              setRounds(prev => prev.map(r => r.id === roundId ? { ...r, stage3Done: true } : r))
            if (parsed.stage === 4 && parsed.status === 'start')
              setRounds(prev => prev.map(r => r.id === roundId ? { ...r, stage4Started: true } : r))
            if (parsed.stage === 4 && parsed.status === 'done')
              setRounds(prev => prev.map(r => r.id === roundId ? { ...r, stage4Done: true } : r))
            setRounds(prev => prev.map(r => {
              if (r.id !== roundId) return r
              const stageLabels: Record<string, string> = { '1': 'Models thinking', '2': 'Grading responses', '3': 'Models debating', '4': 'Models self-correcting', '5': 'Writing final answer' }
              const label = stageLabels[String(parsed.stage)] ?? `Stage ${parsed.stage}`
              return { ...r, activityFeed: [...(r.activityFeed ?? []), { ts: Date.now(), type: 'stage', message: parsed.status === 'start' ? `Starting: ${label}` : `Done: ${label}` }] }
            }))
            if (parsed.stage === 5 && parsed.status === 'done') {
              setRounds(prev => prev.map(r => r.id === roundId ? { ...r, synthesisDone: true } : r))
              setThinking(false)
              const synthText = synthesisRef.current[roundId] ?? ''
              if (synthText) {
                setTimeout(() => runVerify(roundId, synthText, userMessage), 200)
              }


            }
            continue
          }

          // ── Critiques ──────────────────────────────────────────────────────
          if (parsed.type === 'critique') {
            if (parsed.criticId && parsed.targetId && parsed.text) {
              setRounds(prev => prev.map(r => r.id !== roundId ? r : {
                ...r,
                critiques: {
                  ...r.critiques,
                  [parsed.criticId]: {
                    ...(r.critiques?.[parsed.criticId] ?? {}),
                    [parsed.targetId]: { text: (r.critiques?.[parsed.criticId]?.[parsed.targetId]?.text ?? '') + parsed.text }
                  }
                }
              }))
            }
            const { criticId, targetId, text, done: critDone } = parsed
            setRounds(prev => prev.map(r => {
              if (r.id !== roundId) return r
              const existing = r.critiques[criticId]?.[targetId]?.text ?? ''
              return {
                ...r,
                critiques: {
                  ...r.critiques,
                  [criticId]: {
                    ...r.critiques[criticId],
                    [targetId]: { text: existing + (text || ''), done: critDone ?? false },
                  },
                },
              }
            }))
            continue
          }

          // ── Self-revisions ─────────────────────────────────────────────────
          if (parsed.type === 'revision') {
            const { modelId, text } = parsed
            setRounds(prev => prev.map(r => {
              if (r.id !== roundId) return r
              return {
                ...r,
                revisions: { ...r.revisions, [modelId]: text || r.revisions[modelId] },
              }
            }))
            continue
          }

          // ── Instant first token ───────────────────────────────────────────
          if (parsed.type === 'thinking') {
            continue
          }

          // ── SSE keepalive — connection is alive, nothing to render ─────────
          if (parsed.type === 'keepalive') {
            continue
          }

          // ── Live agent iteration progress ──────────────────────────────────
          if (parsed.type === 'iter_progress') {
            setAgentProgress({
              stepIndex: parsed.stepIndex ?? 0,
              stepTotal: parsed.stepTotal ?? 1,
              stepIntent: parsed.stepIntent ?? '',
              iter: parsed.iter ?? 1,
              maxIters: parsed.maxIters ?? 32,
            })
            continue
          }

          // ── Streaming synthesis tokens ─────────────────────────────────────
          if (parsed.type === 'synthesis_token') {
            const { text } = parsed
            if (text) {
              synthesisRef.current[roundId] = (synthesisRef.current[roundId] ?? '') + text
              setRounds(prev => prev.map(r => {
                if (r.id !== roundId) return r
                return { ...r, synthesis: r.synthesis + text, synthStreaming: true }
              }))
            }
            continue
          }

          // ── Synthesis (final polished result — replaces streamed draft) ────
          if (parsed.type === 'confidence') {
            setRounds(prev => prev.map(r => r.id !== roundId ? r : {
              ...r,
              confidence: {
                overallTier: parsed.overallTier,
                overallScore: parsed.overallScore,
                summary: parsed.summary,
                flaggedClaims: parsed.flaggedClaims ?? [],
                fragilityAssumption: parsed.fragilityAssumption,
                frontierQuestion: parsed.frontierQuestion,
              },
            }))
            continue
          }

          // Genealogy — contribution rates per model in final synthesis
          if (parsed.type === 'genealogy') {
            setRounds(prev => prev.map(r => r.id !== roundId ? r : {
              ...r,
              genealogy: parsed.contributionRates as Record<string, number>,
            }))
            continue
          }

          // I5 — adversarial critic findings (process trail only, never replaces synthesis)
          if (parsed.type === 'critic') {
            const problems: string[] = parsed.problems ?? []
            if (problems.length > 0) {
              setRounds(prev => prev.map(r => r.id === roundId ? { ...r, criticProblems: problems } : r))
            }
            continue
          }

          // Track P — MASTERPIECE SSE events
          if (parsed.type === 'masterpiece_gate') {
            if (parsed.gate?.shouldActivate) {
              setRounds(prev => prev.map(r => r.id === roundId
                ? { ...r, masterpiece: { active: true } }
                : r))
            }
            continue
          }
          if (parsed.type === 'masterpiece_shard') {
            setRounds(prev => prev.map(r => r.id === roundId ? {
              ...r,
              masterpiece: { ...r.masterpiece, active: true, shardCount: parsed.shardCount, shards: parsed.shards }
            } : r))
            continue
          }
          if (parsed.type === 'masterpiece_abductive') {
            setRounds(prev => prev.map(r => r.id === roundId ? {
              ...r,
              masterpiece: { ...r.masterpiece, active: true, connectionsFound: parsed.connectionsFound, connectionsSurvived: parsed.connectionsSurvived, domains: parsed.domains }
            } : r))
            continue
          }
          if (parsed.type === 'masterpiece_triadic') {
            setRounds(prev => prev.map(r => r.id === roundId ? {
              ...r,
              masterpiece: { ...r.masterpiece, active: true, resonancesFound: parsed.resonancesFound, patterns: parsed.patterns }
            } : r))
            continue
          }
          if (parsed.type === 'masterpiece_escalation') {
            setRounds(prev => prev.map(r => r.id === roundId ? {
              ...r,
              masterpiece: { ...r.masterpiece, active: true, escalatedCount: parsed.escalated, tiers: parsed.tiers }
            } : r))
            continue
          }
          if (parsed.type === 'masterpiece_moe') {
            setRounds(prev => prev.map(r => r.id === roundId ? {
              ...r,
              masterpiece: { ...r.masterpiece, active: true, specialists: parsed.specialists }
            } : r))
            continue
          }
          if (parsed.type === 'masterpiece_complete') {
            setRounds(prev => prev.map(r => r.id === roundId ? {
              ...r,
              masterpiece: {
                ...r.masterpiece,
                active: false,
                shardCount: parsed.shardCount,
                connectionsFound: parsed.abductiveConnectionsFound,
                connectionsSurvived: parsed.abductiveConnectionsSurvived,
                resonancesFound: parsed.structuralResonancesFound,
                escalatedCount: parsed.escalatedShardCount,
                elapsedMs: parsed.elapsedMs,
              }
            } : r))
            continue
          }
          // P12 — live shard progress: update the in-progress count so the UI shows
          // "N/M shards analyzed" while deep mode is running.
          if (parsed.type === 'masterpiece_shard_progress') {
            setRounds(prev => prev.map(r => r.id === roundId ? {
              ...r,
              masterpiece: { ...r.masterpiece, active: true, shardsCompleted: parsed.completed, shardsTotal: parsed.total }
            } : r))
            continue
          }
          if (parsed.type === 'masterpiece_assemble' || parsed.type === 'masterpiece_start') {
            continue  // no state update needed — progress visible via shard/abductive events
          }
          // Confidence-gated response commitment — surface what would resolve uncertainty.
          if (parsed.type === 'uncertain_commitment') {
            setRounds(prev => prev.map(r => r.id === roundId
              ? { ...r, uncertainCommitment: { overallScore: parsed.overallScore, resolvingStep: parsed.resolvingStep } }
              : r))
            continue
          }
          // Track P — light-mode cross-domain connection (novelty > 0.6 only)
          if (parsed.type === 'masterpiece_light') {
            setRounds(prev => prev.map(r => r.id === roundId
              ? { ...r, crossDomainConnection: parsed.connection }
              : r))
            continue
          }
          // Track U — ANIMA transparency entries (the synthesis text renders the answer;
          // these power a structured list view)
          if (parsed.type === 'anima_transparency') {
            setRounds(prev => prev.map(r => r.id === roundId
              ? { ...r, animaTruths: parsed.entries }
              : r))
            continue
          }

          // M3 — proactive ambient suggestion
          if (parsed.type === 'proactive_suggestion') {
            setRounds(prev => prev.map(r => r.id === roundId ? { ...r, proactiveSuggestion: parsed.text } : r))
            continue
          }

          if (parsed.type === 'synthesis') {
            const { text, done: synthDone, replace } = parsed
            if (replace) {
              // Polish completed — replace the streamed draft with the final polished text
              if (text) synthesisRef.current[roundId] = text
              setRounds(prev => prev.map(r => {
                if (r.id !== roundId) return r
                return {
                  ...r,
                  synthesis: text || r.synthesis,
                  synthStreaming: false,
                  synthesisDone: synthDone ?? r.synthesisDone,
                }
              }))
            } else {
              // Legacy path (agent streaming, cache replay) — append
              if (text) synthesisRef.current[roundId] = (synthesisRef.current[roundId] ?? '') + text
              setRounds(prev => prev.map(r => {
                if (r.id !== roundId) return r
                return {
                  ...r,
                  synthesis: r.synthesis + (text || ''),
                  synthesisDone: synthDone ?? r.synthesisDone,
                }
              }))
            }
            continue
          }

        } catch (e) { console.error('parse error', e) }
      }
    }
  }

  const runVerify = async (roundId: string, code: string, originalPrompt: string) => {
    setRounds(prev => prev.map(r => r.id === roundId ? { ...r, verifyStatus: 'running', verifyMessage: 'Running verification...' } : r))
    let res: Response
    try {
      res = await apiFetch(`${API_BASE}/api/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, originalPrompt }),
      })
    } catch (fetchErr) {
      console.error('[runVerify] fetch FAILED:', fetchErr)
      return
    }
    if (!res.body) { console.error('[runVerify] no body'); return }
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const payload = line.slice(6)
        if (payload.trim() === '[DONE]') continue
        try {
          const parsed = JSON.parse(payload)
          if (parsed.type === 'verify_status') {
            setRounds(prev => prev.map(r => r.id === roundId ? { ...r, verifyMessage: parsed.message } : r))
          } else if (parsed.type === 'verify_clean') {
            setRounds(prev => prev.map(r => r.id === roundId ? { ...r, verifyStatus: 'clean', verifyMessage: '✓ Executed successfully' } : r))
          } else if (parsed.type === 'verify_static') {
            // Real static verification (syntax + types) — runtime skipped only because the
            // offline sandbox lacks the imported deps. Honest badge, code left intact.
            setRounds(prev => prev.map(r => r.id === roundId ? { ...r, verifyStatus: 'clean', verifyMessage: parsed.message ?? '✓ Syntax & types verified' } : r))
          } else if (parsed.type === 'verify_fixed') {
            setRounds(prev => prev.map(r => r.id === roundId ? { ...r, verifyStatus: 'fixed', verifyMessage: '✓ Fixed and verified', synthesis: parsed.code ? applyFixedCode(r.synthesis, parsed.code) : r.synthesis } : r))
          } else if (parsed.type === 'analysis_fixed') {
            // Pipeline fixed it — splice the fix into the original answer's code block
            setRounds(prev => prev.map(r => r.id === roundId ? {
              ...r,
              verifyStatus: 'fixed',
              verifyMessage: parsed.message ?? '✓ Fixed by analysis pipeline',
              synthesis: parsed.code ? applyFixedCode(r.synthesis, parsed.code) : r.synthesis,
            } : r))
          } else if (parsed.type === 'analysis_start' || parsed.type === 'analysis_status' || parsed.type === 'analysis_deepening') {
            setRounds(prev => prev.map(r => r.id === roundId ? { ...r, verifyMessage: parsed.message ?? 'Deep analysis...' } : r))
          } else if (parsed.type === 'attack_start') {
            setRounds(prev => prev.map(r => r.id === roundId ? {
              ...r, verifyMessage: `Analyzing: ${parsed.lens} (${parsed.attempt}/${parsed.totalAttempts})`
            } : r))
          } else if (parsed.type === 'candidate_tested') {
            setRounds(prev => prev.map(r => r.id === roundId ? { ...r, verifyMessage: parsed.message ?? '' } : r))
          } else if (parsed.type === 'synthesis_start') {
            setRounds(prev => prev.map(r => r.id === roundId ? { ...r, verifyMessage: parsed.message ?? 'Synthesizing...' } : r))
          } else if (parsed.type === 'verify_needs_model') {
            setRounds(prev => prev.map(r => r.id === roundId ? { ...r, verifyStatus: 'needs_model', verifyMessage: 'Applying surgical fix...' } : r))
            await streamSurgicalFix(roundId, parsed.surgicalPrompt)
          } else if (parsed.type === 'analysis_failed' || parsed.type === 'verify_failed') {
            setRounds(prev => prev.map(r => r.id === roundId ? { ...r, verifyStatus: 'failed', verifyMessage: parsed.error ?? 'Verification failed' } : r))
          }
        } catch (e) { console.error('verify parse error', e) }
      }
    }
  }

  const streamSurgicalFix = async (roundId: string, surgicalPrompt: string) => {
    const res = await apiFetch(`${API_BASE}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: surgicalPrompt, isSurgical: true }),
    })
    if (!res.body) return
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    let newSynthesis = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const payload = line.slice(6)
        if (payload.trim() === '[DONE]') continue
        try {
          const parsed = JSON.parse(payload)
          if (parsed.type === 'synthesis') {
            newSynthesis += parsed.text || ''
            const isSurgicalDone = parsed.done ?? false
            setRounds(prev => prev.map(r => r.id === roundId ? {
              ...r,
              synthesis: newSynthesis,
              ...(isSurgicalDone ? { verifyStatus: 'fixed', verifyMessage: '✓ Fixed and verified' } : {})
            } : r))
          }
        } catch (e) {}
      }
    }
    setRounds(prev => prev.map(r => r.id === roundId ? { ...r, verifyStatus: 'fixed', verifyMessage: '✓ Fixed and verified' } : r))
  }

  // Verify is triggered directly in the stage-5-done SSE handler above


  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!thinking) send() }
  }
  const dismissResume = () => {
    if (resumeOffer) {
      apiFetch(`${API_BASE}/api/checkpoint`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectPath: resumeOffer.projectPath }),
      }).catch(() => {})
    }
    setResumeOffer(null)
  }

  const continueFromCheckpointData = async (offer: { goal: string; projectPath: string; stepIntent?: string; stepIndex?: number; stepTotal?: number; iter?: number; maxIters?: number; savedAt?: number }) => {
    setResumeOffer(null)
    const roundId = Date.now().toString()
    setThinking(true)
    setAgentStartTime(Date.now()); setAgentElapsed(0)
    setRounds(prev => [...prev, emptyRound(roundId, offer.goal)])
    abortRef.current = new AbortController()
    let res: Response
    try {
      res = await apiFetch(`${API_BASE}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: abortRef.current.signal,
        body: JSON.stringify({
          message: offer.goal,
          mode: 'agent',
          projectPath: offer.projectPath,
          resumeFromCheckpoint: true,
        }),
      })
    } catch { setThinking(false); setAgentStartTime(null); return }
    if (!res.body) { setThinking(false); setAgentStartTime(null); return }
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n'); buf = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const raw = line.slice(6).trim()
        if (raw === '[DONE]') break
        try {
          const parsed = JSON.parse(raw)
          if (parsed.type === 'final') {
            setRounds(prev => prev.map(r => r.id === roundId ? { ...r, synthesis: parsed.text ?? '', synthesisDone: true } : r))
          }
          if (parsed.type === 'agent_done') {
            setRounds(prev => prev.map(r => r.id === roundId ? { ...r, agent: { ...r.agent, active: false } as any } : r))
          }
          if (AGENT_EVENT_TYPES.has(parsed.type)) {
            setRounds(prev => prev.map(r => r.id !== roundId ? r : { ...r, agent: agentReducer(r.agent, parsed) }))
          }
        } catch {}
      }
    }
    setThinking(false); setAgentStartTime(null); setAgentProgress(null)
  }

  const continueFromCheckpoint = async () => {
    if (!resumeOffer) return
    const offer = resumeOffer
    setResumeOffer(null)
    const roundId = Date.now().toString()
    setThinking(true)
    setAgentStartTime(Date.now()); setAgentElapsed(0)
    setRounds(prev => [...prev, emptyRound(roundId, offer.goal)])
    abortRef.current = new AbortController()
    let res: Response
    try {
      res = await apiFetch(`${API_BASE}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: abortRef.current.signal,
        body: JSON.stringify({
          message: offer.goal,
          mode: 'agent',
          projectPath: offer.projectPath,
          resumeFromCheckpoint: true,
        }),
      })
    } catch { setThinking(false); setAgentStartTime(null); return }
    // Reuse the same SSE parse loop that `send()` uses — delegate by calling send
    // with the pre-built res. Not worth duplicating; just set up the stream directly.
    if (!res.body) { setThinking(false); setAgentStartTime(null); return }
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const raw = line.slice(6).trim()
        if (raw === '[DONE]') break
        try {
          const parsed = JSON.parse(raw)
          if (parsed.type === 'final') {
            setRounds(prev => prev.map(r => r.id === roundId
              ? { ...r, synthesis: parsed.text ?? '', synthesisDone: true }
              : r))
          }
          if (parsed.type === 'agent_done') {
            setRounds(prev => prev.map(r => r.id === roundId
              ? { ...r, agent: { ...r.agent, active: false } as any }
              : r))
          }
        } catch {}
      }
    }
    setThinking(false); setAgentStartTime(null); setAgentProgress(null)
  }

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value
    setInput(val)
    setMode(classifyMode(val, mode))
    const ta = e.target
    requestAnimationFrame(() => {
      ta.style.height = 'auto'
      ta.style.height = Math.min(ta.scrollHeight, 160) + 'px'
    })
    if (minLengthTimer.current) clearTimeout(minLengthTimer.current)
    if (val.trim().length > 0 && val.trim().length < 4) {
      minLengthTimer.current = setTimeout(() => setShowMinLengthTip(true), 800)
    } else {
      setShowMinLengthTip(false)
    }

    // ── Predictive pre-warm ───────────────────────────────────────────────
    if (prewarmDebounceRef.current) clearTimeout(prewarmDebounceRef.current)
    const wordCount = val.trim().split(/\s+/).filter(Boolean).length
    if (wordCount >= 4 && !thinking) {
      prewarmDebounceRef.current = setTimeout(() => {
        const token = Date.now().toString()
        prewarmTokenRef.current = token
        apiFetch(`${API_BASE}/api/prewarm`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: val.trim(), token }),
        }).catch(() => {})
      }, 400)
    }
  }
  const stop = () => {
    if (abortRef.current) abortRef.current.abort()
    setThinking(false)
  }

  const toggleCritique = (roundId: string, critic: string, target: string) => {
    setRounds(prev => prev.map(r => {
      if (r.id !== roundId) return r
      const same = r.expandedCritique?.critic === critic && r.expandedCritique?.target === target
      return { ...r, expandedCritique: same ? null : { critic, target } }
    }))
  }

  const latestRound = rounds[rounds.length - 1] ?? null
  const globalDone  = latestRound ? latestRound.synthesisDone : false
  const activeModels = latestRound?.models ?? []

  // Show auth screen while loading or not authenticated
  if (authUser === 'loading') return null
  if (!authUser) return <AuthScreen onAuth={user => setAuthUser(user)} />

  return (
    <div className="crucible-root" style={{
      height: '100dvh', background: '#16161e',
      marginLeft: 0,
      transition: 'margin-left 0.38s cubic-bezier(0.16,1,0.3,1)', width: '100vw',
      display: 'flex', flexDirection: 'column',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      color: '#e2e2e2', position: 'relative', overflow: 'hidden', userSelect: 'none',
    }}>
      <style>{`
        @keyframes slideUp  { from { opacity:0; transform:translateY(10px) } to { opacity:1; transform:translateY(0) } }
        @keyframes panelUp  { from { opacity:0; transform:translateY(12px) } to { opacity:1; transform:translateY(0) } }
        @keyframes dotpulse { 0%,100% { opacity:1; transform:scale(1) } 50% { opacity:0.3; transform:scale(0.5) } }
        @keyframes fadeIn   { from { opacity:0 } to { opacity:1 } }
        @keyframes spin     { to { transform: rotate(360deg) } }
        pre { max-width: 100% !important; overflow-x: auto !important; white-space: pre !important; box-sizing: border-box !important; }
        pre code { display: block !important; background: transparent !important; padding: 0 !important; font-size: 12px !important; line-height: 1.5 !important; white-space: pre !important; overflow-x: auto !important; }
        .react-syntax-highlighter-line-number { display: none; }
        * { box-sizing: border-box; }
        @keyframes prism { 0% { filter: hue-rotate(0deg) brightness(1.3) saturate(1.8); } 100% { filter: hue-rotate(360deg) brightness(1.3) saturate(1.8); } }
        @keyframes arrowToRing { 0% { transform: rotate(0deg) scale(1); opacity: 1; } 60% { transform: rotate(140deg) scale(0.5); opacity: 0.5; } 100% { transform: rotate(180deg) scale(1); opacity: 1; } }
        @keyframes studioIn { from { transform: translateX(-100%); } to { transform: translateX(0); } }
        @keyframes fanIn { from { opacity:0; transform:translateX(-6px) } to { opacity:1; transform:translateX(0) } }
      `}</style>

      <ShimmerBg thinking={thinking} mode={mode} />

      {/* ── Step 9: Remote Brain overlay — canvas only, stops above the normal input bar ── */}
      {/* The regular chat input at the bottom is the command interface — no separate bar. */}
      {/* ── Remote Brain overlay ────────────────────────────────────────────────
           Portrait: canvas fills top region, input bar floats over bottom.
           Landscape: split — canvas left 62%, chat history + input bar right 38%.
           The canvas lives here regardless of layout so the SSE stream ref is stable.
           The input bar is always rendered by its normal slot below; we only control
           the canvas area here. pointerEvents: 'none' on the canvas div means taps
           fall through to chat content and the input bar naturally — no interference.
      ─────────────────────────────────────────────────────────────────────────── */}
      {remoteBrain && isMobile && (
        <>
          {/* PiP draggable window */}
          <div style={{
            position: 'fixed',
            left: pipPos.x,
            top: visualVpOffsetTop + pipPos.y,
            width: '88vw',
            zIndex: 200,
            borderRadius: 12,
            overflow: 'hidden',
            boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
            pointerEvents: 'auto',
            touchAction: 'none',
            transition: pipDragRef.current ? 'none' : 'top 0.3s cubic-bezier(0.22,1,0.36,1), left 0.3s cubic-bezier(0.22,1,0.36,1)',
          }}
            onTouchStart={e => {
              const t = e.touches[0]
              pipDragRef.current = { startX: t.clientX, startY: t.clientY, startPipX: pipPos.x, startPipY: pipPos.y }
            }}
            onTouchMove={e => {
              if (!pipDragRef.current) return
              const t = e.touches[0]
              const dx = t.clientX - pipDragRef.current.startX
              const dy = t.clientY - pipDragRef.current.startY
              const next = { x: pipDragRef.current.startPipX + dx, y: pipDragRef.current.startPipY + dy }
              pipPosRef.current = next
              setPipPos(next)
            }}
            onTouchEnd={() => { pipDragRef.current = null }}
          >
            <canvas
              ref={screenCanvasRef}
              style={{
                width: '100%', height: 'auto', display: 'block',
                opacity: streamStatus === 'live' ? 1 : 0,
                transition: 'opacity 0.4s ease',
              }}
            />

            {/* Connecting / error — centered in canvas pane */}
            {streamStatus !== 'live' && (
              <div style={{
                position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
                alignItems: 'center', justifyContent: 'center', gap: 12,
                pointerEvents: 'auto',
              }}>
                {streamStatus === 'connecting' ? (
                  <>
                    <div style={{
                      width: 26, height: 26, borderRadius: '50%',
                      border: '2px solid rgba(255,255,255,0.07)',
                      borderTop: '2px solid rgba(124,124,248,0.75)',
                      animation: 'spin 0.85s linear infinite',
                    }} />
                    <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.28)', letterSpacing: '0.07em' }}>connecting…</span>
                  </>
                ) : (
                  <>
                    <span style={{ fontSize: 11, color: 'rgba(248,113,113,0.55)' }}>stream unavailable</span>
                    <button
                      onClick={() => { setRemoteBrain(false); setTimeout(() => setRemoteBrain(true), 100) }}
                      style={{
                        background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)',
                        color: '#ccc', borderRadius: 7, padding: '5px 12px', fontSize: 11, cursor: 'pointer',
                      }}
                    >retry</button>
                  </>
                )}
              </div>
            )}

            {/* HUD: top-left fps + top-right live badge + exit */}
            <div style={{
              position: 'absolute', top: 8, left: 0, right: 0,
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '0 8px', pointerEvents: 'auto',
            }}>
              {/* fps — only when live */}
              {streamStatus === 'live' && streamFps > 0 ? (
                <span style={{ fontSize: 8, color: 'rgba(255,255,255,0.2)', fontVariantNumeric: 'tabular-nums', letterSpacing: '0.05em' }}>
                  {streamFps} fps
                </span>
              ) : <span />}

              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                {/* LIVE badge */}
                {streamStatus === 'live' && (
                  <div style={{
                    display: 'flex', alignItems: 'center', gap: 4,
                    background: 'rgba(0,0,0,0.55)', borderRadius: 5, padding: '3px 7px',
                    backdropFilter: 'blur(4px)',
                  }}>
                    <div style={{
                      width: 5, height: 5, borderRadius: '50%',
                      background: '#4ade80', boxShadow: '0 0 6px #4ade80',
                      animation: 'dotpulse 2s ease-in-out infinite',
                    }} />
                    <span style={{ fontSize: 8, color: 'rgba(255,255,255,0.5)', letterSpacing: '0.12em', fontWeight: 700 }}>LIVE</span>
                  </div>
                )}
                {/* Exit */}
                <button
                  onClick={() => setRemoteBrain(false)}
                  style={{
                    background: 'rgba(0,0,0,0.55)', border: '1px solid rgba(255,255,255,0.1)',
                    backdropFilter: 'blur(4px)',
                    color: 'rgba(255,255,255,0.65)', borderRadius: 7, padding: '4px 10px',
                    fontSize: 10, fontWeight: 600, cursor: 'pointer', letterSpacing: '0.03em',
                  }}
                >Exit</button>
              </div>
            </div>
          </div>

          {/* In landscape: right-side backdrop so chat is readable over page content */}
          {isLandscape && (
            <div style={{
              position: 'fixed', top: 0, right: 0, width: '38%', bottom: 0,
              zIndex: 48, background: 'rgba(13,13,21,0.97)',
              borderLeft: '1px solid rgba(255,255,255,0.06)',
              pointerEvents: 'none',
            }} />
          )}
        </>
      )}

      {/* ── Top bar ── */}
      <div className="crucible-topbar" style={{
        height: 40, display: 'flex', alignItems: 'center', padding: '0 16px 0 80px',
        background: 'transparent', flexShrink: 0,
        justifyContent: 'space-between', zIndex: 10, position: 'relative',
        WebkitAppRegion: 'drag',
      } as any}>
<div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 'auto', position: 'relative', WebkitAppRegion: 'no-drag' } as any}>
          {thinking && latestRound && (() => {
            const r = latestRound
            const isAgentMode = !!(r.agent || agentProgress)

            // ── Agent mode: rich step/iter/timer display ───────────────────
            if (isAgentMode && agentProgress) {
              const { stepIndex, stepTotal, stepIntent, iter, maxIters } = agentProgress
              const secs = Math.floor(agentElapsed / 1000)
              const mm = String(Math.floor(secs / 60)).padStart(2, '0')
              const ss = String(secs % 60).padStart(2, '0')
              const stepFrac = stepTotal > 1 ? ` · step ${stepIndex + 1}/${stepTotal}` : ''
              return (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, animation: 'fadeIn 0.3s' }}>
                  {/* Elapsed timer */}
                  <span style={{
                    fontVariantNumeric: 'tabular-nums', fontSize: 11, color: '#7c7cf8',
                    fontWeight: 600, letterSpacing: '0.04em',
                  }}>{mm}:{ss}</span>
                  <span style={{ fontSize: 9, color: '#444', letterSpacing: '0.06em' }}>
                    iter {iter}/{maxIters}{stepFrac}
                  </span>
                  {/* Step intent — truncated */}
                  <span style={{
                    fontSize: 9, color: '#333', maxWidth: 180,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const,
                    letterSpacing: '0.04em',
                  }} title={stepIntent}>{stepIntent}</span>
                </div>
              )
            }

            // ── Pipeline mode (quorum): stage dots + elapsed ───────────────
            // Live count of models that have streamed back a first-pass answer.
            const totalModels = r.models.length
            const respondedCount = r.models.filter(m => (r.responses?.[m.id] ?? '').length > 0).length
            const gatherLabel = totalModels > 0
              ? `gathering perspectives · ${respondedCount}/${totalModels}`
              : 'reading your message'
            const stage =
              !r.stage2Done && !r.stage3Started ? { label: gatherLabel,        n: 2 } :
              r.stage2Done  && !r.stage3Done    ? { label: 'cross-examining',  n: 3 } :
              r.stage3Done  && !r.stage4Done    ? { label: 'self-correcting',  n: 4 } :
              r.stage4Done  && !r.synthesisDone ? { label: 'synthesizing',     n: 5 } :
                                                  { label: gatherLabel,        n: 1 }
            const nextLabels: Record<number, string> = { 1: 'grading', 2: 'cross-examining', 3: 'self-correcting', 4: 'synthesizing' }
            const nextLabel = nextLabels[stage.n]
            const showNext = stage.n >= 1 && stage.n < 5 && nextLabel
            const secs = Math.floor(agentElapsed / 1000)
            const mm = String(Math.floor(secs / 60)).padStart(2, '0')
            const ss = String(secs % 60).padStart(2, '0')
            return (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, animation: 'fadeIn 0.3s' }}>
                {secs >= 3 && (
                  <span style={{ fontVariantNumeric: 'tabular-nums', fontSize: 10, color: '#444', fontWeight: 500 }}>
                    {mm}:{ss}
                  </span>
                )}
                <div style={{ display: 'flex', gap: 2 }}>
                  {[1,2,3,4,5].map(i => (
                    <div key={i} style={{
                      width: 3, height: 3, borderRadius: '50%',
                      background: i <= stage.n ? '#7c7cf8' : '#222',
                      transition: 'background 0.3s',
                      boxShadow: i === stage.n ? '0 0 4px #7c7cf8' : 'none',
                    }} />
                  ))}
                </div>
                <span style={{ fontSize: 10, color: '#555', letterSpacing: '0.07em' }}>{stage.label}…</span>
                {showNext && (
                  <span style={{ fontSize: 9, color: '#2a2a3a', letterSpacing: '0.07em' }}>
                    then {nextLabel}
                  </span>
                )}
              </div>
            )
          })()}
          {/* Prompt type badge */}
          {latestRound?.cached && (
            <span
              title={latestRound?.semanticSim ? `Reused from a similar earlier question: "${latestRound.semanticMatch}"` : undefined}
              style={{
              fontSize: 9, fontWeight: 700, letterSpacing: '0.1em',
              color: '#2a7a4a', textTransform: 'uppercase' as const,
              background: 'rgba(40,180,100,0.08)', padding: '3px 7px',
              borderRadius: 5, border: '1px solid rgba(40,180,100,0.2)',
              cursor: latestRound?.semanticSim ? 'help' : 'default',
            }}>{latestRound?.semanticSim ? `similar · ${Math.round(latestRound.semanticSim * 100)}%` : 'cached'}</span>
          )}
          {latestRound?.promptType && (
            <span style={{
              fontSize: 9, fontWeight: 700, letterSpacing: '0.1em',
              color: '#3a3a5a', textTransform: 'uppercase' as const,
              background: 'rgba(124,124,248,0.06)', padding: '3px 7px',
              borderRadius: 5, border: '1px solid rgba(124,124,248,0.1)',
            }}>{latestRound.promptType}</span>
          )}
{reconnecting && (
            <span style={{
              fontSize: 9, fontWeight: 700, letterSpacing: '0.1em',
              color: 'rgba(245,158,11,0.8)', textTransform: 'uppercase',
              animation: 'pulse 1.4s ease infinite',
            }}>reconnecting…</span>
          )}
          <HistoryBinder onRestore={session => {
              const restored: Round = {
                ...emptyRound(`hist-${session.ts}`, session.query),
                promptType: session.promptType,
                synthesis: session.synthesis,
                synthesisDone: true,
                models: session.models.map(id => ({ id, label: id, provider: '', isWildcard: false, color: '#7c7cf8', rgb: '124,124,248' })),
                done: Object.fromEntries(session.models.map(id => [id, true])),
              }
              setRounds(prev => [...prev, restored])
            }} />
<button className="crucible-menu-btn" onClick={() => setMenuOpen(o => !o)} style={{
            background: 'none', border: 'none', cursor: 'pointer',
            color: '#555', padding: '6px 8px', borderRadius: 8,
            display: 'flex', flexDirection: 'column', gap: 3.5, alignItems: 'center', justifyContent: 'center',
          }}>
            {[0,1,2].map(i => (
              <span key={i} style={{
                display: 'block',
                width: 16,
                height: 1.5,
                borderRadius: 2,
                background: menuOpen ? '#fff' : govPending > 0 ? 'rgba(255,180,80,0.7)' : '#555',
                transition: 'background 0.2s',
                animation: govPending > 0 && !menuOpen ? 'amberBreath 2.4s ease-in-out infinite' : 'none',
              }} />
            ))}
          </button>
          {menuOpen && (
            <div style={{
              position: 'absolute', top: '100%', right: 0, zIndex: 100,
              background: '#111114', border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: 10, padding: '4px 0', minWidth: 200,
              boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
            }}>
              {[
                {
                  label: 'API Keys',
                  action: () => alert('API Keys — coming soon'),
                  icon: (
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="6" cy="10" r="3.2"/>
                      <path d="M8.8 7.2l4.8-4.8M11 3l2 2M9.5 4.5l2 2"/>
                    </svg>
                  ),
                },
                {
                  label: 'Pipeline Config',
                  action: () => alert('Pipeline Config — coming soon'),
                  icon: (
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
                      <line x1="2" y1="4" x2="14" y2="4"/>
                      <line x1="2" y1="8" x2="14" y2="8"/>
                      <line x1="2" y1="12" x2="14" y2="12"/>
                      <circle cx="5" cy="4" r="1.5" fill="#111114"/>
                      <circle cx="10" cy="8" r="1.5" fill="#111114"/>
                      <circle cx="6" cy="12" r="1.5" fill="#111114"/>
                    </svg>
                  ),
                },
                {
                  label: 'Model Roster',
                  action: () => alert('Model Roster — coming soon'),
                  icon: (
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
                      <circle cx="4" cy="4" r="1.5"/>
                      <circle cx="4" cy="8" r="1.5"/>
                      <circle cx="4" cy="12" r="1.5"/>
                      <line x1="7" y1="4" x2="14" y2="4"/>
                      <line x1="7" y1="8" x2="14" y2="8"/>
                      <line x1="7" y1="12" x2="14" y2="12"/>
                    </svg>
                  ),
                },
              ].map(item => (
                <button
                  key={item.label}
                  onClick={() => { item.action(); setMenuOpen(false) }}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    width: '100%', padding: '9px 14px',
                    background: 'none', border: 'none', cursor: 'pointer',
                    color: 'rgba(255,255,255,0.4)', fontSize: 12.5, textAlign: 'left' as const,
                    transition: 'background 0.15s, color 0.15s',
                  }}
                  onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.04)'; e.currentTarget.style.color = 'rgba(255,255,255,0.85)' }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'none'; e.currentTarget.style.color = 'rgba(255,255,255,0.4)' }}
                >
                  <span style={{ flexShrink: 0, opacity: 0.6 }}>{item.icon}</span>
                  <span style={{ flex: 1 }}>{item.label}</span>
                </button>
              ))}

              <div style={{ height: 1, background: 'rgba(255,255,255,0.05)', margin: '4px 0' }} />

              {/* Connected Google Services */}
              {(() => {
                const svcLabels: Record<string, string> = {
                  gmail: 'Gmail', calendar: 'Calendar', drive: 'Drive', contacts: 'Contacts',
                  youtube: 'YouTube', fitness: 'Fitness', analytics: 'Analytics',
                  maps: 'Maps', kgSearch: 'Knowledge Graph', customSearch: 'Custom Search',
                }
                const connected = googleStatus ? Object.entries(googleStatus).filter(([, v]) => v).map(([k]) => k) : []
                const missing = googleStatus ? Object.entries(googleStatus).filter(([, v]) => !v).map(([k]) => k) : []
                return (
                  <div style={{ padding: '8px 14px 6px', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                    <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.25)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 7 }}>
                      Google Services
                    </div>
                    {!googleStatus && (
                      <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.2)', marginBottom: 4 }}>loading…</div>
                    )}
                    {googleStatus && connected.length === 0 && (
                      <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.2)', marginBottom: 4 }}>
                        Not connected — <a href={`${API_BASE}/api/auth/google`} style={{ color: 'rgba(100,180,255,0.7)', textDecoration: 'none' }}>sign in with Google</a>
                      </div>
                    )}
                    {googleStatus && connected.length > 0 && (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 4 }}>
                        {connected.map(k => (
                          <span key={k} style={{
                            fontSize: 10.5, padding: '2px 7px', borderRadius: 4,
                            background: 'rgba(52,211,153,0.12)', color: 'rgba(52,211,153,0.85)',
                            border: '1px solid rgba(52,211,153,0.2)',
                          }}>{svcLabels[k] ?? k}</span>
                        ))}
                        {missing.map(k => (
                          <span key={k} style={{
                            fontSize: 10.5, padding: '2px 7px', borderRadius: 4,
                            background: 'rgba(255,255,255,0.04)', color: 'rgba(255,255,255,0.2)',
                            border: '1px solid rgba(255,255,255,0.07)',
                          }}>{svcLabels[k] ?? k}</span>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })()}

              <button
                onClick={() => {
                  apiFetch(`${API_BASE}/api/governance`).then(r => r.json()).then((d: any[]) => {
                    setGovRequests(d)
                    setGovPending(d.filter((r: any) => r.status === 'pending').length)
                  }).catch(() => {})
                  setGovPanelOpen(o => !o)
                  setMenuOpen(false)
                }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  width: '100%', padding: '9px 14px',
                  background: 'none', border: 'none', cursor: 'pointer',
                  color: govPending > 0 ? 'rgba(255,180,80,0.85)' : 'rgba(255,255,255,0.4)',
                  fontSize: 12.5, textAlign: 'left' as const,
                  transition: 'background 0.15s, color 0.15s',
                }}
                onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.04)'; e.currentTarget.style.color = govPending > 0 ? 'rgba(255,180,80,1)' : 'rgba(255,255,255,0.85)' }}
                onMouseLeave={e => { e.currentTarget.style.background = 'none'; e.currentTarget.style.color = govPending > 0 ? 'rgba(255,180,80,0.85)' : 'rgba(255,255,255,0.4)' }}
              >
                <span style={{ flexShrink: 0, opacity: govPending > 0 ? 1 : 0.6, color: govPending > 0 ? 'rgba(255,180,80,0.9)' : 'currentColor' }}>
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M8 1.5l1.8 3.2 3.7.54-2.68 2.6.63 3.66L8 9.7l-3.45 1.8.63-3.66L2.5 5.24l3.7-.54z"/>
                  </svg>
                </span>
                <span style={{ flex: 1 }}>Infrastructure</span>
                {govPending > 0 && (
                  <span style={{
                    background: 'rgba(255,180,80,0.15)', color: 'rgba(255,180,80,0.9)',
                    border: '1px solid rgba(255,180,80,0.3)',
                    borderRadius: 10, padding: '1px 6px',
                    fontSize: 9, fontWeight: 700, letterSpacing: '0.04em',
                  }}>{govPending}</span>
                )}
              </button>

              <div style={{ height: 1, background: 'rgba(255,255,255,0.05)', margin: '4px 0' }} />

              <button
                onClick={() => { alert('Crucible v0.1'); setMenuOpen(false) }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  width: '100%', padding: '9px 14px',
                  background: 'none', border: 'none', cursor: 'pointer',
                  color: 'rgba(255,255,255,0.4)', fontSize: 12.5, textAlign: 'left' as const,
                  transition: 'background 0.15s, color 0.15s',
                }}
                onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.04)'; e.currentTarget.style.color = 'rgba(255,255,255,0.85)' }}
                onMouseLeave={e => { e.currentTarget.style.background = 'none'; e.currentTarget.style.color = 'rgba(255,255,255,0.4)' }}
              >
                <span style={{ flexShrink: 0, opacity: 0.6 }}>
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
                    <circle cx="8" cy="8" r="6.2"/>
                    <line x1="8" y1="7" x2="8" y2="11"/>
                    <circle cx="8" cy="4.5" r="0.7" fill="currentColor" stroke="none"/>
                  </svg>
                </span>
                <span style={{ flex: 1 }}>About</span>
              </button>
            </div>
          )}
        </div>
      </div>

      {/* N1 — Governance panel */}
      {govPanelOpen && (
        <div style={{
          position: 'fixed', top: 50, right: 16, zIndex: 200, width: 340, maxHeight: '70vh',
          background: '#111114', border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: 12, boxShadow: '0 16px 48px rgba(0,0,0,0.7)',
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
        }}>
          <div style={{ padding: '12px 14px 10px', borderBottom: '1px solid rgba(255,255,255,0.06)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 11, letterSpacing: '0.08em', color: 'rgba(255,255,255,0.5)', textTransform: 'uppercase' as const }}>Infrastructure requests</span>
            <button onClick={() => setGovPanelOpen(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'rgba(255,255,255,0.3)', fontSize: 14, lineHeight: 1 }}>×</button>
          </div>
          <div style={{ overflowY: 'auto' as const, flex: 1, padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {govRequests.length === 0 && (
              <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.25)', padding: '12px 4px' }}>No infrastructure requests yet.</div>
            )}
            {[...govRequests].reverse().map((r: any) => (
              <div key={r.id} style={{
                background: r.status === 'pending' ? 'rgba(255,180,80,0.04)' : 'rgba(255,255,255,0.02)',
                border: `1px solid ${r.status === 'pending' ? 'rgba(255,180,80,0.2)' : r.status === 'approved' ? 'rgba(77,220,160,0.15)' : 'rgba(248,124,124,0.15)'}`,
                borderRadius: 8, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 6,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  <span style={{ fontSize: 11, fontWeight: 600, color: 'rgba(255,255,255,0.75)' }}>{r.title}</span>
                  <span style={{
                    fontSize: 8, letterSpacing: '0.07em', textTransform: 'uppercase' as const, padding: '2px 6px', borderRadius: 4,
                    color: r.status === 'pending' ? 'rgba(255,180,80,0.8)' : r.status === 'approved' ? 'rgba(77,220,160,0.8)' : 'rgba(248,124,124,0.7)',
                    border: `1px solid ${r.status === 'pending' ? 'rgba(255,180,80,0.3)' : r.status === 'approved' ? 'rgba(77,220,160,0.3)' : 'rgba(248,124,124,0.3)'}`,
                  }}>{r.status}</span>
                </div>
                <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.35)', lineHeight: 1.5 }}><b style={{ color: 'rgba(255,255,255,0.4)' }}>What:</b> {r.what}</div>
                <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.35)', lineHeight: 1.5 }}><b style={{ color: 'rgba(255,255,255,0.4)' }}>Why:</b> {r.why}</div>
                <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.35)', lineHeight: 1.5 }}><b style={{ color: 'rgba(255,255,255,0.4)' }}>Impact:</b> {r.impact}</div>
                {r.status === 'pending' && (
                  <div style={{ display: 'flex', gap: 6, marginTop: 2 }}>
                    <button onClick={() => {
                      apiFetch(`${API_BASE}/api/governance/${r.id}/approve`, { method: 'POST' })
                        .then(res => res.json())
                        .then(() => { setGovRequests(prev => prev.map((x: any) => x.id === r.id ? { ...x, status: 'approved' } : x)); setGovPending(p => Math.max(0, p - 1)) })
                        .catch(() => {})
                    }} style={{
                      flex: 1, padding: '5px 0', background: 'rgba(77,220,160,0.1)', border: '1px solid rgba(77,220,160,0.25)',
                      borderRadius: 5, cursor: 'pointer', color: 'rgba(77,220,160,0.8)', fontSize: 10, letterSpacing: '0.05em',
                    }}>Approve</button>
                    <button onClick={() => {
                      apiFetch(`${API_BASE}/api/governance/${r.id}/reject`, { method: 'POST' })
                        .then(res => res.json())
                        .then(() => { setGovRequests(prev => prev.map((x: any) => x.id === r.id ? { ...x, status: 'rejected' } : x)); setGovPending(p => Math.max(0, p - 1)) })
                        .catch(() => {})
                    }} style={{
                      flex: 1, padding: '5px 0', background: 'rgba(248,124,124,0.07)', border: '1px solid rgba(248,124,124,0.2)',
                      borderRadius: 5, cursor: 'pointer', color: 'rgba(248,124,124,0.7)', fontSize: 10, letterSpacing: '0.05em',
                    }}>Reject</button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Resume offer banner ── */}
      {resumeOffer && (
        <div className="crucible-resume-banner" style={{
          position: 'fixed', bottom: 155, left: '50%', transform: 'translateX(-50%)',
          zIndex: 50, animation: 'panelUp 0.3s cubic-bezier(0.22,1,0.36,1)',
          background: 'rgba(18,18,28,0.96)', backdropFilter: 'blur(20px)',
          border: '1px solid rgba(124,124,248,0.25)',
          borderRadius: 14, padding: '14px 18px',
          display: 'flex', alignItems: 'center', gap: 14,
          boxShadow: '0 8px 40px rgba(0,0,0,0.5), 0 0 0 1px rgba(124,124,248,0.08)',
          maxWidth: 540,
        }}>
          {/* Pulse dot */}
          <div style={{
            width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
            background: '#7c7cf8',
            boxShadow: '0 0 8px rgba(124,124,248,0.7)',
            animation: 'dotpulse 1.2s ease-in-out infinite',
          }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: '#c8c8e8', marginBottom: 3,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>
              Paused at step {resumeOffer.stepIndex + 1}/{resumeOffer.stepTotal}, iteration {resumeOffer.iter}/{resumeOffer.maxIters}
            </div>
            <div style={{ fontSize: 10, color: '#444', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>
              {resumeOffer.stepIntent || resumeOffer.goal.slice(0, 80)}
            </div>
          </div>
          <button
            onClick={continueFromCheckpoint}
            style={{
              padding: '6px 14px', borderRadius: 8, border: '1px solid rgba(124,124,248,0.4)',
              background: 'rgba(124,124,248,0.12)', color: '#a0a0f8',
              fontSize: 11, fontWeight: 600, cursor: 'pointer', letterSpacing: '0.04em',
              flexShrink: 0, outline: 'none',
            }}
          >Continue</button>
          <button
            onClick={dismissResume}
            style={{
              padding: '6px 10px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.06)',
              background: 'transparent', color: '#333',
              fontSize: 11, cursor: 'pointer', flexShrink: 0, outline: 'none',
            }}
          >Dismiss</button>
        </div>
      )}

      {/* ── Message history ── */}
      <div ref={scrollRef} onScroll={handleScroll} onWheel={handleWheel} onTouchStart={handleTouchStart} onTouchMove={handleTouchMove} className="crucible-scroll" style={{
        flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column',
        alignItems: 'center', paddingTop: 28, paddingLeft: 24, paddingRight: 24, paddingBottom: inputBarHeight + 16,
        gap: 32, zIndex: 1,
        // Exponential alpha fade anchored to the CARD LINE. The scroll viewport now
        // extends to the very bottom (spacer moved inside), so the fade can land exactly
        // where the cards begin (`inputBarHeight - 8` px from the bottom). Text is fully
        // sharp until the card line, then the clustered stops make opacity fall off
        // progressively faster the deeper it goes behind the cards — sharp → ghost.
        WebkitMaskImage: `linear-gradient(to bottom, black 0%, black calc(100% - ${inputBarHeight - 8}px), rgba(0,0,0,0.92) calc(100% - ${inputBarHeight - 32}px), rgba(0,0,0,0.55) calc(100% - ${inputBarHeight - 68}px), rgba(0,0,0,0.18) calc(100% - ${Math.max(20, inputBarHeight - 103)}px), transparent 100%)`,
        maskImage: `linear-gradient(to bottom, black 0%, black calc(100% - ${inputBarHeight - 8}px), rgba(0,0,0,0.92) calc(100% - ${inputBarHeight - 32}px), rgba(0,0,0,0.55) calc(100% - ${inputBarHeight - 68}px), rgba(0,0,0,0.18) calc(100% - ${Math.max(20, inputBarHeight - 103)}px), transparent 100%)`,
      }}>
        {rounds.length === 0 && (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.18)', letterSpacing: '0.06em', fontWeight: 500 }}>Dynamic models. One answer.</span>
          </div>
        )}

        {rounds.map(round => {
          const models = round.models
          return (
            <div key={round.id} className="crucible-msg-width" style={{
              width: '100%', maxWidth: 680, display: 'flex', flexDirection: 'column', gap: 12,
            }}>

              {/* User bubble */}
              <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 4 }}>
                <CopyButton text={round.userMessage} inline title="Copy message" />
                <div
                  onClick={() => models.length > 0 && setRounds(prev => prev.map(r =>
                    r.id === round.id ? { ...r, expandedModel: r.expandedModel ? null : models[0].id } : r
                  ))}
                  className="crucible-user-bubble"
                  style={{
                    maxWidth: '62%', padding: '9px 14px', borderRadius: 14,
                    fontSize: 13, lineHeight: 1.58, cursor: models.length > 0 ? 'pointer' : 'default',
                    background: round.expandedModel ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.055)',
                    border: `1px solid ${round.expandedModel ? 'rgba(255,255,255,0.14)' : 'rgba(255,255,255,0.09)'}`,
                    // Subtle bottom accent (hints "expandable") via boxShadow — avoids the
                    // border/borderBottom shorthand-vs-longhand conflict React warns about.
                    boxShadow: models.length > 0 ? 'inset 0 -1px 0 rgba(255,255,255,0.12)' : undefined,
                    color: '#ccc', transition: 'background 0.2s, border-color 0.2s',
                    userSelect: 'none' as const, textAlign: 'left' as const,
                    overflowWrap: 'anywhere' as const, wordBreak: 'break-word' as const,
                  }}>
                  {round.userMessage}
                </div>
              </div>

              {/* Agent loop panel (Section 7) */}
              {round.agent && <AgentPanel agent={round.agent} />}

              {/* Pipeline Theater — all model cards, shown when user message is clicked */}
              {round.expandedModel && <PipelineTheater round={round} />}

              {/* Critique grid (desktop) + mobile status pill */}
              {round.stage3Started && models.length > 0 && round.complexity === 'complex' && (
                <>
                  <CritiqueGrid round={round} onToggle={(critic, target) => toggleCritique(round.id, critic, target)} />
                  {/* Mobile-only: subtle status line while critique runs */}
                  <div className="crucible-pipeline-status" style={{ display: 'none' }}>
                    <span style={{
                      fontSize: 10, color: 'rgba(255,255,255,0.3)', letterSpacing: '0.06em',
                      fontWeight: 500, textTransform: 'uppercase' as const,
                    }}>
                      {round.stage3Done ? (round.stage4Done ? (round.synthesisDone ? '✦ done' : 'polishing…') : 'refining…') : `models debating · ${models.length} perspectives`}
                    </span>
                  </div>
                </>
              )}


              {/* Post-critique pipeline progress */}
              {round.stage3Done && round.complexity === 'complex' && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '10px 2px', animation: 'fadeIn 0.4s', minWidth: 0 }}>
                  {[
                    { label: 'peer scoring',  done: round.stage2Done   },
                    { label: 'cross-critique', done: round.stage3Done  },
                    { label: 'self-refine',    done: round.stage4Done  },
                    { label: 'synthesis',      done: round.synthesisDone },
                  ].map((step, i, arr) => (
                    <div key={step.label} style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1 }}>
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, flex: 1 }}>
                        <div style={{
                          width: '100%', height: 2, borderRadius: 2,
                          background: step.done ? '#7c7cf8' : 'rgba(255,255,255,0.06)',
                          transition: 'background 0.5s',
                          boxShadow: step.done ? '0 0 6px rgba(124,124,248,0.4)' : 'none',
                        }} />
                        <span style={{
                          fontSize: 7, letterSpacing: '0.06em', textTransform: 'uppercase' as const,
                          color: step.done ? 'rgba(124,124,248,0.5)' : '#222', transition: 'color 0.3s',
                          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%',
                        }}>{step.label}</span>
                      </div>
                      {i < arr.length - 1 && (
                        <div style={{ width: 4, height: 4, borderRadius: '50%', background: '#1a1a28', flexShrink: 0, marginBottom: 12 }} />
                      )}
                    </div>
                  ))}
                </div>
              )}


              {/* Activity Feed — moved to fixed overlay */}

              {/* Synthesis */}
              {round.synthesis.length > 0 && (
                <div style={{
                  position: 'relative', borderRadius: 14, padding: '16px 18px', width: '100%', boxSizing: 'border-box' as const, overflow: 'hidden',
                  background: 'linear-gradient(135deg, rgba(124,124,248,0.07) 0%, rgba(77,184,158,0.05) 50%, rgba(192,132,252,0.07) 100%)',
                  backdropFilter: 'blur(28px)', WebkitBackdropFilter: 'blur(28px)',
                  border: '1px solid rgba(255,255,255,0.1)',
                  boxShadow: round.synthesisDone
                    ? '0 0 32px rgba(124,124,248,0.08), inset 0 1px 0 rgba(255,255,255,0.06)'
                    : 'inset 0 1px 0 rgba(255,255,255,0.04)',
                  animation: 'fadeIn 0.3s ease',
                }}>
                  {round.synthesisDone && (
                    <div style={{ position: 'absolute', top: 12, right: 14, zIndex: 2 }}>
                      <CopyButton text={`${round.userMessage}\n\n${round.synthesis}`} inline title="Copy full exchange" />
                    </div>
                  )}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 0, flexWrap: 'wrap' as const, paddingRight: 28 }}>
                    <div style={{ display: 'flex', gap: 3 }}>
                      {models.map(m => (
                        <span key={m.id} style={{ width: 5, height: 5, borderRadius: '50%', background: m.color, opacity: 0.8 }} />
                      ))}
                    </div>
                    <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', color: 'rgba(255,255,255,0.25)', textTransform: 'uppercase' as const }}>
                      {round.synthesisDone ? 'consensus' : round.synthStreaming ? 'writing…' : 'synthesizing…'}
                    </span>
                    {round.synthesisDone && models.length > 0 && (() => {
                      // Attribution: synthesizer led, 2nd scorer refined, rest contributed
                      const dropped = new Set(round.activityFeed.filter(e => e.type === 'rollback').map(e => e.modelId))
                      const active = models.filter(m => !dropped.has(m.id))
                      const sorted = [...active].sort((a, b) => (round.avgScores[b.id] ?? 0) - (round.avgScores[a.id] ?? 0))
                      const synth = models.find(m => m.id === round.synthesisModelId) ?? sorted[0]
                      const others = sorted.filter(m => m.id !== synth?.id)
                      const parts: Array<{ model: DynamicModel; role: string }> = synth
                        ? [{ model: synth, role: 'led synthesis' }, ...others.slice(0, 2).map((m, i) => ({ model: m, role: i === 0 ? 'refined' : 'contributed' }))]
                        : []
                      if (!parts.length) return null
                      return (
                        <span style={{ fontSize: 9, color: '#2a2a3a', marginLeft: 2, display: 'flex', gap: 6, flexWrap: 'wrap' as const, alignItems: 'center' }}>
                          {parts.map(({ model: m, role }, i) => (
                            <span key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                              {i > 0 && <span style={{ color: '#1a1a28' }}>·</span>}
                              <span style={{ color: m.color, fontWeight: 700 }}>{m.label}</span>
                              <span style={{ color: '#282838' }}>{role}</span>
                            </span>
                          ))}
                        </span>
                      )
                    })()}
                  </div>
                  <div style={{ height: 1, background: 'rgba(255,255,255,0.06)', margin: '10px -18px 12px' }} />
                  <div style={{ fontSize: 13.5, lineHeight: 1.75, color: '#d8d8e8', maxWidth: '100%', overflow: 'hidden', overflowWrap: 'anywhere' as const, wordBreak: 'break-word' as const, userSelect: 'text' as const }}>
                   <ReactMarkdown
                     components={{
                       pre({ children }: any) { return <>{children}</> },
                       code({ node, className, children, ...props }: any) {
                         const match = /language-(\w+)/.exec(className || '')
                         const isBlock = !props.inline
                         const code = String(children).replace(/\n$/, '')
                         if (isBlock && match) {
                           return <CollapsibleCode language={match[1]} code={code} />
                         }
                         if (isBlock) {
                           return (
                             <div style={{
                               overflowX: 'auto', maxWidth: '100%', boxSizing: 'border-box' as const,
                               fontFamily: '"SF Mono","Fira Code",monospace', fontSize: 12, lineHeight: 1.5,
                               background: 'rgba(0,0,0,0.25)', borderRadius: 8,
                               padding: '10px 12px', margin: '8px 0', whiteSpace: 'pre-wrap' as const,
                               wordBreak: 'break-word' as const, overflowWrap: 'anywhere' as const,
                               color: '#c8c8d0', userSelect: 'text' as const,
                             }}>{code}</div>
                           )
                         }
                         return <code style={{ background: 'rgba(255,255,255,0.08)', padding: '1px 5px', borderRadius: 4, fontSize: 12, overflowWrap: 'anywhere', wordBreak: 'break-word' }} {...props}>{children}</code>
                       },
                       p({ children }: any) { return <p style={{ margin: '0 0 10px' }}>{children}</p> },
                       ul({ children }: any) { return <ul style={{ paddingLeft: 20, margin: '0 0 10px' }}>{children}</ul> },
                       ol({ children }: any) { return <ol style={{ paddingLeft: 20, margin: '0 0 10px' }}>{children}</ol> },
                       li({ children }: any) { return <li style={{ marginBottom: 4 }}>{children}</li> },
                       h1({ children }: any) { return <h1 style={{ fontSize: 16, fontWeight: 700, margin: '14px 0 6px', color: '#fff' }}>{children}</h1> },
                       h2({ children }: any) { return <h2 style={{ fontSize: 14, fontWeight: 700, margin: '12px 0 5px', color: '#fff' }}>{children}</h2> },
                       h3({ children }: any) { return <h3 style={{ fontSize: 13, fontWeight: 600, margin: '10px 0 4px', color: 'rgba(255,255,255,0.8)' }}>{children}</h3> },
                     }}
                   >{round.synthesis}</ReactMarkdown>
                   {round.synthStreaming && !round.synthesisDone && (
                     <span style={{
                       display: 'inline-block', width: 2, height: '0.95em',
                       background: 'rgba(124,124,248,0.7)',
                       verticalAlign: 'text-bottom',
                       animation: 'dotpulse 0.9s ease-in-out infinite',
                       marginLeft: 2, borderRadius: 1,
                     }} />
                   )}
                 </div>
                  {round.synthesisDone && (() => {
                   // Unified process trail — always present, always expandable.
                   // One place to see how the answer was built: models, scores, critique,
                   // confidence, fragility, frontier questions, dropped models.
                   const conf = round.confidence
                   const overallTier = conf?.overallTier ?? 'UNVERIFIED'
                   const overallScore = conf?.overallScore ?? 0
                   const summary = conf?.summary ?? { high: 0, medium: 0, low: 0, unverified: 0 }
                   const flaggedClaims = conf?.flaggedClaims ?? []
                   const fragilityAssumption = conf?.fragilityAssumption
                   const frontierQuestion = conf?.frontierQuestion
                   const tierColor = overallTier === 'HIGH'
                     ? 'rgba(77,220,160,0.7)'
                     : overallTier === 'MEDIUM'
                     ? 'rgba(255,200,80,0.7)'
                     : 'rgba(248,124,124,0.7)'
                   // ── Unified process trail ─────────────────────────────────
                   // Always present, always expandable. Not a feature — this is
                   // how a trustworthy system accounts for itself.
                   const active = round.models.filter(m =>
                     !round.activityFeed.some(e => e.type === 'rollback' && e.modelId === m.id) &&
                     (round.avgScores[m.id] ?? 0) > 0
                   )
                   const dropped = round.models.filter(m =>
                     round.activityFeed.some(e => e.type === 'rollback' && e.modelId === m.id)
                   )
                   const synthesizer = round.models.find(m => m.id === round.synthesisModelId)
                   const topScore = active.length > 0 ? Math.max(...active.map(m => round.avgScores[m.id] ?? 0)) : 0
                   const hasFlagged = flaggedClaims.length > 0
                   const scoreSpread = active.length > 1
                     ? Math.max(...active.map(m => round.avgScores[m.id] ?? 0)) - Math.min(...active.map(m => round.avgScores[m.id] ?? 0))
                     : 0
                   const hadDisagreement = scoreSpread > 0.25

                   // Summary chips for the collapsed state
                   const chips: { label: string; color: string }[] = [
                     { label: `${active.length} model${active.length !== 1 ? 's' : ''}`, color: 'rgba(255,255,255,0.22)' },
                     { label: `${Math.round(overallScore * 100)}% confident`, color: tierColor },
                     ...(hasFlagged ? [{ label: `${flaggedClaims.length} flagged`, color: 'rgba(248,124,124,0.6)' }] : []),
                     ...(fragilityAssumption ? [{ label: 'fragile assumption', color: 'rgba(255,200,80,0.55)' }] : []),
                     ...(frontierQuestion ? [{ label: 'open question', color: 'rgba(100,180,255,0.55)' }] : []),
                     ...(hadDisagreement ? [{ label: 'models disagreed', color: 'rgba(200,160,255,0.55)' }] : []),
                     ...(dropped.length > 0 ? [{ label: `${dropped.length} dropped`, color: 'rgba(248,124,124,0.4)' }] : []),
                     ...(round.criticProblems && round.criticProblems.length > 0 ? [{ label: `${round.criticProblems.length} critic flag${round.criticProblems.length !== 1 ? 's' : ''}`, color: 'rgba(248,124,124,0.5)' }] : []),
                     ...(round.masterpiece?.connectionsSurvived ? [{ label: `masterpiece · ${round.masterpiece.connectionsSurvived} cross-domain`, color: 'rgba(130,160,255,0.55)' }] : []),
                   ]

                   return (
                     <>
                       {/* Copy + feedback — between answer and process trail */}
                       <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
                         <CopyButton text={round.synthesis} inline title="Copy answer" />
                         <FeedbackButtons query={round.userMessage} synthesis={round.synthesis} promptType={round.promptType} />
                       </div>

                       {/* Process trail — progressive disclosure: collapsed by default on
                           mobile, expanded by default on desktop. Set once per element via
                           ref so streaming re-renders don't snap it back. */}
                       <details
                         style={{ marginTop: 10 }}
                         ref={el => {
                           if (el && el.dataset.init !== '1') {
                             el.open = window.innerWidth > 640
                             el.dataset.init = '1'
                           }
                         }}
                       >
                         <summary style={{
                           fontSize: 10, letterSpacing: '0.05em', color: 'rgba(255,255,255,0.22)',
                           cursor: 'pointer', userSelect: 'none' as const, listStyle: 'none',
                           display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' as const,
                         }}>
                           <span style={{ fontFamily: 'monospace', fontSize: 9, color: 'rgba(255,255,255,0.18)' }}>▸</span>
                           {chips.map((chip, i) => (
                             <span key={i} style={{
                               color: chip.color,
                               borderRight: i < chips.length - 1 ? '1px solid rgba(255,255,255,0.08)' : 'none',
                               paddingRight: i < chips.length - 1 ? 6 : 0,
                             }}>{chip.label}</span>
                           ))}
                         </summary>

                         <div style={{
                           marginTop: 8, padding: '12px 14px', borderRadius: 8,
                           background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)',
                           display: 'flex', flexDirection: 'column' as const, gap: 12,
                         }}>

                           {/* Model scores */}
                           {active.length > 0 && (
                             <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 5 }}>
                               <div style={{ fontSize: 9, letterSpacing: '0.09em', textTransform: 'uppercase' as const, color: 'rgba(255,255,255,0.2)', marginBottom: 2 }}>ensemble</div>
                               {active.map(m => {
                                 const sc = round.avgScores[m.id] ?? 0
                                 const isSynth = m.id === round.synthesisModelId
                                 return (
                                   <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                     <span style={{
                                       width: 5, height: 5, borderRadius: '50%', flexShrink: 0,
                                       background: m.color ?? 'rgba(124,124,248,0.7)',
                                     }} />
                                     <span style={{ fontSize: 10, color: isSynth ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.35)', minWidth: 0, flex: 1 }}>
                                       {m.label}
                                       {isSynth && <span style={{ fontSize: 8, letterSpacing: '0.07em', color: 'rgba(124,124,248,0.6)', marginLeft: 5 }}>synthesizer</span>}
                                     </span>
                                     <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                                       <div style={{ width: 48, height: 3, borderRadius: 2, background: 'rgba(255,255,255,0.07)', overflow: 'hidden' }}>
                                         <div style={{ width: `${sc * 100}%`, height: '100%', background: sc >= 0.75 ? 'rgba(77,220,160,0.6)' : sc >= 0.5 ? 'rgba(255,200,80,0.6)' : 'rgba(248,124,124,0.5)', borderRadius: 2 }} />
                                       </div>
                                       <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.3)', fontFamily: 'monospace', width: 28, textAlign: 'right' as const }}>{(sc * 100).toFixed(0)}%</span>
                                     </div>
                                   </div>
                                 )
                               })}
                               {dropped.length > 0 && (
                                 <div style={{ fontSize: 9, color: 'rgba(248,124,124,0.4)', marginTop: 2 }}>
                                   dropped: {dropped.map(m => m.label).join(', ')}
                                 </div>
                               )}
                               {round.genealogy && Object.keys(round.genealogy).some(id => (round.genealogy![id] ?? 0) > 0) && (
                                 <div style={{ marginTop: 6 }}>
                                   <div style={{ fontSize: 9, letterSpacing: '0.09em', textTransform: 'uppercase' as const, color: 'rgba(255,255,255,0.2)', marginBottom: 4 }}>synthesis contribution</div>
                                   {active
                                     .filter(m => (round.genealogy![m.id] ?? 0) > 0)
                                     .sort((a, b) => (round.genealogy![b.id] ?? 0) - (round.genealogy![a.id] ?? 0))
                                     .map(m => {
                                       const rate = round.genealogy![m.id] ?? 0
                                       return (
                                         <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
                                           <span style={{ width: 5, height: 5, borderRadius: '50%', flexShrink: 0, background: m.color ?? 'rgba(124,124,248,0.7)' }} />
                                           <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.3)', flex: 1, minWidth: 0 }}>{m.label}</span>
                                           <div style={{ width: 48, height: 3, borderRadius: 2, background: 'rgba(255,255,255,0.07)', overflow: 'hidden' }}>
                                             <div style={{ width: `${rate * 100}%`, height: '100%', background: 'rgba(124,124,248,0.5)', borderRadius: 2 }} />
                                           </div>
                                           <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.3)', fontFamily: 'monospace', width: 28, textAlign: 'right' as const }}>{Math.round(rate * 100)}%</span>
                                         </div>
                                       )
                                     })
                                   }
                                 </div>
                               )}
                             </div>
                           )}

                           {/* Process narrative */}
                           <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.3)', lineHeight: 1.65 }}>
                             {narrateProcess(round, active, dropped, synthesizer, topScore)}
                           </div>

                           {/* Confidence breakdown */}
                           {conf && (
                             <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 4 }}>
                               <div style={{ fontSize: 9, letterSpacing: '0.09em', textTransform: 'uppercase' as const, color: 'rgba(255,255,255,0.2)', marginBottom: 2 }}>confidence breakdown</div>
                               <div style={{ display: 'flex', gap: 10, fontSize: 10 }}>
                                 {summary.high > 0 && <span style={{ color: 'rgba(77,220,160,0.6)' }}>{summary.high} high</span>}
                                 {summary.medium > 0 && <span style={{ color: 'rgba(255,200,80,0.5)' }}>{summary.medium} medium</span>}
                                 {summary.low > 0 && <span style={{ color: 'rgba(255,180,80,0.6)' }}>{summary.low} low</span>}
                                 {summary.unverified > 0 && <span style={{ color: 'rgba(248,124,124,0.6)' }}>{summary.unverified} unverified</span>}
                               </div>
                               {flaggedClaims.map((fc, i) => (
                                 <div key={i} style={{ fontSize: 10, color: 'rgba(255,255,255,0.3)', lineHeight: 1.5, wordBreak: 'break-word' as const }}>
                                   <span style={{ fontSize: 9, letterSpacing: '0.06em', marginRight: 6, color: fc.tier === 'UNVERIFIED' ? 'rgba(248,124,124,0.5)' : 'rgba(255,180,80,0.5)' }}>{fc.tier}</span>
                                   {fc.claim}
                                 </div>
                               ))}
                             </div>
                           )}

                           {/* Fragility assumption */}
                           {fragilityAssumption && (
                             <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 3 }}>
                               <div style={{ fontSize: 9, letterSpacing: '0.09em', textTransform: 'uppercase' as const, color: 'rgba(255,200,80,0.45)' }}>fragile assumption</div>
                               <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', lineHeight: 1.55, fontStyle: 'italic' as const }}>{fragilityAssumption}</div>
                             </div>
                           )}

                           {/* Frontier question */}
                           {frontierQuestion && (
                             <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 3 }}>
                               <div style={{ fontSize: 9, letterSpacing: '0.09em', textTransform: 'uppercase' as const, color: 'rgba(100,180,255,0.45)' }}>open research question</div>
                               <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.45)', lineHeight: 1.55, fontStyle: 'italic' as const }}>{frontierQuestion}</div>
                             </div>
                           )}

                           {/* I5 Adversarial critic findings */}
                           {round.criticProblems && round.criticProblems.length > 0 && (
                             <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 4 }}>
                               <div style={{ fontSize: 9, letterSpacing: '0.09em', textTransform: 'uppercase' as const, color: 'rgba(248,124,124,0.5)' }}>critic flags</div>
                               {round.criticProblems.map((p, i) => (
                                 <div key={i} style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', lineHeight: 1.55, paddingLeft: 8, borderLeft: '2px solid rgba(248,124,124,0.2)' }}>{p}</div>
                               ))}
                             </div>
                           )}

                           {/* P12 — live shard progress during deep-mode MASTERPIECE */}
                           {round.masterpiece?.active && round.masterpiece.shardsTotal != null && round.masterpiece.shardsCompleted != null && round.masterpiece.shardsCompleted < round.masterpiece.shardsTotal && (
                             <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                               <div style={{ fontSize: 9, letterSpacing: '0.09em', textTransform: 'uppercase' as const, color: 'rgba(130,160,255,0.55)' }}>deep analysis</div>
                               <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.3)' }}>
                                 {round.masterpiece.shardsCompleted}/{round.masterpiece.shardsTotal} shards
                               </div>
                               <div style={{ flex: 1, height: 2, background: 'rgba(255,255,255,0.08)', borderRadius: 1, overflow: 'hidden' }}>
                                 <div style={{ height: '100%', width: `${Math.round((round.masterpiece.shardsCompleted / round.masterpiece.shardsTotal) * 100)}%`, background: 'rgba(130,160,255,0.5)', transition: 'width 0.4s ease' }} />
                               </div>
                             </div>
                           )}

                           {/* Track P — MASTERPIECE analysis metadata */}
                           {round.masterpiece && (round.masterpiece.shardCount || round.masterpiece.connectionsFound) && (
                             <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 5 }}>
                               <div style={{ fontSize: 9, letterSpacing: '0.09em', textTransform: 'uppercase' as const, color: 'rgba(130,160,255,0.55)' }}>masterpiece synthesis</div>
                               <div style={{ display: 'flex', flexWrap: 'wrap' as const, gap: 8 }}>
                                 {round.masterpiece.shardCount && (
                                   <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.35)' }}>{round.masterpiece.shardCount} shards</span>
                                 )}
                                 {round.masterpiece.connectionsSurvived != null && (
                                   <span style={{ fontSize: 10, color: 'rgba(130,220,160,0.5)' }}>{round.masterpiece.connectionsSurvived} cross-domain connections</span>
                                 )}
                                 {round.masterpiece.resonancesFound != null && round.masterpiece.resonancesFound > 0 && (
                                   <span style={{ fontSize: 10, color: 'rgba(130,160,255,0.5)' }}>{round.masterpiece.resonancesFound} structural resonance{round.masterpiece.resonancesFound !== 1 ? 's' : ''}</span>
                                 )}
                                 {round.masterpiece.escalatedCount != null && round.masterpiece.escalatedCount > 0 && (
                                   <span style={{ fontSize: 10, color: 'rgba(255,200,80,0.45)' }}>{round.masterpiece.escalatedCount} escalated</span>
                                 )}
                                 {round.masterpiece.elapsedMs && (
                                   <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.2)' }}>{(round.masterpiece.elapsedMs / 1000).toFixed(1)}s</span>
                                 )}
                               </div>
                               {round.masterpiece.domains && round.masterpiece.domains.length > 0 && (
                                 <div style={{ fontSize: 10, color: 'rgba(130,160,255,0.35)', lineHeight: 1.55 }}>
                                   {round.masterpiece.domains.slice(0, 4).join('  ·  ')}
                                 </div>
                               )}
                               {round.masterpiece.patterns && round.masterpiece.patterns.length > 0 && (
                                 <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.2)', lineHeight: 1.55 }}>
                                   patterns: {round.masterpiece.patterns.join(', ')}
                                 </div>
                               )}
                               {round.masterpiece.tiers && round.masterpiece.tiers.some(t => t.tier === 'HIGH') && (
                                 <div style={{ fontSize: 10, color: 'rgba(77,220,160,0.4)', lineHeight: 1.55 }}>
                                   {round.masterpiece.tiers.filter(t => t.tier === 'HIGH').length} high-confidence shards
                                 </div>
                               )}
                             </div>
                           )}

                           {/* Track P — light-mode cross-domain connection (novelty > 0.6) */}
                           {round.crossDomainConnection && (
                             <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 3 }}>
                               <div style={{ fontSize: 9, letterSpacing: '0.09em', textTransform: 'uppercase' as const, color: 'rgba(130,160,255,0.5)' }}>cross-domain connection</div>
                               <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', lineHeight: 1.55 }}>{round.crossDomainConnection}</div>
                             </div>
                           )}

                           {/* Proactive suggestion */}
                           {round.proactiveSuggestion && (
                             <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 3 }}>
                               <div style={{ fontSize: 9, letterSpacing: '0.09em', textTransform: 'uppercase' as const, color: 'rgba(100,180,255,0.35)' }}>also relevant</div>
                               <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', lineHeight: 1.55 }}>{round.proactiveSuggestion}</div>
                             </div>
                           )}

                           {/* Confidence-gated response commitment */}
                           {round.uncertainCommitment && (
                             <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 4, padding: '8px 10px', background: 'rgba(255,180,60,0.06)', borderRadius: 6, border: '1px solid rgba(255,180,60,0.15)' }}>
                               <div style={{ fontSize: 9, letterSpacing: '0.09em', textTransform: 'uppercase' as const, color: 'rgba(255,180,60,0.55)' }}>low confidence · {Math.round(round.uncertainCommitment.overallScore * 100)}%</div>
                               <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.45)', lineHeight: 1.6 }}>
                                 A definitive answer requires: {round.uncertainCommitment.resolvingStep}
                               </div>
                             </div>
                           )}

                           {/* Verify status */}
                           {round.verifyStatus !== 'idle' && (
                             <div style={{
                               fontSize: 10, letterSpacing: '0.04em',
                               color: round.verifyStatus === 'clean' || round.verifyStatus === 'fixed'
                                 ? 'rgba(77,220,160,0.8)'
                                 : round.verifyStatus === 'failed'
                                 ? 'rgba(248,124,124,0.8)'
                                 : 'rgba(255,255,255,0.3)',
                               display: 'flex', alignItems: 'center', gap: 6,
                             }}>
                               {round.verifyStatus === 'running' && (
                                 <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'rgba(255,255,255,0.3)', display: 'inline-block', animation: 'pulse 1s infinite' }} />
                               )}
                               {round.verifyMessage}
                             </div>
                           )}

                         </div>
                       </details>
                     </>
                   )
                 })()}
               </div>
             )}
            </div>
          )
        })}
        {/* Bottom spacer — lives INSIDE the scroll so the scroll viewport extends down
            behind the cards/input bar, letting the fade mask land on the card line.
            Height = cards-top distance from bottom + 1, and marginTop:-32 cancels the
            container's 32px flex gap so the most-recent message rests exactly 1px above
            the cards — snug, never obstructed, never floating high. Doubles as scroll anchor. */}
        <div ref={bottomRef} style={{ flexShrink: 0, height: 0 }} />
      </div>


      {/* ── Pipeline Log Overlay ── */}
      {(() => {
        const feed = latestRound?.activityFeed ?? []
        if (feed.length === 0 && !thinking) return null
        const isOpen = feedHovered || thinking
        return (
          <div
            className="crucible-pipeline-log"
            onMouseEnter={() => setFeedHovered(true)}
            onMouseLeave={() => setFeedHovered(false)}
            style={{
              position: 'fixed',
              bottom: 18,
              right: 12,
              zIndex: 20,
              width: isOpen ? 'clamp(64px, calc((100vw - 688px) / 2 - 16px), 280px)' : 64,
              maxWidth: isOpen ? 280 : 64,
              minWidth: 64,
              borderRadius: 14,
              background: isOpen ? 'rgba(10,10,18,0.82)' : 'rgba(10,10,18,0.28)',
              backdropFilter: 'blur(20px)',
              WebkitBackdropFilter: 'blur(20px)',
              border: '1px solid rgba(255,255,255,0.08)',
              overflow: 'hidden',
              transition: 'width 0.6s cubic-bezier(0,0,0.2,1), background 1.8s cubic-bezier(0,0,0.2,1), opacity 2s cubic-bezier(0,0,0.2,1)',
              opacity: isOpen ? 1 : 0.55,
              cursor: 'pointer',
            }}
          >
            {/* Collapsed label — always visible */}
            {!isOpen && (
              <div style={{
                padding: '8px 6px',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <span style={{ fontSize: 8, letterSpacing: '0.12em', color: 'rgba(255,255,255,0.4)', fontWeight: 700 }}>LOG</span>
              </div>
            )}
            {/* Expanded content */}
            {isOpen && (
              <div style={{ display: 'flex', flexDirection: 'column' as const }}>
                <div style={{
                  padding: '5px 10px', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  borderBottom: '1px solid rgba(255,255,255,0.05)',
                }}>
                  <span style={{ fontSize: 8, letterSpacing: '0.12em', color: 'rgba(255,255,255,0.35)', fontWeight: 700 }}>PIPELINE LOG</span>
                  <span style={{ fontSize: 8, color: 'rgba(255,255,255,0.2)' }}>{feed.length}</span>
                </div>
                <div style={{
                  maxHeight: 160, overflowY: 'auto' as const, overflowX: 'hidden' as const,
                  padding: '5px 8px', display: 'flex', flexDirection: 'column' as const, gap: 3,
                }}>
                  {feed.map((entry, i) => {
                    const colors: Record<string,string> = { contract:'#7c7cf8', linter:'#4db89e', rollback:'#f87c7c', stage:'rgba(255,255,255,0.3)' }
                    const color = colors[entry.type] ?? 'rgba(255,255,255,0.3)'
                    const modelShort = entry.modelId ? entry.modelId.split('/').pop()?.split('-').slice(0,2).join('-') : null
                    const label = modelShort ? `${modelShort}: ${entry.message}` : entry.message
                    return (
                      <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 5, minWidth: 0 }}>
                        <span style={{ flexShrink: 0, marginTop: 4, width: 3, height: 3, borderRadius: '50%', background: color }} />
                        <span style={{
                          fontSize: 9, color: 'rgba(255,255,255,0.42)', lineHeight: 1.5,
                          overflowWrap: 'break-word' as const, wordBreak: 'break-word' as const, minWidth: 0,
                        }}>{label}</span>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </div>
        )
      })()}

      {/* ── Progressive blur veil — frosted glass that deepens toward the bottom ──
          Two stacked masked backdrop-blur layers. Each mask fades the blur IN from
          the top, so content scrolling down gets progressively more blurred the lower
          it goes — dissolving into a soft frosted ghost behind the model cards. No
          solid background, so it never reads as a dark bar; the blobs stay visible. */}
      <div style={{
        position: 'fixed', bottom: 0,
        left: remoteBrain && isMobile && isLandscape ? '62%' : 0,
        right: 0,
        height: inputBarHeight - 4, pointerEvents: 'none', zIndex: 8, background: remoteBrain && isMobile ? 'rgba(13,13,21,0.55)' : 'transparent',
        backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)',
        WebkitMaskImage: 'linear-gradient(to bottom, transparent 0px, black 64px)',
        maskImage: 'linear-gradient(to bottom, transparent 0px, black 64px)',
      }} />
      <div style={{
        position: 'fixed', bottom: 0,
        left: remoteBrain && isMobile && isLandscape ? '62%' : 0,
        right: 0,
        height: inputBarHeight - 28, pointerEvents: 'none', zIndex: 9,
        backdropFilter: 'blur(44px)', WebkitBackdropFilter: 'blur(44px)',
        WebkitMaskImage: 'linear-gradient(to bottom, transparent 0px, black 44px)',
        maskImage: 'linear-gradient(to bottom, transparent 0px, black 44px)',
      }} />

      {/* ── Scroll-to-bottom button (visible only when the user scrolled up) ── */}
      {showScrollBtn && rounds.length > 0 && (
        <button
          aria-label="Scroll to bottom"
          onClick={() => { scrollToBottom(); haptic('light') }}
          style={{
            position: 'fixed', left: '50%', transform: 'translateX(-50%)',
            bottom: inputBarHeight + 8, zIndex: 11,
            width: 32, height: 32, borderRadius: '50%',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: 6, cursor: 'pointer', outline: 'none',
            background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.12)',
            backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)',
            color: 'rgba(255,255,255,0.7)',
            boxShadow: '0 4px 16px rgba(0,0,0,0.35)',
            transition: 'opacity 0.2s ease',
          }}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M7 2.5v9M3 7.5l4 4 4-4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
      )}

      {/* ── Input bar ── */}
      <div ref={inputBarRef} className="crucible-inputbar-wrap" style={{
        position: 'fixed', padding: '8px 12px 18px',
        // In portrait Remote Brain, push the bar above the software keyboard using
        // visualViewport. On iOS, position:fixed;bottom:0 lands behind the keyboard —
        // we have to offset by the keyboard height (innerHeight − visualVpHeight).
        bottom: remoteBrain && isMobile && !isLandscape
          ? Math.max(0, window.innerHeight - visualVpOffsetTop - visualVpHeight)
          : 0,
        // In landscape Remote Brain: anchor to the right 38% panel so it sits below chat.
        // In portrait Remote Brain: full width, above the canvas (zIndex 60).
        // Normal: full width, normal stacking.
        left: remoteBrain && isMobile && isLandscape ? '62%' : 0,
        right: 0,
        zIndex: remoteBrain && isMobile ? 60 : 10,
        // Remote Brain portrait: frosted glass so the stream bleeds through.
        background: remoteBrain && isMobile && !isLandscape
          ? 'rgba(13,13,21,0.55)'
          : remoteBrain && isMobile && isLandscape
            ? 'rgba(13,13,21,0.97)'
            : 'transparent',
        backdropFilter: remoteBrain && isMobile && !isLandscape ? 'blur(16px)' : undefined,
        WebkitBackdropFilter: remoteBrain && isMobile && !isLandscape ? 'blur(16px)' : undefined,
        borderTop: remoteBrain && isMobile ? '1px solid rgba(255,255,255,0.07)' : undefined,
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        transition: 'left 0.3s ease, bottom 0.25s ease',
      }}>
        {/* ── Active-model cards — above the chat bar, dynamic width ── */}
        {activeModels.length > 0 && (
          <div className="crucible-model-cards" style={{ display: 'flex', gap: 5, width: '100%', maxWidth: 680, marginBottom: 8, paddingLeft: 14, paddingRight: 10, boxSizing: 'border-box' }}>
            {activeModels.map(model => {
              const isDone       = latestRound ? latestRound.done[model.id] : false

              const isActive     = thinking && !isDone
              const collapsed    = isDone && !thinking  // compact after reply
              const score        = latestRound?.stage2Done ? latestRound.avgScores[model.id] : undefined
              return (
                <div key={model.id} style={{
                  flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' as const,
                  gap: collapsed ? 0 : 4,
                  padding: collapsed ? '4px 7px' : '8px 10px',
                  borderRadius: 10,
                  // Frosted opaque base (dark glass) so scrolling text behind the card can
                  // never bleed through and become unreadable — the model tint rides on top
                  // of a near-solid backdrop, and backdropFilter frosts anything in the gaps.
                  background: `linear-gradient(0deg, rgba(${model.rgb},${isActive ? 0.13 : collapsed ? 0.05 : 0.09}), rgba(${model.rgb},${isActive ? 0.13 : collapsed ? 0.05 : 0.09})), rgba(13,13,21,0.86)`,
                  backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)',
                  border: `1px solid ${isActive ? `rgba(${model.rgb},0.4)` : collapsed ? 'rgba(255,255,255,0.06)' : `rgba(${model.rgb},0.22)`}`,
                  boxShadow: isActive ? `0 0 14px rgba(${model.rgb},0.15)` : '0 2px 12px rgba(0,0,0,0.3)',
                  transition: 'all 0.4s ease',
                  overflow: 'hidden',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
                    <span style={{
                      width: collapsed ? 5 : 6, height: collapsed ? 5 : 6,
                      borderRadius: '50%', flexShrink: 0,
                      background: isActive ? model.color : collapsed ? `rgba(${model.rgb},0.4)` : model.color,
                      boxShadow: isActive ? `0 0 8px ${model.color}` : 'none',
                      animation: isActive ? 'dotpulse 1.2s ease-in-out infinite' : 'none',
                      transition: 'all 0.3s',
                    }} />
                    <span style={{
                      fontSize: collapsed ? 9.5 : 11, fontWeight: 600, letterSpacing: '0.02em',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const, flex: 1,
                      color: collapsed ? 'rgba(255,255,255,0.25)' : isActive ? '#e2e2ea' : model.color,
                      transition: 'all 0.3s',
                    }}>
                      {model.label}
                    </span>
                    {score !== undefined && (
                      <span style={{
                        fontSize: collapsed ? 8.5 : 9.5, fontWeight: 700, flexShrink: 0,
                        color: collapsed ? 'rgba(255,255,255,0.2)' : score >= 0.70 ? '#4db89e' : score >= 0.50 ? '#c084fc' : '#f87171',
                        transition: 'all 0.3s',
                      }}>{(score * 100).toFixed(0)}</span>
                    )}
                  </div>
                  {/* progress sliver — hide when collapsed */}
                  {!collapsed && (
                    <div style={{ height: 2, borderRadius: 2, background: 'rgba(255,255,255,0.05)', overflow: 'hidden', marginTop: 2 }}>
                      <div style={{
                        height: '100%', borderRadius: 2,
                        width: isDone ? '100%' : isActive ? '60%' : '0%',
                        background: model.color, opacity: 0.6,
                        transition: 'width 0.6s ease',
                      }} />
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
        {(() => {
          const accentRgb = mode === 'code' ? '77,184,158' : mode === 'seeker' ? '245,158,11' : '124,124,248'
          return (
        <div className="crucible-inputbox" style={{
          display: 'flex', flexDirection: 'column',
          background: 'rgba(255,255,255,0.05)',
          border: `1px solid rgba(${accentRgb},0.2)`,
          boxShadow: thinking ? `0 0 0 1px rgba(${accentRgb},0.12), 0 8px 32px rgba(0,0,0,0.15)` : '0 2px 16px rgba(0,0,0,0.1)',
          borderRadius: 16, padding: '10px 10px 8px 14px',
          width: '100%', maxWidth: 680,
          backdropFilter: 'blur(24px)', WebkitBackdropFilter: 'blur(24px)',
          position: 'relative',
          transition: 'border-color 0.4s, box-shadow 0.4s',
        }}>
          <div style={{
            position: 'absolute', inset: 0, borderRadius: 16, pointerEvents: 'none',
            background: `radial-gradient(ellipse at 50% 100%, rgba(${accentRgb},0.04) 0%, transparent 70%)`,
            transition: 'background 0.5s',
          }} />
          {showMinLengthTip && (
           <div style={{
             position: 'absolute', bottom: '100%', left: '50%', transform: 'translateX(-50%)',
             marginBottom: 8, padding: '6px 12px', borderRadius: 8,
             background: 'rgba(30,30,40,0.95)', border: '1px solid rgba(255,255,255,0.08)',
             fontSize: 11, color: 'rgba(255,255,255,0.5)', whiteSpace: 'nowrap' as const,
             pointerEvents: 'none' as const, animation: 'fadeIn 0.2s',
           }}>
             Type at least 4 characters to send
           </div>
         )}
          {/* ── Row 1: textarea only ── */}
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
            <textarea
              ref={textareaRef}
              value={input}
              onChange={handleInput}
              onKeyDown={handleKey}
              placeholder={!localStorage.getItem('crucible_has_sent') ? 'Crucible can' : 'Message Crucible'}
              rows={1}
              className="crucible-textarea"
              style={{
                flex: 1, background: 'none', border: 'none', color: '#e2e2e2',
                fontSize: 13, resize: 'none', outline: 'none',
                fontFamily: 'inherit',
                lineHeight: 1.5, maxHeight: 160, overflowY: 'auto',
                userSelect: 'text', paddingBottom: 2,
              }}
            />
          </div>

          {/* ── Row 2: toolbar pills + send button ── */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, paddingTop: 11 }}>
            {/* Mode selector — Studio toggle is nested inside its expansion fan */}
            <ModeSwitcher mode={mode} setMode={setMode} modeMenuOpen={modeMenuOpen} setModeMenuOpen={setModeMenuOpen} />

            {/* Step 9: Remote Brain — phone only */}
            {isMobile && (
              <button
                onClick={() => setRemoteBrain(r => !r)}
                title="Remote Brain — control your Mac from this phone"
                style={{
                  display: 'flex', alignItems: 'center', gap: 4,
                  padding: '4px 9px', borderRadius: 8, border: 'none', cursor: 'pointer',
                  background: remoteBrain ? 'rgba(124,124,248,0.18)' : 'rgba(255,255,255,0.05)',
                  color: remoteBrain ? '#a5a5ff' : 'rgba(255,255,255,0.45)',
                  fontSize: 10, fontWeight: 600, letterSpacing: '0.05em',
                  transition: 'background 0.2s, color 0.2s',
                }}
              >
                <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
                  <rect x="1" y="1" width="9" height="6.5" rx="1.2" stroke="currentColor" strokeWidth="1.2"/>
                  <path d="M3.5 10h4M5.5 7.5V10" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
                </svg>
                Brain
              </button>
            )}

            {/* Send/stop — circular, same height as pills, pushed to right */}
            <div style={{ flex: 1 }} />
            {(() => {
              const accent = MODE_META[mode]?.color ?? '#7c7cf8'
              const accentRgb = mode === 'code' ? '77,184,158' : mode === 'seeker' ? '245,158,11' : '124,124,248'
              const ready = input.trim().length >= 4 || thinking || globalDone
              return (
                <button
                  className="crucible-send-btn"
                  onClick={thinking ? stop : () => send()}
                  disabled={!thinking && input.trim().length < 4}
                  style={{
                    width: 26, height: 26, borderRadius: '50%', border: 'none',
                    background: ready ? `rgba(${accentRgb},0.14)` : 'transparent',
                    cursor: ready ? 'pointer' : 'default',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    flexShrink: 0, padding: 0, position: 'relative', overflow: 'visible',
                    opacity: ready ? 1 : 0.25,
                    transition: 'opacity 0.3s, background 0.3s',
                    outline: `1px solid ${ready ? `rgba(${accentRgb},0.4)` : 'rgba(255,255,255,0.07)'}`,
                    outlineOffset: 0,
                  }}
                >
                  {thinking && (
                    <>
                      <svg width="26" height="26" viewBox="0 0 26 26"
                        style={{ position: 'absolute', animation: 'spin 1.1s linear infinite' }}
                      >
                        <circle cx="13" cy="13" r="11" fill="none"
                          stroke={accent} strokeWidth="1.5"
                          strokeDasharray="22 48" strokeLinecap="round" opacity="0.7"
                        />
                      </svg>
                      <div style={{ width: 7, height: 7, borderRadius: 2, background: accent, opacity: 0.9, flexShrink: 0 }} />
                    </>
                  )}
                  {!thinking && (
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                      <path d="M7 11V3M3.5 6.5L7 3L10.5 6.5" stroke={ready ? accent : '#444'} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  )}
                </button>
              )
            })()}
          </div>
        </div>
          )
        })()}
      </div>
    </div>
  )
}
