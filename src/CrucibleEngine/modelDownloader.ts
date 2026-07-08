// Persistent, resumable model download manager.
//
// The problem this solves: a download whose progress lives in client (app) state resets
// to 0 whenever the app closes or the connection drops. This mirrors the app's existing
// principle — server-owned work survives client disconnect (see the chat task registry) —
// and applies it to downloads:
//
//   • Bytes stream to `<dest>.part`; the file on disk IS the progress.
//   • A sidecar `<dest>.part.json` records url/total/etag so a resume can validate it.
//   • Resuming issues an HTTP `Range: bytes=<already-have>-` request and appends.
//   • Progress is read from disk, so closing/reopening the app re-attaches to live state
//     instead of restarting. A dropped connection is retried with backoff, resuming from
//     the current byte offset — never from 0.
//
// Injectable fetch keeps it unit-testable against a local server with zero network.

import fs from 'fs'
import path from 'path'
import crypto from 'crypto'

export type FetchLike = (url: string, init?: any) => Promise<{
  ok: boolean; status: number; headers: { get(name: string): string | null }; body: any
}>

export type DownloadStatus = 'downloading' | 'paused' | 'complete' | 'error'

export interface DownloadState {
  id: string
  url: string
  dest: string           // final path; bytes land in `${dest}.part` until complete
  total: number | null   // content length incl. already-downloaded, null if unknown
  downloaded: number     // bytes on disk
  status: DownloadStatus
  etag: string | null
  error: string | null
  updatedAt: number
}

interface Sidecar { url: string; total: number | null; etag: string | null }

// In-process handles for active transfers (cancellation + de-dup). Progress itself is
// always sourced from disk so it is correct even across a process restart.
const active = new Map<string, { controller: AbortController; state: DownloadState }>()

function partPath(dest: string) { return `${dest}.part` }
function sidecarPath(dest: string) { return `${dest}.part.json` }

function readSidecar(dest: string): Sidecar | null {
  try { return JSON.parse(fs.readFileSync(sidecarPath(dest), 'utf-8')) } catch { return null }
}
function writeSidecar(dest: string, s: Sidecar): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.writeFileSync(sidecarPath(dest), JSON.stringify(s), 'utf-8')
}
function partSize(dest: string): number {
  try { return fs.statSync(partPath(dest)).size } catch { return 0 }
}

export function downloadIdFor(url: string, dest: string): string {
  return crypto.createHash('sha256').update(`${url}\n${dest}`).digest('hex').slice(0, 16)
}

/** Progress read straight from disk — correct even if no transfer is running in this
 *  process (e.g. right after a restart, before resume kicks in). */
export function getProgress(url: string, dest: string): DownloadState | null {
  const id = downloadIdFor(url, dest)
  const live = active.get(id)
  if (live) return { ...live.state, downloaded: partSize(dest) }
  const side = readSidecar(dest)
  const done = fs.existsSync(dest)
  const onDisk = partSize(dest)
  if (!side && !done && onDisk === 0) return null
  return {
    id, url, dest,
    total: done ? (fs.statSync(dest).size) : (side?.total ?? null),
    downloaded: done ? fs.statSync(dest).size : onDisk,
    status: done ? 'complete' : 'paused',
    etag: side?.etag ?? null,
    error: null,
    updatedAt: Date.now(),
  }
}

export function listDownloads(baseDir: string): DownloadState[] {
  const dir = path.join(baseDir, '.crucible', 'downloads')
  const out: DownloadState[] = []
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'))
        const p = getProgress(meta.url, meta.dest)
        if (p) out.push(p)
      } catch { /* skip */ }
    }
  } catch { /* no downloads dir */ }
  return out.sort((a, b) => b.updatedAt - a.updatedAt)
}

function recordMeta(baseDir: string, id: string, url: string, dest: string): void {
  const dir = path.join(baseDir, '.crucible', 'downloads')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ id, url, dest }), 'utf-8')
}

export interface StartOptions {
  baseDir: string
  fetchFn?: FetchLike
  maxRetries?: number
  retryDelayMs?: number
  onProgress?: (s: DownloadState) => void
}

/** Start OR resume a download. Idempotent per (url, dest): calling it while a transfer
 *  is already running returns the live state instead of starting a second one. Resolves
 *  when the transfer finishes, errors, or is cancelled. Safe to await or fire-and-poll. */
export async function startDownload(url: string, dest: string, opts: StartOptions): Promise<DownloadState> {
  const fetchFn = (opts.fetchFn ?? (globalThis.fetch as unknown as FetchLike))
  const id = downloadIdFor(url, dest)
  if (active.has(id)) return active.get(id)!.state
  if (fs.existsSync(dest)) {
    return { id, url, dest, total: fs.statSync(dest).size, downloaded: fs.statSync(dest).size, status: 'complete', etag: null, error: null, updatedAt: Date.now() }
  }

  recordMeta(opts.baseDir, id, url, dest)
  fs.mkdirSync(path.dirname(dest), { recursive: true })

  const state: DownloadState = {
    id, url, dest, total: readSidecar(dest)?.total ?? null,
    downloaded: partSize(dest), status: 'downloading', etag: readSidecar(dest)?.etag ?? null,
    error: null, updatedAt: Date.now(),
  }
  const controller = new AbortController()
  active.set(id, { controller, state })

  const maxRetries = opts.maxRetries ?? 5
  const baseDelay = opts.retryDelayMs ?? 500
  const emit = () => { state.updatedAt = Date.now(); state.downloaded = partSize(dest); opts.onProgress?.({ ...state }) }

  try {
    for (let attempt = 0; ; attempt++) {
      const have = partSize(dest)
      state.downloaded = have
      try {
        const headers: Record<string, string> = {}
        if (have > 0) headers['Range'] = `bytes=${have}-`   // ← resume, never from 0
        const res = await fetchFn(url, { headers, signal: controller.signal })
        if (!res.ok && res.status !== 206 && res.status !== 200) throw new Error(`HTTP ${res.status}`)

        // A server that ignores Range (200 instead of 206) restarts the stream: truncate.
        const append = res.status === 206 && have > 0
        if (!append && have > 0) { try { fs.truncateSync(partPath(dest)) } catch {} }

        const etag = res.headers.get('etag')
        const clen = res.headers.get('content-length')
        const rangeTotal = res.headers.get('content-range')?.match(/\/(\d+)\s*$/)?.[1]
        const total = rangeTotal ? Number(rangeTotal)
          : clen != null ? (append ? have : 0) + Number(clen)
          : null
        state.total = total
        state.etag = etag
        writeSidecar(dest, { url, total, etag })

        const ws = fs.createWriteStream(partPath(dest), { flags: append ? 'a' : 'w' })
        await new Promise<void>((resolve, reject) => {
          const reader = res.body.getReader ? res.body.getReader() : null
          if (reader) {
            // Web ReadableStream
            const pump = () => reader.read().then(({ done, value }: any) => {
              if (done) { ws.end(); return }
              ws.write(Buffer.from(value)); emit(); pump()
            }).catch(reject)
            ws.on('finish', resolve); ws.on('error', reject); pump()
          } else {
            // Node stream
            res.body.on('data', (chunk: Buffer) => { ws.write(chunk); emit() })
            res.body.on('end', () => ws.end())
            res.body.on('error', reject)
            ws.on('finish', resolve); ws.on('error', reject)
          }
        })

        // Transfer finished — validate completeness and promote .part → dest.
        const finalSize = partSize(dest)
        if (state.total != null && finalSize < state.total) throw new Error(`truncated: ${finalSize}/${state.total}`)
        fs.renameSync(partPath(dest), dest)
        try { fs.unlinkSync(sidecarPath(dest)) } catch {}
        state.status = 'complete'; state.downloaded = finalSize; state.total = finalSize
        emit()
        return { ...state }
      } catch (e: any) {
        if (controller.signal.aborted) { state.status = 'paused'; state.error = null; emit(); return { ...state } }
        if (attempt >= maxRetries) { state.status = 'error'; state.error = e?.message ?? String(e); emit(); return { ...state } }
        // Backoff, then loop — resumes from whatever bytes are already on disk.
        await new Promise(r => setTimeout(r, baseDelay * 2 ** attempt))
      }
    }
  } finally {
    active.delete(id)
  }
}

/** Pause an in-flight transfer. The `.part` file and sidecar remain, so a later
 *  startDownload resumes from the current offset. */
export function pauseDownload(url: string, dest: string): boolean {
  const id = downloadIdFor(url, dest)
  const h = active.get(id)
  if (!h) return false
  h.controller.abort()
  return true
}

/** Cancel and remove all artifacts for a download. */
export function cancelDownload(url: string, dest: string): void {
  pauseDownload(url, dest)
  for (const p of [partPath(dest), sidecarPath(dest)]) { try { fs.unlinkSync(p) } catch {} }
}
