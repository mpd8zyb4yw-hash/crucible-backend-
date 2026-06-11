import { useState, useRef, useEffect } from 'react'
import CrucibleMark from './CrucibleMark'
import { MODEL_REGISTRY } from './modelData'
import LeftDock from './LeftDock'
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

function ModeSwitcher({ mode, setMode, modeMenuOpen, setModeMenuOpen }: {
  mode: Mode
  setMode: (m: Mode) => void
  modeMenuOpen: boolean
  setModeMenuOpen: (o: boolean) => void
}) {
  const active = MODES.find(m => m.id === mode)!
  const others = MODES.filter(m => m.id !== mode)

  return (
    <div style={{ position: 'relative', flexShrink: 0 }}>
      {/* Chip */}
      <div
        onPointerDown={e => { e.stopPropagation(); setModeMenuOpen(!modeMenuOpen) }}
        style={{
          display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer',
          padding: '4px 8px', borderRadius: 6,
          background: modeMenuOpen ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.04)',
          border: `1px solid ${active.color}33`,
          userSelect: 'none',
        }}
      >
        <span style={{
          fontSize: 10, fontWeight: 700, letterSpacing: '0.1em',
          color: active.color, fontFamily: 'monospace',
        }}>{active.label}</span>
        <span style={{
          fontSize: 8, color: active.color, opacity: 0.7,
          transform: modeMenuOpen ? 'rotate(180deg)' : 'none',
          transition: 'transform 0.15s', display: 'inline-block',
        }}>▴</span>
      </div>

      {/* Fan */}
      {modeMenuOpen && (
        <div style={{
          position: 'absolute', bottom: '110%', left: 0,
          display: 'flex', flexDirection: 'column', gap: 4,
          zIndex: 300,
        }}>
          {others.map((m, i) => (
            <div
              key={m.id}
              onPointerDown={e => { e.stopPropagation(); setMode(m.id); setModeMenuOpen(false) }}
              style={{
                padding: '5px 10px', borderRadius: 8, cursor: 'pointer',
                background: 'rgba(255,255,255,0.06)',
                border: `1px solid ${m.color}22`,
                fontSize: 10, fontWeight: 700, letterSpacing: '0.1em',
                color: m.color, fontFamily: 'monospace',
                marginLeft: i * 4,
                opacity: 0, animation: `fanIn 0.15s ease forwards`,
                animationDelay: `${i * 0.05}s`,
              }}
            >{m.label}</div>
          ))}
        </div>
      )}
    </div>
  )
}


// ── Rotating verb placeholder ─────────────────────────────────────────────────
const VERBS = ['code', 'reason', 'analyze', 'refactor', 'research', 'problem-solve', 'synthesize', 'learn', 'test']

function RotatingVerb() {
  const [index, setIndex] = useState(0)
  const [visible, setVisible] = useState(true)

  useEffect(() => {
    const interval = setInterval(() => {
      setVisible(false)
      setTimeout(() => {
        setIndex(i => (i + 1) % VERBS.length)
        setVisible(true)
      }, 300)
    }, 2200)
    return () => clearInterval(interval)
  }, [])

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <span style={{ color: 'rgba(255,255,255,0.25)' }}>Crucible can </span>
      <span style={{
        color: 'rgba(124,124,248,0.6)',
        display: 'inline-block',
        transition: 'opacity 0.3s, transform 0.3s',
        opacity: visible ? 1 : 0,
        transform: visible ? 'translateY(0)' : 'translateY(-6px)',
        fontStyle: 'italic',
      }}>{VERBS[index]}</span>
    </span>
  )
}

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
      document.body.appendChild(ta)
      ta.select()
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

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const copy = (e: React.MouseEvent) => {
    e.stopPropagation()
    copyText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  return (
    <button onClick={copy} style={{
      position: 'absolute', top: 10, right: 10,
      background: copied ? 'rgba(77,184,158,0.2)' : 'rgba(255,255,255,0.06)',
      border: `1px solid ${copied ? 'rgba(77,184,158,0.4)' : 'rgba(255,255,255,0.1)'}`,
      borderRadius: 6, padding: '4px 9px', cursor: 'pointer',
      fontSize: 10, fontWeight: 600, letterSpacing: '0.06em',
      color: copied ? '#4db89e' : '#555', transition: 'all 0.2s',
    }}>
      {copied ? 'copied' : 'copy'}
    </button>
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
  synthesisDone: boolean
  verifyStatus: 'idle' | 'running' | 'clean' | 'fixed' | 'needs_model' | 'failed'
  verifyMessage: string
  remediated: Record<string, boolean>
  linterStatus: Record<string, { status: string; score?: number }>
  avgScores: Record<string, number>
  stage2Done: boolean
  activityFeed: Array<{ ts: number; type: string; modelId?: string; message: string }>
  cached: boolean
  agent?: AgentState | null
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
  'agent_start', 'plan', 'step_status', 'tool_call', 'tool_result',
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
    synthesis: '', synthesisDone: false,
    verifyStatus: 'idle' as const, verifyMessage: '',
    remediated: {}, linterStatus: {},
    avgScores: {}, stage2Done: false,
    activityFeed: [],
    agent: null,
  }
}

// ── Rounded-rect perimeter point (for prismatic ring animation) ───────────────
function rrPoint(W: number, H: number, R: number, t: number): [number, number] {
  R = Math.min(R, W / 2, H / 2)
  const sw = W - 2 * R, sh = H - 2 * R
  const ca = (Math.PI / 2) * R
  const segs: Array<
    | { kind: 'line'; len: number; x0: number; y0: number; dx: number; dy: number }
    | { kind: 'arc';  len: number; cx: number; cy: number; a0: number; a1: number }
  > = [
    { kind: 'arc',  len: ca, cx: R,     cy: R,     a0: Math.PI,       a1: Math.PI * 1.5 },
    { kind: 'line', len: sw, x0: R,     y0: 0,     dx: 1,  dy: 0 },
    { kind: 'arc',  len: ca, cx: W - R, cy: R,     a0: Math.PI * 1.5, a1: Math.PI * 2   },
    { kind: 'line', len: sh, x0: W,     y0: R,     dx: 0,  dy: 1 },
    { kind: 'arc',  len: ca, cx: W - R, cy: H - R, a0: 0,             a1: Math.PI * 0.5 },
    { kind: 'line', len: sw, x0: W - R, y0: H,     dx: -1, dy: 0 },
    { kind: 'arc',  len: ca, cx: R,     cy: H - R, a0: Math.PI * 0.5, a1: Math.PI       },
    { kind: 'line', len: sh, x0: 0,     y0: H - R, dx: 0,  dy: -1 },
  ]
  const total = 2 * sw + 2 * sh + 4 * ca
  let d = (((t % 1) + 1) % 1) * total
  for (const s of segs) {
    if (d <= s.len + 1e-9) {
      const f = s.len > 0 ? Math.min(d / s.len, 1) : 0
      if (s.kind === 'arc') {
        const angle = s.a0 + (s.a1 - s.a0) * f
        return [s.cx + R * Math.cos(angle), s.cy + R * Math.sin(angle)]
      } else {
        return [s.x0 + s.dx * f * s.len, s.y0 + s.dy * f * s.len]
      }
    }
    d -= s.len
  }
  return [R, 0]
}

function PrismaticRing({ thinking, done }: { thinking: boolean; done: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const stateRef  = useRef({ thinking, done })
  stateRef.current = { thinking, done }

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')!
    let animId: number, t = 0, completionT = 0
    const dpr = window.devicePixelRatio || 1
    const resize = () => {
      canvas.width  = canvas.offsetWidth  * dpr
      canvas.height = canvas.offsetHeight * dpr
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    const drawRRect = (w: number, h: number, r: number) => {
      ctx.beginPath()
      ctx.moveTo(r, 0); ctx.lineTo(w - r, 0); ctx.arcTo(w, 0, w, r, r)
      ctx.lineTo(w, h - r); ctx.arcTo(w, h, w - r, h, r)
      ctx.lineTo(r, h); ctx.arcTo(0, h, 0, h - r, r)
      ctx.lineTo(0, r); ctx.arcTo(0, 0, r, 0, r)
      ctx.closePath()
    }
    const draw = () => {
      const { thinking, done } = stateRef.current
      const w = canvas.offsetWidth, h = canvas.offsetHeight
      ctx.clearRect(0, 0, w, h)
      const R = 14
      if (thinking) {
        t = (t + 0.004) % 1; completionT = 0
        ctx.save(); drawRRect(w, h, R)
        ctx.strokeStyle = 'rgba(255,255,255,0.08)'; ctx.lineWidth = 1; ctx.stroke(); ctx.restore()
        const trail = 0.22, steps = 120
        for (let i = 0; i < steps; i++) {
          const frac = i / steps
          const pos = ((t - trail * (1 - frac)) % 1 + 1) % 1
          const [px, py] = rrPoint(w, h, R, pos)
          const hue = ((t * 720) + frac * 180) % 360
          ctx.beginPath(); ctx.arc(px, py, 1.2 + frac * 1.8, 0, Math.PI * 2)
          ctx.fillStyle = `hsla(${hue},100%,75%,${0.1 + frac * 0.45})`; ctx.fill()
        }
        const [lx, ly] = rrPoint(w, h, R, t)
        const hue = (t * 720) % 360
        ctx.beginPath(); ctx.arc(lx, ly, 2, 0, Math.PI * 2)
        ctx.fillStyle = `hsla(${hue},100%,85%,0.75)`; ctx.fill()
        const lg = ctx.createRadialGradient(lx, ly, 0, lx, ly, 7)
        lg.addColorStop(0, `hsla(${hue},100%,80%,0.2)`); lg.addColorStop(1, `hsla(${hue},100%,60%,0)`)
        ctx.beginPath(); ctx.arc(lx, ly, 7, 0, Math.PI * 2); ctx.fillStyle = lg; ctx.fill()
      } else if (done) {
        completionT = Math.min(completionT + 0.02, 1)
        ctx.save(); drawRRect(w, h, R)
        const grad = ctx.createLinearGradient(0, 0, w, 0)
        grad.addColorStop(0,    `hsla(260,80%,70%,${completionT * 0.7})`)
        grad.addColorStop(0.33, `hsla(180,80%,65%,${completionT * 0.7})`)
        grad.addColorStop(0.66, `hsla(300,80%,70%,${completionT * 0.7})`)
        grad.addColorStop(1,    `hsla(260,80%,70%,${completionT * 0.7})`)
        ctx.strokeStyle = grad; ctx.lineWidth = 1.5; ctx.stroke(); ctx.restore()
      } else {
        ctx.save(); drawRRect(w, h, R)
        ctx.strokeStyle = 'rgba(255,255,255,0.06)'; ctx.lineWidth = 1; ctx.stroke(); ctx.restore()
      }
      animId = requestAnimationFrame(draw)
    }
    resize(); window.addEventListener('resize', resize); draw()
    return () => { cancelAnimationFrame(animId); window.removeEventListener('resize', resize) }
  }, [])

  return (
    <canvas ref={canvasRef} style={{
      position: 'absolute', inset: 0, width: '100%', height: '100%',
      pointerEvents: 'none', borderRadius: 14,
    }} />
  )
}

function ShimmerBg({ thinking }: { thinking: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const ref = useRef(thinking); ref.current = thinking
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')!
    let animId: number, t = 0
    const resize = () => { canvas.width = window.innerWidth; canvas.height = window.innerHeight }
    resize(); window.addEventListener('resize', resize)
    const draw = () => {
      t += 0.003; ctx.clearRect(0, 0, canvas.width, canvas.height)
      const blobs = [
        { x: 0.15, y: 0.35, r: 0.30, h: 255 + Math.sin(t) * 20 },
        { x: 0.85, y: 0.55, r: 0.25, h: 195 + Math.cos(t * 1.3) * 15 },
        { x: 0.50, y: 0.80, r: 0.22, h: 300 + Math.sin(t * 0.8) * 25 },
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

function TerminalDrawer({ history }: { history: Array<{ cmd: string; out: string }> }) {
  const bottomRef = useRef<HTMLDivElement>(null)
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [history])
  return (
    <div style={{
      margin: '0 20px', borderRadius: '12px 12px 0 0',
      background: '#1c1c1e', border: '1px solid rgba(124,124,248,0.2)',
      borderBottom: 'none', animation: 'slideUp 0.25s cubic-bezier(0.4,0,0.2,1)',
      display: 'flex', flexDirection: 'column',
    }}>
      <div style={{
        padding: '6px 14px', display: 'flex', alignItems: 'center',
        justifyContent: 'space-between', borderBottom: '1px solid rgba(255,255,255,0.05)', flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {['#ff5f56','#ffbd2e','#27c93f'].map(c => (
            <span key={c} style={{ width: 8, height: 8, borderRadius: '50%', background: c, display: 'inline-block' }} />
          ))}
        </div>
        <span style={{ fontSize: 10, color: '#444', fontFamily: 'monospace', letterSpacing: '0.08em' }}>crucible — zsh</span>
        <span style={{ fontSize: 10, color: '#333', fontFamily: 'monospace' }}>~/Desktop/crucible</span>
      </div>
      <div style={{
        height: 260, overflowY: 'auto', padding: '10px 14px',
        fontFamily: '"SF Mono","Fira Code",monospace', fontSize: 12, lineHeight: 1.6,
        color: '#c8c8d0', boxSizing: 'border-box', textAlign: 'left', userSelect: 'text',
      }}>
        {history.length === 0 ? (
          <div style={{ color: '#333' }}>
            <span style={{ color: '#7c7cf8' }}>crucible</span>
            <span style={{ color: '#555' }}> ~ % </span>
            <span style={{ color: '#444', fontStyle: 'italic' }}>ready</span>
          </div>
        ) : history.map((h, i) => {
          const age = history.length - 1 - i
          const opacity = age === 0 ? 1 : age === 1 ? 0.5 : Math.max(0.15, 0.5 - age * 0.08)
          return (
            <div key={i} style={{ marginBottom: 6, opacity, transition: 'opacity 0.3s' }}>
              <div>
                <span style={{ color: age === 0 ? '#7c7cf8' : '#444' }}>crucible</span>
                <span style={{ color: '#555' }}> ~ % </span>
                <span style={{ color: age === 0 ? '#e2e2e2' : '#888' }}>{h.cmd}</span>
              </div>
              {h.out && (
                <div style={{ color: '#9a9aac', whiteSpace: 'pre-wrap', wordBreak: 'break-word', marginTop: 1 }}>
                  {h.out.trimEnd()}
                </div>
              )}
            </div>
          )
        })}
        <div ref={bottomRef} />
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
    <div style={{ animation: 'panelUp 0.3s cubic-bezier(0.34,1.2,0.64,1)' }}>
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
                width: 72, flexShrink: 0, textAlign: 'right', paddingRight: 6,
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
            marginTop: 8, borderRadius: 10, padding: '12px 14px',
            background: `linear-gradient(135deg, rgba(${criticModel.rgb},0.05) 0%, rgba(10,10,14,0.75) 100%)`,
            backdropFilter: 'blur(24px)', WebkitBackdropFilter: 'blur(24px)',
            border: `1px solid rgba(${criticModel.rgb},0.15)`,
            boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.04)',
            animation: 'panelUp 0.18s cubic-bezier(0.34,1.2,0.64,1)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 8 }}>
              <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', color: `rgba(${criticModel.rgb},0.6)`, textTransform: 'uppercase' as const }}>{criticModel.label}</span>
              <span style={{ fontSize: 9, color: '#2a2a3a' }}>critiques</span>
              <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', color: `rgba(${targetModel.rgb},0.6)`, textTransform: 'uppercase' as const }}>{targetModel.label}</span>
            </div>
            <div style={{ fontSize: 12.5, lineHeight: 1.7, color: '#b0b0c4', whiteSpace: 'pre-wrap', maxHeight: '28vh', overflowY: 'auto' }}>
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
  write_file: '✎', edit_file: '✎', apply_patch: '✎', read_file: '📖',
  list_dir: '📁', search: '🔍', run: '▸', ensemble_solve: '✦',
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

function AgentPanel({ agent }: { agent: AgentState }) {
  const verifyByLatest = agent.verifies[agent.verifies.length - 1]
  return (
    <div style={{
      animation: 'panelUp 0.3s cubic-bezier(0.34,1.2,0.64,1)',
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
            {agent.tools.map((t, i) => <ToolRow key={`${t.id}:${i}`} t={t} />)}
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
            <pre style={{
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

      {agent.error && <div style={{ fontSize: 11, color: '#fca5a5' }}>⚠ {agent.error}</div>}
    </div>
  )
}

export default function App() {
  const [rounds, setRounds]               = useState<Round[]>([])
  const [input, setInput]                 = useState('')
  const [menuOpen, setMenuOpen]           = useState(false)
  const [thinking, setThinking]           = useState(false)
  const [mode, setMode] = useState<'quorum'|'code'|'seeker'>('quorum')
  const [modeMenuOpen, setModeMenuOpen] = useState(false)
  const [showMinLengthTip, setShowMinLengthTip] = useState(false)
  const minLengthTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [feedHovered, setFeedHovered] = useState(false)
  const [indexStats, setIndexStats] = useState<{ indexed: boolean; fileCount?: number; rootPath?: string } | null>(null)
  const [indexing, setIndexing] = useState(false)
  const bottomRef  = useRef<HTMLDivElement>(null)
  const scrollRef  = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const isNearBottom = useRef(true)
  const synthesisRef = useRef<Record<string, string>>({})
  const abortRef = useRef<AbortController | null>(null)
  const prewarmTokenRef = useRef<string | null>(null)
  const prewarmDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const handleScroll = () => {
    const el = scrollRef.current
    if (!el) return
    isNearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120
  }

  useEffect(() => {
    if (!isNearBottom.current) return
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [rounds])

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
  const send = async () => {
    if (thinking) return
    if (!input.trim() || input.trim().length < 4) return
    const roundId = Date.now().toString()
    const userMessage = input.trim()
    localStorage.setItem('crucible_has_sent', '1')
    setInput(''); setThinking(true)
    prewarmTokenRef.current = null
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
    setRounds(prev => [...prev, emptyRound(roundId, userMessage)])

    abortRef.current = new AbortController()
    let res: Response
    try {
      res = await fetch('http://localhost:3001/api/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: userMessage, mode, prewarmToken: prewarmTokenRef.current }),
        signal: abortRef.current.signal,
      })
    } catch (err: any) {
      if (err.name === 'AbortError') { setThinking(false); return }
      console.error('[send] fetch failed:', err)
      setThinking(false); return
    }
    const reader = res.body!.getReader()
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
          if (parsed.type === 'model_selection') {
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

          // ── Synthesis ──────────────────────────────────────────────────────
          if (parsed.type === 'synthesis') {
            const { text, done: synthDone } = parsed
            if (text) synthesisRef.current[roundId] = (synthesisRef.current[roundId] ?? '') + text
            setRounds(prev => prev.map(r => {
              if (r.id !== roundId) return r
              return {
                ...r,
                synthesis: r.synthesis + (text || ''),
                synthesisDone: synthDone ?? r.synthesisDone,
              }
            }))
            continue
          }

        } catch (e) { console.error('parse error', e) }
      }
    }
    setThinking(false)
  }

  const runVerify = async (roundId: string, code: string, originalPrompt: string) => {
    setRounds(prev => prev.map(r => r.id === roundId ? { ...r, verifyStatus: 'running', verifyMessage: 'Running verification...' } : r))
    let res: Response
    try {
      res = await fetch('http://localhost:3001/api/verify', {
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
          } else if (parsed.type === 'verify_fixed') {
            setRounds(prev => prev.map(r => r.id === roundId ? { ...r, verifyStatus: 'fixed', verifyMessage: '✓ Fixed and verified', synthesis: parsed.code ?? r.synthesis } : r))
          } else if (parsed.type === 'verify_needs_model') {
            setRounds(prev => prev.map(r => r.id === roundId ? { ...r, verifyStatus: 'needs_model', verifyMessage: 'Applying surgical fix...' } : r))
            // Re-trigger stream with surgical prompt — handled below
            await streamSurgicalFix(roundId, parsed.surgicalPrompt)
          } else if (parsed.type === 'verify_failed') {
            setRounds(prev => prev.map(r => r.id === roundId ? { ...r, verifyStatus: 'failed', verifyMessage: '⚠ Verification failed' } : r))
          }
        } catch (e) { console.error('verify parse error', e) }
      }
    }
  }

  const streamSurgicalFix = async (roundId: string, surgicalPrompt: string) => {
    const res = await fetch('http://localhost:3001/api/chat', {
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
  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value
    setInput(val)
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
        fetch('http://localhost:3001/api/prewarm', {
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

 const toggleModel = (roundId: string, modelId: string) => {
    setRounds(prev => prev.map(r => r.id !== roundId ? r : {
      ...r, expandedModel: r.expandedModel === modelId ? null : modelId,
    }))
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

  return (
    <div style={{
      height: '100vh', width: '100vw', background: '#16161e',
      display: 'flex', flexDirection: 'column',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      color: '#e2e2e2', position: 'relative', overflow: 'hidden', userSelect: 'none',
    }}>
      <style>{`
        @keyframes slideUp  { from { opacity:0; transform:translateY(10px) } to { opacity:1; transform:translateY(0) } }
        @keyframes panelUp  { from { opacity:0; transform:translateY(12px) } to { opacity:1; transform:translateY(0) } }
        @keyframes dotpulse { 0%,100% { opacity:1; transform:scale(1) } 50% { opacity:0.3; transform:scale(0.5) } }
        @keyframes fadeIn   { from { opacity:0 } to { opacity:1 } }
        pre { max-width: 100% !important; overflow-x: auto !important; white-space: pre !important; box-sizing: border-box !important; }
        pre code { display: block !important; background: transparent !important; padding: 0 !important; font-size: 12px !important; line-height: 1.5 !important; white-space: pre !important; overflow-x: auto !important; }
        .react-syntax-highlighter-line-number { display: none; }
        * { box-sizing: border-box; }
        @keyframes prism { 0% { filter: hue-rotate(0deg) brightness(1.3) saturate(1.8); } 100% { filter: hue-rotate(360deg) brightness(1.3) saturate(1.8); } }
        @keyframes arrowToRing { 0% { transform: rotate(0deg) scale(1); opacity: 1; } 60% { transform: rotate(140deg) scale(0.5); opacity: 0.5; } 100% { transform: rotate(180deg) scale(1); opacity: 1; } }
      `}</style>

      <ShimmerBg thinking={thinking} />
      <LeftDock />

      {/* ── Top bar ── */}
      <div style={{
        height: 48, display: 'flex', alignItems: 'center', padding: '0 16px 0 80px',
        borderBottom: '1px solid rgba(255,255,255,0.055)',
        background: 'rgba(9,9,11,0.88)', flexShrink: 0,
        justifyContent: 'space-between', zIndex: 10, position: 'relative',
        backdropFilter: 'blur(16px)', WebkitAppRegion: 'drag',
      } as any}>
        <span style={{
          fontSize: 13, fontWeight: 600, letterSpacing: '-0.01em', color: '#e8e8e8',
          position: 'absolute', left: '50%', transform: 'translateX(-50%)',
          WebkitAppRegion: 'no-drag',
        } as any}>Crucible</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 'auto', position: 'relative', WebkitAppRegion: 'no-drag' } as any}>
          {thinking && latestRound && (() => {
            const r = latestRound
            const stage =
              !r.stage2Done && !r.stage3Started ? { label: 'scoring',      n: 2 } :
              r.stage2Done  && !r.stage3Done    ? { label: 'debating',     n: 3 } :
              r.stage3Done  && !r.stage4Done    ? { label: 'revising',     n: 4 } :
              r.stage4Done  && !r.synthesisDone ? { label: 'synthesizing', n: 5 } :
                                                  { label: 'thinking',     n: 1 }
            return (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, animation: 'fadeIn 0.3s' }}>
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
              </div>
            )
          })()}
          {/* Prompt type badge */}
          {latestRound?.cached && (
            <span style={{
              fontSize: 9, fontWeight: 700, letterSpacing: '0.1em',
              color: '#2a7a4a', textTransform: 'uppercase' as const,
              background: 'rgba(40,180,100,0.08)', padding: '3px 7px',
              borderRadius: 5, border: '1px solid rgba(40,180,100,0.2)',
            }}>⚡ cached</span>
          )}
          {latestRound?.promptType && (
            <span style={{
              fontSize: 9, fontWeight: 700, letterSpacing: '0.1em',
              color: '#3a3a5a', textTransform: 'uppercase' as const,
              background: 'rgba(124,124,248,0.06)', padding: '3px 7px',
              borderRadius: 5, border: '1px solid rgba(124,124,248,0.1)',
            }}>{latestRound.promptType}</span>
          )}
          <button onClick={() => setMenuOpen(o => !o)} style={{
            background: 'none', border: 'none', cursor: 'pointer',
            color: '#555', padding: '6px 8px', borderRadius: 8,
            display: 'flex', flexDirection: 'column', gap: 3.5,
          }}>
            {[0,1,2].map(i => (
              <span key={i} style={{ display: 'block', width: 16, height: 1.5, background: menuOpen ? '#fff' : '#555', borderRadius: 2, transition: 'background 0.2s' }} />
            ))}
          </button>
          {menuOpen && (
            <div style={{
              position: 'absolute', top: '100%', right: 0, zIndex: 100,
              background: '#111114', border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: 10, padding: '6px 0', minWidth: 160, boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
            }}>
              {[
                { label: 'API Keys',        action: () => alert('API Keys — coming soon') },
                { label: 'Pipeline Config', action: () => alert('Pipeline Config — coming soon') },
                { label: 'Model Roster',    action: () => alert('Model Roster — coming soon') },
                { label: 'About',           action: () => alert('Crucible v0.1') },
              ].map(item => (
                <button key={item.label} onClick={() => { item.action(); setMenuOpen(false) }} style={{
                  display: 'block', width: '100%', padding: '8px 14px',
                  background: 'none', border: 'none', cursor: 'pointer',
                  color: '#888', fontSize: 12.5, textAlign: 'left' as const,
                }}
                onMouseEnter={e => (e.currentTarget.style.color = '#fff')}
                onMouseLeave={e => (e.currentTarget.style.color = '#888')}
                >{item.label}</button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── Message history ── */}
      <div ref={scrollRef} onScroll={handleScroll} style={{
        flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column',
        alignItems: 'center', padding: '28px 24px 100px', gap: 32, zIndex: 1,
      }}>
        {rounds.length === 0 && (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.18)', letterSpacing: '0.06em', fontWeight: 500 }}>Dynamic models. One answer.</span>
          </div>
        )}

        {rounds.map(round => {
          const models = round.models
          return (
            <div key={round.id} style={{
              width: '100%', maxWidth: 680, display: 'flex', flexDirection: 'column', gap: 12,
            }}>

              {/* User bubble */}
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <div
                  onClick={() => models.length > 0 && setRounds(prev => prev.map(r =>
                    r.id === round.id ? { ...r, expandedModel: r.expandedModel ? null : models[0].id } : r
                  ))}
                  style={{
                    maxWidth: '62%', padding: '9px 14px', borderRadius: 14,
                    fontSize: 13, lineHeight: 1.58, cursor: models.length > 0 ? 'pointer' : 'default',
                    borderBottom: models.length > 0 ? '1px solid rgba(255,255,255,0.12)' : undefined,
                    background: round.expandedModel ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.055)',
                    border: `1px solid ${round.expandedModel ? 'rgba(255,255,255,0.14)' : 'rgba(255,255,255,0.09)'}`,
                    color: '#ccc', transition: 'background 0.2s, border-color 0.2s',
                    userSelect: 'none' as const, textAlign: 'left' as const,
                  }}>
                  {round.userMessage}
                </div>
              </div>

              {/* Agent loop panel (Section 7) */}
              {round.agent && <AgentPanel agent={round.agent} />}

              {/* Expanded response panel */}
              {round.expandedModel && models.length > 0 && (() => {
                const m = models.find(m => m.id === round.expandedModel)
                if (!m) return null
                return (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, animation: 'panelUp 0.25s cubic-bezier(0.34,1.2,0.64,1)' }}>
                    {/* Model tabs */}
                    <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end', flexWrap: 'wrap' as const }}>
                      {models.map(model => {
                        const isDone = round.done[model.id]
                        const isSelected = round.expandedModel === model.id
                        return (
                          <button key={model.id} onClick={() => toggleModel(round.id, model.id)} style={{
                            display: 'flex', alignItems: 'center', gap: 5,
                            padding: '5px 12px', borderRadius: 8,
                            border: `1px solid ${isSelected ? `rgba(${model.rgb},0.4)` : isDone ? `rgba(${model.rgb},0.15)` : 'rgba(255,255,255,0.06)'}`,
                            background: isSelected ? `rgba(${model.rgb},0.12)` : 'rgba(255,255,255,0.02)',
                            cursor: 'pointer', outline: 'none', transition: 'all 0.2s',
                            color: isSelected ? model.color : isDone ? `rgba(${model.rgb},0.6)` : '#333',
                          }}>
                            <span style={{
                              width: 5, height: 5, borderRadius: '50%',
                              background: isDone ? model.color : '#252530',
                              boxShadow: !isDone ? `0 0 6px ${model.color}` : 'none',
                              animation: !isDone ? 'dotpulse 1.2s ease-in-out infinite' : 'none',
                              flexShrink: 0,
                            }} />
                            <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.04em', whiteSpace: 'nowrap' as const }}>
                              {model.label}
                              {model.isWildcard && <span style={{ fontSize: 8, color: '#555', marginLeft: 3 }}>✦</span>}
                            </span>
                            {round.stage2Done && round.avgScores[model.id] !== undefined && (
                              <span style={{
                                fontSize: 9, fontWeight: 700,
                                color: round.avgScores[model.id] >= 0.70 ? '#4db89e' : round.avgScores[model.id] >= 0.50 ? '#c084fc' : '#f87171',
                              }}>
                                {(round.avgScores[model.id] * 100).toFixed(0) + '%'}
                              </span>
                            )}
                          </button>
                        )
                      })}
                    </div>
                    {/* Response content */}
                    <div style={{
                      position: 'relative', borderRadius: 14, padding: '14px 16px',
                      background: `linear-gradient(145deg, rgba(${m.rgb},0.07) 0%, rgba(10,10,14,0.6) 100%)`,
                      backdropFilter: 'blur(28px) saturate(1.6)', WebkitBackdropFilter: 'blur(28px) saturate(1.6)',
                      border: `1px solid rgba(${m.rgb},0.2)`,
                      boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.06), 0 4px 24px rgba(0,0,0,0.4)',
                    }}>
                      <div style={{
                        position: 'absolute', top: 0, left: '8%', right: '8%', height: 1,
                        background: `linear-gradient(90deg, transparent, rgba(${m.rgb},0.5), transparent)`,
                      }} />
                      <div style={{ fontSize: 13, lineHeight: 1.75, color: '#c8c8d8', maxHeight: '40vh', overflowY: 'auto' }}>
                        {round.responses[m.id] || <span style={{ color: '#333' }}>···</span>}
                      </div>
                      {round.done[m.id] && round.responses[m.id] && <CopyButton text={round.responses[m.id]} />}
                    </div>
                  </div>
                )
              })()}

              {/* Critique grid */}
              {round.stage3Started && models.length > 0 && round.complexity === 'complex' && (
                <CritiqueGrid round={round} onToggle={(critic, target) => toggleCritique(round.id, critic, target)} />
              )}


              {/* Post-critique pipeline progress */}
              {round.stage3Done && round.complexity === 'complex' && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 4px', animation: 'fadeIn 0.4s' }}>
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
                          fontSize: 8, letterSpacing: '0.08em', textTransform: 'uppercase' as const,
                          color: step.done ? 'rgba(124,124,248,0.5)' : '#222', transition: 'color 0.3s',
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
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
                    <div style={{ display: 'flex', gap: 3 }}>
                      {models.map(m => (
                        <span key={m.id} style={{ width: 5, height: 5, borderRadius: '50%', background: m.color, opacity: 0.8 }} />
                      ))}
                    </div>
                    <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', color: 'rgba(255,255,255,0.25)', textTransform: 'uppercase' as const }}>
                      {round.synthesisDone ? 'consensus' : 'synthesizing…'}
                    </span>
                    {round.synthesisDone && round.synthesisModelId && (
                      <span style={{ fontSize: 9, color: '#2a2a3a', marginLeft: 4 }}>
                        via {models.find(m => m.id === round.synthesisModelId)?.label ?? ''}
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 13.5, lineHeight: 1.75, color: '#d8d8e8', maxWidth: '100%', overflow: 'hidden' }}>
                   <ReactMarkdown
                     components={{
                       code({ node, className, children, ...props }: any) {
                         const match = /language-(\w+)/.exec(className || '')
                         const isBlock = !props.inline && match
                         const code = String(children).replace(/\n$/, '')
                         if (isBlock) {
                           return (
                             <div style={{ position: 'relative', margin: '12px 0', borderRadius: 10, overflow: 'hidden', maxWidth: '100%', boxSizing: 'border-box' as const }}>
                               <div style={{
                                 display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                                 padding: '6px 12px', background: 'rgba(0,0,0,0.4)',
                                 borderBottom: '1px solid rgba(255,255,255,0.06)',
                               }}>
                                 <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.3)', letterSpacing: '0.08em' }}>{match[1].toUpperCase()}</span>
                                 <CopyButton text={code} />
                               </div>
                               <SyntaxHighlighter
                                 style={oneDark}
                                 language={match[1]}
                                 PreTag="div"
                                 customStyle={{ margin: 0, borderRadius: 0, fontSize: 12, background: 'rgba(0,0,0,0.3)', overflowX: 'auto', maxWidth: '100%', whiteSpace: 'pre', wordBreak: 'normal', overflowWrap: 'normal' }}
                               >{code}</SyntaxHighlighter>
                             </div>
                           )
                         }
                         return <code style={{ background: 'rgba(255,255,255,0.08)', padding: '1px 5px', borderRadius: 4, fontSize: 12 }} {...props}>{children}</code>
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
                 </div>
                  {round.synthesisDone && <CopyButton text={round.synthesis} />}
                  {round.verifyStatus !== 'idle' && (
                    <div style={{
                      marginTop: 8, fontSize: 11, letterSpacing: '0.04em',
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
                 {round.synthesisDone && (() => {
                   const active = round.models.filter(m => !round.activityFeed.some(e => e.type === 'rollback' && e.modelId === m.id))
                   const dropped = round.models.filter(m => round.activityFeed.some(e => e.type === 'rollback' && e.modelId === m.id))
                   const synthesizer = round.models.find(m => m.id === round.synthesisModelId)
                   const topScore = Math.max(...active.map(m => round.avgScores[m.id] ?? 0))
                   return (
                     <details style={{ marginTop: 14 }}>
                       <summary style={{
                         fontSize: 10, letterSpacing: '0.08em', color: 'rgba(255,255,255,0.25)',
                         cursor: 'pointer', userSelect: 'none' as const, listStyle: 'none',
                         display: 'flex', alignItems: 'center', gap: 6,
                       }}>
                         <span style={{ fontFamily: 'monospace' }}>▸</span> HOW WE GOT HERE
                       </summary>
                       <div style={{
                         marginTop: 10, padding: '12px 14px', borderRadius: 8,
                         background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)',
                         fontSize: 11, color: 'rgba(255,255,255,0.4)', lineHeight: 1.7,
                         display: 'flex', flexDirection: 'column' as const, gap: 8,
                       }}>
                         <div>
                           <span style={{ color: 'rgba(255,255,255,0.6)', fontWeight: 600 }}>Query type</span>
                           {' — '}{round.promptType}
                         </div>
                         <div>
                           <span style={{ color: 'rgba(255,255,255,0.6)', fontWeight: 600 }}>Models used</span>
                           {' — '}{active.map(m => `${m.label} (${((round.avgScores[m.id] ?? 0) * 100).toFixed(0)}%)`).join(', ')}
                         </div>
                         {dropped.length > 0 && (
                           <div>
                             <span style={{ color: '#f87c7c', fontWeight: 600 }}>Dropped</span>
                             {' — '}{dropped.map(m => m.label).join(', ')} (rate limit or error)
                           </div>
                         )}
                         <div>
                           <span style={{ color: 'rgba(255,255,255,0.6)', fontWeight: 600 }}>Synthesized by</span>
                           {' — '}{synthesizer?.label ?? 'unknown'}, highest scorer at {(topScore * 100).toFixed(0)}%
                         </div>
                         <div>
                           <span style={{ color: 'rgba(255,255,255,0.6)', fontWeight: 600 }}>Process</span>
                           {' — '}Models responded independently, critiqued each other, then self-revised before the top scorer synthesized a final answer.
                         </div>
                       </div>
                     </details>
                   )
                 })()}
               </div>
             )}
            </div>
          )
        })}
        <div ref={bottomRef} />
      </div>


      {/* ── Pipeline Log Overlay ── */}
      {(() => {
        const feed = latestRound?.activityFeed ?? []
        if (feed.length === 0 && !thinking) return null
        const isOpen = feedHovered || thinking
        return (
          <div
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

      {/* ── Input bar ── */}
      <div style={{ position: 'fixed', bottom: 0, left: 0, right: 0, padding: '8px 12px 18px', zIndex: 10, display: 'flex', flexDirection: 'column', alignItems: 'center', background: 'rgba(22,22,30,0.7)' }}>
        {/* ── Active-model cards — above the chat bar, dynamic width ── */}
        {activeModels.length > 0 && (
          <div style={{ display: 'flex', gap: 6, width: '100%', maxWidth: 680, marginBottom: 8 }}>
            {activeModels.map(model => {
              const isDone       = latestRound ? latestRound.done[model.id] : false
              const pipelineDone = latestRound ? latestRound.synthesisDone : false
              const isActive     = thinking && !pipelineDone
              const score        = latestRound?.stage2Done ? latestRound.avgScores[model.id] : undefined
              const many         = activeModels.length >= 4
              return (
                <div key={model.id} style={{
                  flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' as const, gap: 5,
                  padding: many ? '8px 8px' : '10px 12px', borderRadius: 12,
                  background: isActive ? `rgba(${model.rgb},0.10)` : isDone ? `rgba(${model.rgb},0.07)` : 'rgba(255,255,255,0.03)',
                  border: `1px solid ${isActive ? `rgba(${model.rgb},0.45)` : isDone ? `rgba(${model.rgb},0.22)` : 'rgba(255,255,255,0.06)'}`,
                  boxShadow: isActive ? `0 0 18px rgba(${model.rgb},0.18)` : 'none',
                  backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)',
                  transition: 'all 0.35s ease',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
                    <span style={{
                      width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
                      background: isDone || isActive ? model.color : '#2a2a38',
                      boxShadow: isActive ? `0 0 10px ${model.color}, 0 0 18px rgba(${model.rgb},0.5)` : isDone ? `0 0 6px rgba(${model.rgb},0.5)` : 'none',
                      animation: isActive ? 'dotpulse 1.2s ease-in-out infinite' : 'none',
                      transition: 'all 0.3s',
                    }} />
                    <span style={{
                      fontSize: many ? 10.5 : 12, fontWeight: 600, letterSpacing: '0.02em',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const, flex: 1,
                      color: isDone ? model.color : isActive ? '#e2e2ea' : '#5a5a6e', transition: 'color 0.3s',
                    }}>
                      {model.label}{model.isWildcard && <span style={{ fontSize: 8, opacity: 0.5, marginLeft: 3 }}>✦</span>}
                    </span>
                    {score !== undefined && (
                      <span style={{
                        fontSize: 10, fontWeight: 700, flexShrink: 0,
                        color: score >= 0.70 ? '#4db89e' : score >= 0.50 ? '#c084fc' : '#f87171',
                      }}>{(score * 100).toFixed(0)}%</span>
                    )}
                  </div>
                  {/* status sliver */}
                  <div style={{ height: 3, borderRadius: 2, background: 'rgba(255,255,255,0.05)', overflow: 'hidden' }}>
                    <div style={{
                      height: '100%', borderRadius: 2,
                      width: isDone ? '100%' : isActive ? '60%' : '0%',
                      background: model.color, opacity: isDone ? 0.8 : 0.5,
                      transition: 'width 0.6s ease', animation: isActive ? 'fadeIn 0.8s ease-in-out infinite alternate' : 'none',
                    }} />
                  </div>
                </div>
              )
            })}
          </div>
        )}
        <div style={{
          display: 'flex', gap: 8, alignItems: 'flex-end',
          background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.09)',
          borderRadius: 14, padding: '8px 8px 8px 14px',
          width: '100%', maxWidth: 680,
          backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)',
        }}>
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
         <textarea
           ref={textareaRef}
            value={input}
            onChange={handleInput}
            onKeyDown={handleKey}
            placeholder={!localStorage.getItem('crucible_has_sent') ? 'Crucible can...' : 'Message Crucible...'}
            rows={1}
            style={{
              flex: 1, background: 'none', border: 'none', color: '#e2e2e2',
              fontSize: 13, resize: 'none', outline: 'none',
              fontFamily: 'inherit',
              lineHeight: 1.5, maxHeight: 160, overflowY: 'auto',
              userSelect: 'none',
            }}
          />
          <button
            onClick={thinking ? stop : send}
            disabled={!thinking && input.trim().length < 4}
            style={{
              width: 28, height: 28, borderRadius: '50%', border: 'none',
              background: '#000',
              cursor: thinking || input.trim().length >= 4 ? 'pointer' : 'default',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              flexShrink: 0, padding: 0, position: 'relative', overflow: 'hidden',
              opacity: input.trim().length >= 4 || thinking || globalDone ? 1 : 0.4,
              transition: 'opacity 0.3s',
            }}
          >
            {/* Thinking state: prismatic ring = colored square + black inner square */}
            {thinking && (
              <>
                {/* Outer prismatic rounded square */}
                <div style={{
                  position: 'absolute',
                  width: 12, height: 12,
                  borderRadius: 4,
                  background: 'linear-gradient(135deg, #7c7cf8, #4db89e, #c084fc, #f59e0b, #7c7cf8)',
                  backgroundSize: '300% 300%',
                  animation: 'prism 1.4s linear infinite, arrowToRing 0.5s cubic-bezier(0.4,0,0.2,1) forwards',
                }} />
                {/* Inner black square cutout — creates ring effect (thinner wall) */}
                <div style={{
                  position: 'absolute',
                  width: 9, height: 9,
                  borderRadius: 2.5,
                  background: '#000',
                  zIndex: 1,
                }} />
              </>
            )}
            {/* Arrow — only shown when not thinking */}
            {!thinking && (
              <span style={{
                fontSize: 16, fontWeight: 700, lineHeight: 1, marginTop: -1,
                color: '#fff',
              }}>↑</span>
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
