// Fine-tuning pipeline (Tracks F3 + F4) — exports gold-standard data in
// OpenAI/HuggingFace JSONL format and constructs DPO triples from failure
// taxonomy clusters. The actual fine-tune run is triggered via HuggingFace
// AutoTrain API (free tier). Credentials come from env: HF_TOKEN, HF_REPO.
//
// F3: gold-standard (prompt, response) pairs for supervised fine-tuning (SFT)
// F4: (prompt, chosen, rejected) triples for Direct Preference Optimisation (DPO)

import fs from 'fs'
import path from 'path'
import https from 'https'

export interface SFTEntry {
  prompt: string
  completion: string
  score: number
  promptType: string
  ts: number
}

export interface DPOTriple {
  prompt: string
  chosen: string     // high-score synthesis
  rejected: string   // low-score synthesis (or adversarial counterfactual)
  scoreDelta: number
  promptType: string
  ts: number
}

export interface FineTuneJob {
  id: string
  ts: number
  type: 'sft' | 'dpo'
  sampleCount: number
  hfRepo?: string
  status: 'queued' | 'running' | 'done' | 'failed'
  hfJobId?: string
  error?: string
}

const ftFile = (dir: string) => path.join(dir, '.crucible', 'finetune-jobs.json')

export function loadFineTuneJobs(dir: string): FineTuneJob[] {
  try { return JSON.parse(fs.readFileSync(ftFile(dir), 'utf8')) } catch { return [] }
}

export function saveFineTuneJobs(dir: string, jobs: FineTuneJob[]) {
  fs.mkdirSync(path.dirname(ftFile(dir)), { recursive: true })
  fs.writeFileSync(ftFile(dir), JSON.stringify(jobs.slice(-20), null, 2))
}

// ── F3: Build SFT dataset from history ──────────────────────────────────────

export function buildSFTDataset(dir: string, minScore = 0.80): SFTEntry[] {
  const HISTORY_FILE = path.join(dir, '.crucible', 'history-default.json')
  let sessions: any[] = []
  try { sessions = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')) } catch { return [] }
  return sessions
    .filter(s => s.synthesis && (s.topScore ?? 0) >= minScore)
    .map(s => ({
      prompt: s.query,
      completion: s.synthesis,
      score: s.topScore ?? 0,
      promptType: s.promptType ?? 'general',
      ts: s.ts,
    }))
}

// Export SFT dataset as JSONL (OpenAI chat format / HuggingFace Instruct format)
export function exportSFTJsonl(entries: SFTEntry[]): string {
  return entries.map(e => JSON.stringify({
    messages: [
      { role: 'user', content: e.prompt },
      { role: 'assistant', content: e.completion },
    ],
    metadata: { score: e.score, promptType: e.promptType, ts: e.ts },
  })).join('\n')
}

// ── F4: Build DPO dataset from counterfactuals + history ──────────────────

export function buildDPODataset(dir: string): DPOTriple[] {
  // Source 1: counterfactual pairs where the adversarial answer was flagged
  const cfFile = path.join(dir, '.crucible', 'counterfactuals.json')
  let cfPairs: any[] = []
  try { cfPairs = JSON.parse(fs.readFileSync(cfFile, 'utf8')) } catch {}
  const cfTriples: DPOTriple[] = cfPairs
    .filter((p: any) => p.flagged && p.original && p.adversarial)
    .map((p: any) => ({
      prompt: p.query,
      chosen: p.original,    // the original synthesiser's answer (higher quality)
      rejected: p.adversarial, // the adversarial alternative
      scoreDelta: p.conflictScore ?? 0,
      promptType: p.promptType ?? 'general',
      ts: p.ts,
    }))

  // Source 2: history pairs — high score vs low score for the same promptType
  const HISTORY_FILE = path.join(dir, '.crucible', 'history-default.json')
  let sessions: any[] = []
  try { sessions = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')) } catch {}
  const highScorers = sessions.filter(s => s.synthesis && (s.topScore ?? 0) >= 0.82)
  const lowScorers = sessions.filter(s => s.synthesis && (s.topScore ?? 0) < 0.45)
  const historyTriples: DPOTriple[] = []
  for (const high of highScorers.slice(-30)) {
    const low = lowScorers.find(l => l.promptType === high.promptType)
    if (!low) continue
    historyTriples.push({
      prompt: high.query,
      chosen: high.synthesis,
      rejected: low.synthesis,
      scoreDelta: (high.topScore ?? 0) - (low.topScore ?? 0),
      promptType: high.promptType ?? 'general',
      ts: high.ts,
    })
  }

  return [...cfTriples, ...historyTriples]
}

export function exportDPOJsonl(triples: DPOTriple[]): string {
  return triples.map(t => JSON.stringify({
    prompt: t.prompt,
    chosen: t.chosen,
    rejected: t.rejected,
    metadata: { scoreDelta: t.scoreDelta, promptType: t.promptType, ts: t.ts },
  })).join('\n')
}

// ── HuggingFace AutoTrain trigger ─────────────────────────────────────────

function hfPost(path_: string, token: string, body: object): Promise<any> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const req = https.request(
      { hostname: 'huggingface.co', path: path_, method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      res => {
        let out = ''
        res.on('data', c => { out += c })
        res.on('end', () => {
          try { resolve(JSON.parse(out)) } catch { resolve({ raw: out }) }
        })
      }
    )
    req.on('error', reject)
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('HF timeout')) })
    req.write(data)
    req.end()
  })
}

// Upload a JSONL file to a HuggingFace dataset repo
function hfUpload(repoId: string, token: string, filename: string, content: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(content)
    const boundary = '----CrucibleBoundary'
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: text/plain\r\n\r\n`),
      encoded,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ])
    const req = https.request(
      { hostname: 'huggingface.co',
        path: `/api/datasets/${repoId}/upload/main/${filename}`,
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length } },
      res => {
        let out = ''
        res.on('data', c => { out += c })
        res.on('end', () => { try { resolve(JSON.parse(out)) } catch { resolve({ raw: out }) } })
      }
    )
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

// Submit a fine-tune job. Returns the job record.
export async function submitFineTuneJob(
  dir: string,
  type: 'sft' | 'dpo',
  token: string,
  hfRepo: string
): Promise<FineTuneJob> {
  const job: FineTuneJob = {
    id: `ft_${Date.now()}`,
    ts: Date.now(),
    type,
    sampleCount: 0,
    hfRepo,
    status: 'queued',
  }

  try {
    let jsonl: string
    if (type === 'sft') {
      const entries = buildSFTDataset(dir, 0.80)
      if (entries.length < 10) throw new Error(`Not enough SFT samples (${entries.length} < 10)`)
      job.sampleCount = entries.length
      jsonl = exportSFTJsonl(entries)
    } else {
      const triples = buildDPODataset(dir)
      if (triples.length < 5) throw new Error(`Not enough DPO triples (${triples.length} < 5)`)
      job.sampleCount = triples.length
      jsonl = exportDPOJsonl(triples)
    }

    // Upload dataset to HF
    const filename = `crucible-${type}-${Date.now()}.jsonl`
    await hfUpload(hfRepo, token, filename, jsonl)

    // Trigger AutoTrain (free tier)
    const autotrainResp = await hfPost(`/api/spaces/${hfRepo}/autotrain`, token, {
      task: type === 'sft' ? 'llm-sft' : 'llm-dpo',
      base_model: 'mistralai/Mistral-7B-Instruct-v0.2',
      data_path: hfRepo,
      train_split: 'train',
    })

    job.hfJobId = autotrainResp?.id ?? autotrainResp?.job_id
    job.status = 'running'
    console.log(`[FineTune] Job submitted: ${job.id} (${type}, ${job.sampleCount} samples)`)
  } catch (e: any) {
    job.status = 'failed'
    job.error = e.message
    console.error(`[FineTune] Job failed: ${e.message}`)
  }

  const jobs = loadFineTuneJobs(dir)
  jobs.push(job)
  saveFineTuneJobs(dir, jobs)
  return job
}

// ── K1: Hard negative mining ──────────────────────────────────────────────────
// Confident failures: high composite score but user rephrased (implicit negative)
// or counterfactual branching found an equally plausible alternative.

export interface HardNegativeEntry {
  prompt: string
  rejected: string       // the confident-but-wrong synthesis
  chosen: string         // corrected answer (critic, user correction, or counterfactual alternative)
  confidenceScore: number
  reason: 'rephrase' | 'counterfactual' | 'critic'
  ts: number
}

export function buildHardNegativeDataset(dir: string): HardNegativeEntry[] {
  const HISTORY_FILE = path.join(dir, '.crucible', 'history-default.json')
  let sessions: any[] = []
  try { sessions = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')) } catch { return [] }

  const entries: HardNegativeEntry[] = []

  // Entries explicitly flagged as hard negatives
  for (const s of sessions) {
    if (!s.hardNegative || !s.synthesis || !s.query) continue
    entries.push({
      prompt: s.query,
      rejected: s.synthesis,
      chosen: s.correctedBy ?? s.counterfactualAlternative ?? s.synthesis,
      confidenceScore: s.topScore ?? 0.7,
      reason: s.counterfactualAlternative ? 'counterfactual' : 'critic',
      ts: s.ts,
    })
  }

  // Load counterfactuals file for additional hard negatives
  try {
    const cfFile = path.join(dir, '.crucible', 'counterfactuals.json')
    const counterfactuals: any[] = JSON.parse(fs.readFileSync(cfFile, 'utf8'))
    for (const cf of counterfactuals) {
      if (!cf.flagged || !cf.originalSynthesis || !cf.adversarialSynthesis) continue
      entries.push({
        prompt: cf.query ?? '',
        rejected: cf.originalSynthesis,
        chosen: cf.adversarialSynthesis,
        confidenceScore: cf.compositeScore ?? 0.75,
        reason: 'counterfactual',
        ts: cf.ts ?? Date.now(),
      })
    }
  } catch {}

  return entries
}

// K1: flag a history entry as a hard negative
export function flagHardNegative(dir: string, query: string, correctedBy: string) {
  const HISTORY_FILE = path.join(dir, '.crucible', 'history-default.json')
  let sessions: any[] = []
  try { sessions = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')) } catch { return }
  const entry = sessions.find((s: any) => s.query === query)
  if (entry) {
    entry.hardNegative = true
    entry.correctedBy = correctedBy
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(sessions, null, 2))
  }
}

// ── K2: Ensemble disagreement as training signal ──────────────────────────────
// High variance (max-min > 0.35) → contested question → high information density.

export interface DisagreementEntry {
  prompt: string
  modelResponses: Array<{ modelId: string; text: string; score: number }>
  finalSynthesis: string
  scoreVariance: number
  promptType: string
  ts: number
}

export function buildDisagreementDataset(dir: string, minVariance = 0.35): DisagreementEntry[] {
  const HISTORY_FILE = path.join(dir, '.crucible', 'history-default.json')
  let sessions: any[] = []
  try { sessions = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')) } catch { return [] }

  return sessions
    .filter((s: any) => s.query && s.synthesis && (s.scoreVariance ?? 0) >= minVariance)
    .map((s: any) => ({
      prompt: s.query,
      modelResponses: s.modelResponses ?? [],
      finalSynthesis: s.synthesis,
      scoreVariance: s.scoreVariance ?? 0,
      promptType: s.promptType ?? 'general',
      ts: s.ts,
    }))
}

// ── K3: Fine-tuned model re-integration ──────────────────────────────────────
// After a HF AutoTrain job completes, the resulting model ID is registered as
// a new ensemble worker via this function. The server calls it when checking
// job status and finding a completed run.

export function getFineTunedModelId(dir: string): string | null {
  const jobs = loadFineTuneJobs(dir)
  const done = jobs.filter(j => j.status === 'done' && j.hfRepo)
  if (!done.length) return null
  const latest = done[done.length - 1]
  // HuggingFace model ID format: {repo}/crucible-finetuned
  return `${latest.hfRepo}/crucible-finetuned`
}

// ── K4: Synthetic adversarial pair extraction ────────────────────────────────
// Stage 3 critique → (worse_draft, critique, better_revision) triples.
// Extracted automatically from history entries that have a critiquePairs field.

export function buildAdversarialPairs(dir: string): DPOTriple[] {
  const HISTORY_FILE = path.join(dir, '.crucible', 'history-default.json')
  let sessions: any[] = []
  try { sessions = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')) } catch { return [] }

  const pairs: DPOTriple[] = []

  for (const s of sessions) {
    if (!s.query || !s.synthesis) continue
    // Stage 3 critique pairs stored in history
    if (Array.isArray(s.critiquePairs)) {
      for (const cp of s.critiquePairs) {
        if (cp.draft && cp.revised && cp.draft !== cp.revised) {
          pairs.push({
            prompt: s.query,
            chosen: cp.revised,
            rejected: cp.draft,
            scoreDelta: 0.2,
            promptType: s.promptType ?? 'general',
            ts: s.ts,
          })
        }
      }
    }
  }

  // Also add hard negatives as DPO pairs
  const hardNegs = buildHardNegativeDataset(dir)
  for (const hn of hardNegs) {
    if (hn.chosen !== hn.rejected) {
      pairs.push({
        prompt: hn.prompt,
        chosen: hn.chosen,
        rejected: hn.rejected,
        scoreDelta: 0.3,
        promptType: 'general',
        ts: hn.ts,
      })
    }
  }

  return pairs
}

// ── K5: Calibration training — penalize confident wrongness ──────────────────
// Cases where confidence was HIGH but user was dissatisfied (rephrase signal).
// These calibration examples teach the model to express genuine uncertainty.

export interface CalibrationExample {
  prompt: string
  response: string   // the confidently-wrong response
  confidenceTier: string
  calibrationScore: number
  userSatisfied: false
  ts: number
}

export function buildCalibrationDataset(dir: string): CalibrationExample[] {
  const HISTORY_FILE = path.join(dir, '.crucible', 'history-default.json')
  let sessions: any[] = []
  try { sessions = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')) } catch { return [] }

  // Entries where calibration was HIGH but marked as hard negative
  return sessions
    .filter((s: any) => s.hardNegative && s.confidence?.overallTier === 'HIGH' && s.synthesis && s.query)
    .map((s: any) => ({
      prompt: s.query,
      response: s.synthesis,
      confidenceTier: s.confidence.overallTier,
      calibrationScore: s.confidence.overallScore ?? 0.8,
      userSatisfied: false as const,
      ts: s.ts,
    }))
}

export function exportCalibrationJsonl(examples: CalibrationExample[]): string {
  return examples.map(e => JSON.stringify({
    messages: [
      { role: 'user', content: e.prompt },
      { role: 'assistant', content: e.response },
    ],
    label: 'calibration_negative',
    metadata: { confidenceTier: e.confidenceTier, calibrationScore: e.calibrationScore },
  })).join('\n')
}
