// LeftDock — a frosted-glass panel on the left edge, inline with the chat bar.
// Collapsed: a small pill whose opacity rises as the cursor approaches (JS-driven proximity).
// Expanded: two flat tabs — "collab" (refined model/collaboration surface) and
// "code" (a sandboxed editor with a file tree, live run, and preview).
import { useState, useEffect, useRef, useCallback } from 'react'
import { MODEL_REGISTRY } from './modelData'

const API = 'http://localhost:3001'

// ── proximity opacity hook ────────────────────────────────────────────────────
// Returns an opacity that ramps from `min` (far) to `max` (very close) based on the
// cursor's distance to the referenced element. Full intensity only within `near` px.
function useProximityOpacity(ref: React.RefObject<HTMLElement | null>, opts?: { near?: number; far?: number; min?: number; max?: number }) {
  const near = opts?.near ?? 40
  const far = opts?.far ?? 320
  const min = opts?.min ?? 0.18
  const max = opts?.max ?? 0.92
  const [opacity, setOpacity] = useState(min)
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const el = ref.current
      if (!el) return
      const r = el.getBoundingClientRect()
      const cx = Math.max(r.left, Math.min(e.clientX, r.right))
      const cy = Math.max(r.top, Math.min(e.clientY, r.bottom))
      const d = Math.hypot(e.clientX - cx, e.clientY - cy)
      // ease-in so it only "lights up" as you get genuinely close
      const t = 1 - Math.min(1, Math.max(0, (d - near) / (far - near)))
      const eased = t * t
      setOpacity(min + (max - min) * eased)
    }
    window.addEventListener('mousemove', onMove)
    return () => window.removeEventListener('mousemove', onMove)
  }, [ref, near, far, min, max])
  return opacity
}

// ── file tree ─────────────────────────────────────────────────────────────────
interface TreeNode { name: string; path: string; isDir: boolean; children?: TreeNode[] }

function FileTree({ nodes, active, onOpen, depth = 0 }: {
  nodes: TreeNode[]; active: string | null; onOpen: (p: string) => void; depth?: number
}) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  return (
    <>
      {nodes.map(n => (
        <div key={n.path}>
          <div
            onClick={() => n.isDir ? setCollapsed(c => ({ ...c, [n.path]: !c[n.path] })) : onOpen(n.path)}
            style={{
              display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer',
              padding: '2px 6px', paddingLeft: 6 + depth * 12, borderRadius: 4,
              fontSize: 11.5, color: active === n.path ? '#c8c8f8' : '#9a9aad',
              background: active === n.path ? 'rgba(124,124,248,0.12)' : 'transparent',
              fontFamily: 'ui-monospace, monospace', whiteSpace: 'nowrap',
            }}
          >
            <span style={{ fontSize: 9, color: '#555', width: 8 }}>{n.isDir ? (collapsed[n.path] ? '▸' : '▾') : ''}</span>
            <span style={{ fontSize: 11 }}>{n.isDir ? '📁' : '📄'}</span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{n.name}</span>
          </div>
          {n.isDir && !collapsed[n.path] && n.children && (
            <FileTree nodes={n.children} active={active} onOpen={onOpen} depth={depth + 1} />
          )}
        </div>
      ))}
    </>
  )
}

// ── code tab ──────────────────────────────────────────────────────────────────
function CodeTab() {
  const [tree, setTree] = useState<TreeNode[]>([])
  const [activePath, setActivePath] = useState<string | null>(null)
  const [content, setContent] = useState('')
  const [dirty, setDirty] = useState(false)
  const [output, setOutput] = useState('')
  const [running, setRunning] = useState(false)
  const [showPreview, setShowPreview] = useState(false)
  const [editorW, setEditorW] = useState(0.55) // fraction of the right pane for the editor
  // local undo/redo history for the open file (snapshots on save)
  const history = useRef<string[]>([])
  const histIdx = useRef(-1)

  const refreshTree = useCallback(async () => {
    try {
      const r = await fetch(`${API}/api/sandbox/tree`).then(r => r.json())
      setTree(r.tree ?? [])
    } catch { /* backend offline */ }
  }, [])
  useEffect(() => { refreshTree() }, [refreshTree])

  const open = async (p: string) => {
    const r = await fetch(`${API}/api/sandbox/read`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: p }),
    }).then(r => r.json())
    if (r.success) {
      setActivePath(p); setContent(r.content); setDirty(false)
      history.current = [r.content]; histIdx.current = 0
    }
  }

  const save = async () => {
    if (!activePath) return
    await fetch(`${API}/api/sandbox/write`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: activePath, content }),
    })
    setDirty(false)
    // push a history snapshot (drop any redo tail)
    history.current = history.current.slice(0, histIdx.current + 1)
    history.current.push(content); histIdx.current = history.current.length - 1
    refreshTree()
  }

  const undo = () => { if (histIdx.current > 0) { histIdx.current--; setContent(history.current[histIdx.current]); setDirty(true) } }
  const redo = () => { if (histIdx.current < history.current.length - 1) { histIdx.current++; setContent(history.current[histIdx.current]); setDirty(true) } }

  const newFile = async () => {
    const name = prompt('New file (relative to sandbox):')
    if (!name) return
    await fetch(`${API}/api/sandbox/write`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: name, content: '' }),
    })
    await refreshTree(); open(name)
  }

  const run = async () => {
    if (!activePath) return
    setRunning(true); setOutput('running…')
    if (dirty) await save()
    const isPy = activePath.endsWith('.py')
    const isJs = activePath.endsWith('.js') || activePath.endsWith('.mjs')
    const cmd = isPy ? `python3 "${activePath}"` : isJs ? `node "${activePath}"` : `sh "${activePath}"`
    try {
      const r = await fetch(`${API}/api/sandbox/run`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command: cmd }),
      }).then(r => r.json())
      setOutput((r.output || '(no output)') + `\n\n— exit ${r.code} · ${r.ms}ms${r.timedOut ? ' · TIMED OUT' : ''}`)
    } catch (e: any) { setOutput('error: ' + e.message) }
    setRunning(false)
  }

  const isHtml = activePath?.endsWith('.html')
  const lines = content.split('\n')

  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 0 }}>
      {/* file tree */}
      <div style={{ width: 190, flexShrink: 0, borderRight: '1px solid rgba(255,255,255,0.07)', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 10px' }}>
          <span style={{ fontSize: 9, letterSpacing: '0.12em', color: '#666', fontWeight: 700 }}>SANDBOX</span>
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={newFile} title="new file" style={iconBtn}>＋</button>
            <button onClick={refreshTree} title="refresh" style={iconBtn}>↻</button>
          </div>
        </div>
        <div style={{ flex: 1, overflow: 'auto', padding: '0 4px 8px' }}>
          {tree.length === 0
            ? <div style={{ padding: 10, fontSize: 10.5, color: '#555', lineHeight: 1.6 }}>Empty sandbox. Click ＋ or ask the agent to build something.</div>
            : <FileTree nodes={tree} active={activePath} onOpen={open} />}
        </div>
      </div>

      {/* editor + output/preview */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 }}>
        {/* toolbar */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
          <span style={{ fontSize: 11, color: '#bbb', fontFamily: 'ui-monospace, monospace', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {activePath ?? 'no file open'}{dirty ? ' •' : ''}
          </span>
          <button onClick={undo} disabled={histIdx.current <= 0} style={textBtn}>↶ undo</button>
          <button onClick={redo} disabled={histIdx.current >= history.current.length - 1} style={textBtn}>↷ redo</button>
          <button onClick={save} disabled={!activePath || !dirty} style={textBtn}>save</button>
          {isHtml && <button onClick={() => setShowPreview(p => !p)} style={{ ...textBtn, color: showPreview ? '#7c7cf8' : '#888' }}>preview</button>}
          <button onClick={run} disabled={!activePath || running} style={{ ...textBtn, color: '#4ade80', borderColor: 'rgba(74,222,128,0.3)' }}>▸ run</button>
        </div>

        {/* split: editor | (output or preview) */}
        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          {/* editor */}
          <div style={{ width: `${editorW * 100}%`, display: 'flex', minHeight: 0, position: 'relative', background: 'rgba(0,0,0,0.25)' }}>
            <div aria-hidden style={{
              padding: '8px 4px 8px 8px', textAlign: 'right', userSelect: 'none',
              fontFamily: 'ui-monospace, monospace', fontSize: 12, lineHeight: '1.5em', color: '#3a3a48', overflow: 'hidden',
            }}>
              {lines.map((_, i) => <div key={i}>{i + 1}</div>)}
            </div>
            <textarea
              value={content}
              spellCheck={false}
              onChange={e => { setContent(e.target.value); setDirty(true) }}
              onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); save() } }}
              placeholder={activePath ? '' : 'Open a file from the sandbox to edit.'}
              style={{
                flex: 1, resize: 'none', border: 'none', outline: 'none', background: 'transparent',
                color: '#dcdce8', fontFamily: 'ui-monospace, monospace', fontSize: 12, lineHeight: '1.5em',
                padding: '8px 10px', whiteSpace: 'pre', overflowWrap: 'normal', userSelect: 'text',
              }}
            />
          </div>

          {/* drag divider (JS-driven resize) */}
          <div
            onMouseDown={e => {
              e.preventDefault()
              const parent = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect()
              const move = (ev: MouseEvent) => {
                const frac = (ev.clientX - parent.left) / parent.width
                setEditorW(Math.max(0.2, Math.min(0.8, frac)))
              }
              const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up) }
              window.addEventListener('mousemove', move); window.addEventListener('mouseup', up)
            }}
            style={{ width: 5, cursor: 'col-resize', background: 'rgba(255,255,255,0.06)', flexShrink: 0 }}
          />

          {/* output / preview */}
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <div style={{ fontSize: 9, letterSpacing: '0.12em', color: '#666', fontWeight: 700, padding: '6px 10px', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
              {showPreview && isHtml ? 'PREVIEW' : 'OUTPUT'}
            </div>
            {showPreview && isHtml ? (
              <iframe title="preview" sandbox="allow-scripts" srcDoc={content} style={{ flex: 1, border: 'none', background: '#fff' }} />
            ) : (
              <pre style={{
                flex: 1, margin: 0, padding: 10, overflow: 'auto', background: 'rgba(0,0,0,0.4)',
                fontFamily: 'ui-monospace, monospace', fontSize: 11, lineHeight: 1.5, color: '#9fef9f', whiteSpace: 'pre-wrap',
              }}>{output || (running ? 'running…' : '— run a file to see output —')}</pre>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ── collab tab ────────────────────────────────────────────────────────────────
function CollabTab() {
  const provColor: Record<string, string> = {
    groq: '#f59e0b', mistral: '#ff7000', openrouter: '#7c7cf8', gemini: '#4db89e', huggingface: '#facc15', cloudflare: '#f6821f',
  }
  return (
    <div style={{ padding: '16px 20px', overflow: 'auto', height: '100%' }}>
      <div style={{ fontSize: 11, color: '#888', lineHeight: 1.6, marginBottom: 16, maxWidth: 560 }}>
        Crucible runs an adversarial ensemble: many models answer in parallel, a scoring engine
        ranks them, they critique and revise, and the best is synthesized. Below is the full roster.
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: 8 }}>
        {MODEL_REGISTRY.map(m => {
          const c = provColor[m.provider] ?? '#888'
          return (
            <div key={m.id} style={{
              border: `1px solid ${c}33`, background: `${c}0d`, borderRadius: 10, padding: '10px 12px',
              display: 'flex', flexDirection: 'column', gap: 4,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: c, flexShrink: 0 }} />
                <span style={{ fontSize: 12.5, fontWeight: 600, color: '#e2e2ea' }}>{m.label}</span>
              </div>
              <div style={{ fontSize: 9.5, color: '#777', letterSpacing: '0.04em' }}>
                {m.provider} · {m.params ?? '?'}B · {m.speed ?? 'standard'}
              </div>
              {m.fit?.coding != null && (
                <div style={{ display: 'flex', gap: 2, marginTop: 2 }}>
                  {Array.from({ length: 10 }, (_, i) => (
                    <span key={i} style={{ flex: 1, height: 3, borderRadius: 1, background: i < (m.fit!.coding) ? c : 'rgba(255,255,255,0.07)' }} />
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── shared button styles ──────────────────────────────────────────────────────
const iconBtn: React.CSSProperties = {
  background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)', color: '#999',
  borderRadius: 5, width: 20, height: 20, cursor: 'pointer', fontSize: 12, lineHeight: 1, padding: 0,
}
const textBtn: React.CSSProperties = {
  background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)', color: '#aaa',
  borderRadius: 6, padding: '3px 9px', cursor: 'pointer', fontSize: 10.5, fontWeight: 600, letterSpacing: '0.03em',
}

// ── the dock ──────────────────────────────────────────────────────────────────
export default function LeftDock() {
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<'collab' | 'code'>('code')
  const pillRef = useRef<HTMLDivElement | null>(null)
  const opacity = useProximityOpacity(pillRef)

  return (
    <>
      {/* collapsed frosted pill — inline with the chat bar (bottom-left).
          Proximity drives a prismatic glow that only ignites as the cursor nears. */}
      {!open && (
        <div
          ref={pillRef}
          onClick={() => setOpen(true)}
          style={{
            position: 'fixed', left: 16, bottom: 22, zIndex: 30, cursor: 'pointer',
            padding: '9px 16px 9px 11px', borderRadius: 14,
            background: `rgba(16,16,26,${0.3 + opacity * 0.45})`,
            backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)',
            border: `1px solid rgba(140,140,248,${0.06 + opacity * 0.4})`,
            boxShadow: `0 6px 26px rgba(0,0,0,0.35), 0 0 ${opacity * 28}px rgba(124,124,248,${opacity * 0.55})`,
            opacity: 0.4 + opacity * 0.6,
            transition: 'opacity 0.3s, background 0.3s, border 0.3s, box-shadow 0.3s',
            display: 'flex', alignItems: 'center', gap: 9,
          }}
        >
          {/* prismatic orb that brightens with proximity */}
          <span style={{
            width: 16, height: 16, borderRadius: 5, flexShrink: 0,
            background: 'linear-gradient(135deg, #7c7cf8, #4db89e, #c084fc, #f59e0b)',
            backgroundSize: '200% 200%',
            filter: `saturate(${0.4 + opacity * 1.1}) brightness(${0.7 + opacity * 0.6})`,
            boxShadow: `0 0 ${opacity * 14}px rgba(124,124,248,${opacity * 0.8})`,
            animation: opacity > 0.5 ? 'prism 2.4s linear infinite' : 'none',
            transition: 'filter 0.3s, box-shadow 0.3s',
          }} />
          <span style={{
            fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase' as const,
            color: `rgba(225,225,245,${0.5 + opacity * 0.5})`, transition: 'color 0.3s',
          }}>
            Code
          </span>
        </div>
      )}

      {/* expanded panel */}
      {open && (
        <div style={{
          position: 'fixed', left: 14, bottom: 22, top: 64, zIndex: 30,
          width: 'min(62vw, 860px)',
          display: 'flex', flexDirection: 'column',
          borderRadius: 16, overflow: 'hidden',
          background: 'rgba(14,14,22,0.92)', backdropFilter: 'blur(26px)', WebkitBackdropFilter: 'blur(26px)',
          border: '1px solid rgba(255,255,255,0.1)', boxShadow: '0 20px 70px rgba(0,0,0,0.6)',
          animation: 'panelUp 0.32s cubic-bezier(0.34,1.2,0.64,1)',
        }}>
          {/* tab header */}
          <div style={{ display: 'flex', alignItems: 'center', borderBottom: '1px solid rgba(255,255,255,0.08)', paddingRight: 8 }}>
            {(['code', 'collab'] as const).map(t => (
              <button key={t} onClick={() => setTab(t)} style={{
                background: 'none', border: 'none', cursor: 'pointer',
                padding: '13px 20px', fontSize: 12, fontWeight: 600, letterSpacing: '0.03em',
                color: tab === t ? '#e8e8f4' : '#666',
                borderBottom: `2px solid ${tab === t ? '#7c7cf8' : 'transparent'}`,
                textTransform: 'lowercase',
              }}>{t}</button>
            ))}
            <div style={{ flex: 1 }} />
            <button onClick={() => setOpen(false)} style={{ ...iconBtn, width: 24, height: 24 }} title="collapse">×</button>
          </div>
          {/* tab body */}
          <div style={{ flex: 1, minHeight: 0 }}>
            {tab === 'code' ? <CodeTab /> : <CollabTab />}
          </div>
        </div>
      )}
    </>
  )
}
