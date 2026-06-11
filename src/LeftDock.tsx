// Code Studio — the slide-in "code" mode. Collab (the main chat UI) is the default;
// clicking the Code pill slides this in from the left, "collab →" slides it back out right.
//
// Vision: prompt-to-preview canvas. The live preview is the hero. One warm prompt:
// "Describe what you want to make…". The Crucible ensemble generates a complete standalone
// HTML document, which renders live in an iframe. Refine by describing changes. A tucked-away
// "peek at code" reveals the source. Zero jargon — grandma can vibe-code here.
import { useState, useEffect, useRef } from 'react'

const API = 'http://localhost:3001'

// ── proximity glow for the collapsed pill ─────────────────────────────────────
function useProximityOpacity(ref: React.RefObject<HTMLElement | null>, opts?: { near?: number; far?: number }) {
  const near = opts?.near ?? 40
  const far = opts?.far ?? 340
  const [opacity, setOpacity] = useState(0)
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const el = ref.current
      if (!el) return
      const r = el.getBoundingClientRect()
      const cx = Math.max(r.left, Math.min(e.clientX, r.right))
      const cy = Math.max(r.top, Math.min(e.clientY, r.bottom))
      const d = Math.hypot(e.clientX - cx, e.clientY - cy)
      const t = 1 - Math.min(1, Math.max(0, (d - near) / (far - near)))
      setOpacity(t * t) // ease-in: ignites only when close
    }
    window.addEventListener('mousemove', onMove)
    return () => window.removeEventListener('mousemove', onMove)
  }, [ref, near, far])
  return opacity
}

// Pull a complete HTML document out of a model answer (fenced ```html, raw <!DOCTYPE,
// or — as a fallback — wrap a bare snippet so something always renders).
function extractHtml(text: string): string {
  const fenced = text.match(/```(?:html)?\s*\n([\s\S]*?)```/i)
  const body = fenced ? fenced[1] : text
  const doc = body.match(/<!DOCTYPE[\s\S]*<\/html>/i) || body.match(/<html[\s\S]*<\/html>/i)
  if (doc) return doc[0]
  if (/<\/\w+>/.test(body)) return `<!DOCTYPE html><html><body style="margin:0">${body}</body></html>`
  return body.trim()
}

// Read an /api/chat SSE stream, advancing a progress callback on stage events and
// resolving with the final synthesis text.
async function runEnsemble(message: string, onStage: () => void, signal: AbortSignal): Promise<string> {
  const res = await fetch(`${API}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, agentMode: false }), signal,
  })
  const reader = res.body!.getReader()
  const dec = new TextDecoder()
  let buf = '', synthesis = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    const chunks = buf.split('\n\n'); buf = chunks.pop() ?? ''
    for (const c of chunks) {
      const line = c.split('\n').find(l => l.startsWith('data: '))
      if (!line) continue
      try {
        const ev = JSON.parse(line.slice(6))
        if (ev.type === 'stage') onStage()
        if (ev.type === 'synthesis') synthesis = ev.text || ev.content || synthesis
      } catch { /* partial */ }
    }
  }
  return synthesis
}

// ── the studio ────────────────────────────────────────────────────────────────
function CodeStudio({ onClose }: { onClose: () => void }) {
  const [prompt, setPrompt] = useState('')
  const [building, setBuilding] = useState(false)
  const [progress, setProgress] = useState(0)
  const [html, setHtml] = useState<string>('')
  const [showCode, setShowCode] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ac = useRef<AbortController | null>(null)

  const build = async () => {
    const desc = prompt.trim()
    if (!desc || building) return
    setBuilding(true); setProgress(0.05); setError(null)
    ac.current = new AbortController()
    // Shape the request so the ensemble returns ONE renderable HTML document.
    const message = html
      ? `Here is the current web app:\n\`\`\`html\n${html}\n\`\`\`\nModify it to: ${desc}\n` +
        `Return ONLY the complete updated standalone HTML document (inline CSS/JS), nothing else.`
      : `Create a complete, standalone HTML document (inline <style> and <script>, no external files) that does this: ${desc}\n` +
        `Make it look polished. Return ONLY the HTML document, nothing else.`
    try {
      const out = await runEnsemble(message, () => setProgress(p => Math.min(0.9, p + 0.12)), ac.current.signal)
      const doc = extractHtml(out)
      if (!doc) throw new Error('no renderable output')
      setHtml(doc); setProgress(1)
      // persist into the sandbox so it survives + powers "peek at code"
      fetch(`${API}/api/sandbox/write`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: 'studio/index.html', content: doc }),
      }).catch(() => {})
      setPrompt('')
    } catch (e: any) {
      if (e.name !== 'AbortError') setError(e.message || 'build failed')
    }
    setBuilding(false)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 20px', flexShrink: 0 }}>
        <span style={{
          width: 14, height: 14, borderRadius: 4,
          background: 'linear-gradient(135deg, #7c7cf8, #4db89e, #c084fc, #f59e0b)',
          backgroundSize: '200% 200%', animation: 'prism 3s linear infinite',
        }} />
        <span style={{ fontSize: 14, fontWeight: 600, letterSpacing: '-0.01em', color: '#eaeaf4' }}>Crucible Code</span>
        <div style={{ flex: 1 }} />
        <button onClick={onClose} style={{
          background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', color: '#bbb',
          borderRadius: 9, padding: '6px 14px', cursor: 'pointer', fontSize: 12, fontWeight: 600,
        }}>collab →</button>
      </div>

      {/* hero preview */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 32px' }}>
        <div style={{
          width: '100%', maxWidth: 880, height: '100%', maxHeight: 560,
          borderRadius: 20, overflow: 'hidden', position: 'relative',
          background: html ? '#fff' : 'rgba(255,255,255,0.02)',
          border: '1px solid rgba(255,255,255,0.09)',
          boxShadow: '0 24px 80px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.05)',
        }}>
          {html ? (
            <iframe title="preview" sandbox="allow-scripts" srcDoc={html} style={{ width: '100%', height: '100%', border: 'none' }} />
          ) : (
            <div style={{
              position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
              alignItems: 'center', justifyContent: 'center', gap: 12, color: '#55556a', textAlign: 'center', padding: 24,
            }}>
              <div style={{ fontSize: 38, opacity: 0.5 }}>✦</div>
              <div style={{ fontSize: 15, color: '#8a8a9e', fontWeight: 500 }}>Describe anything and watch it come to life.</div>
              <div style={{ fontSize: 12.5, color: '#55556a', maxWidth: 360, lineHeight: 1.6 }}>
                Try "a red bouncing ball", "a calculator", or "a starry night sky".
              </div>
            </div>
          )}
          {showCode && html && (
            <pre style={{
              position: 'absolute', inset: 0, margin: 0, padding: 16, overflow: 'auto',
              background: 'rgba(8,8,14,0.97)', color: '#cdd0e0', fontFamily: 'ui-monospace, monospace',
              fontSize: 11.5, lineHeight: 1.55, whiteSpace: 'pre-wrap',
            }}>{html}</pre>
          )}
        </div>
      </div>

      {/* building bar */}
      <div style={{ height: 30, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 32px', flexShrink: 0 }}>
        {building ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, width: '100%', maxWidth: 880 }}>
            <span style={{ fontSize: 12, color: '#a8a8c4', whiteSpace: 'nowrap' }}>✨ building…</span>
            <div style={{ flex: 1, height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
              <div style={{
                height: '100%', width: `${progress * 100}%`, borderRadius: 2,
                background: 'linear-gradient(90deg, #7c7cf8, #4db89e, #c084fc)', transition: 'width 0.5s ease',
              }} />
            </div>
            <button onClick={() => ac.current?.abort()} style={{ background: 'none', border: 'none', color: '#888', cursor: 'pointer', fontSize: 11 }}>stop</button>
          </div>
        ) : error ? (
          <span style={{ fontSize: 12, color: '#fca5a5' }}>⚠ {error}</span>
        ) : html ? (
          <button onClick={() => setShowCode(s => !s)} style={{
            background: 'none', border: 'none', cursor: 'pointer', fontSize: 11.5, letterSpacing: '0.04em',
            color: showCode ? '#7c7cf8' : '#666',
          }}>〔 {showCode ? 'hide code' : 'peek at code'} 〕</button>
        ) : null}
      </div>

      {/* describe bar */}
      <div style={{ padding: '12px 32px 28px', flexShrink: 0, display: 'flex', justifyContent: 'center' }}>
        <div style={{
          display: 'flex', alignItems: 'flex-end', gap: 8, width: '100%', maxWidth: 880,
          background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(124,124,248,0.2)',
          borderRadius: 16, padding: '10px 10px 10px 18px',
          boxShadow: '0 8px 30px rgba(0,0,0,0.3)',
        }}>
          <textarea
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); build() } }}
            placeholder={html ? 'Describe a change… (e.g. "make it blue")' : 'Describe what you want to make…'}
            rows={1}
            style={{
              flex: 1, resize: 'none', border: 'none', outline: 'none', background: 'transparent',
              color: '#e8e8f0', fontSize: 14, lineHeight: 1.5, fontFamily: 'inherit', maxHeight: 120,
            }}
          />
          <button onClick={build} disabled={building || !prompt.trim()} style={{
            width: 36, height: 36, borderRadius: '50%', border: 'none', flexShrink: 0,
            background: prompt.trim() && !building ? 'linear-gradient(135deg, #7c7cf8, #4db89e)' : '#26263200',
            cursor: prompt.trim() && !building ? 'pointer' : 'default',
            color: '#fff', fontSize: 17, display: 'flex', alignItems: 'center', justifyContent: 'center',
            opacity: prompt.trim() && !building ? 1 : 0.4, transition: 'opacity 0.3s',
          }}>▸</button>
        </div>
      </div>
    </div>
  )
}

// ── the dock (pill + slide-in studio) ─────────────────────────────────────────
export default function LeftDock() {
  const [open, setOpen] = useState(false)
  const [closing, setClosing] = useState(false)
  const pillRef = useRef<HTMLDivElement | null>(null)
  const opacity = useProximityOpacity(pillRef)

  // collab → : slide the studio out to the right, then unmount
  const close = () => { setClosing(true); setTimeout(() => { setOpen(false); setClosing(false) }, 360) }

  return (
    <>
      {!open && (
        <div
          ref={pillRef}
          onClick={() => setOpen(true)}
          style={{
            position: 'fixed', left: 16, bottom: 22, zIndex: 40, cursor: 'pointer',
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
          }}>Code</span>
        </div>
      )}

      {open && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 40,
          background: 'rgba(13,13,20,0.96)', backdropFilter: 'blur(30px)', WebkitBackdropFilter: 'blur(30px)',
          transform: closing ? 'translateX(100%)' : 'translateX(0)',
          animation: closing ? 'none' : 'studioIn 0.42s cubic-bezier(0.16,1,0.3,1)',
          transition: 'transform 0.36s cubic-bezier(0.5,0,0.75,0)',
        }}>
          <CodeStudio onClose={close} />
        </div>
      )}
    </>
  )
}
