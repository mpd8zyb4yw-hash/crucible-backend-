// Remote Brain device pairing, permission tiers, audit log — design spec §5.2
// (docs/DESIGN_SPEC_TOOL_BUILDER_REMOTE_BRAIN.md).
//
// Pairing model: the authenticated desktop mints a short-lived numeric code; the phone
// claims it once and receives a long-lived random token (shown once, stored only as a
// sha256 hash — same discipline as an SSH key, not a shared password). Every request
// re-checks the store, so revocation (the kill switch) is immediate.
//
// Tiers (§5.2): observe < build < full. Enforced twice — at the HTTP layer in server.ts
// (observe = read-only routes) and at the tool layer in registry.exec via ctx.deviceTier
// (build = no shell / UI control / deletes). Destructive shell ops stay behind the
// existing allowDestructive gate for EVERY tier, per spec ("even inside Tier 3").

import fs from 'fs'
import path from 'path'
import crypto from 'crypto'

export type DeviceTier = 'observe' | 'build' | 'full'

export interface RemoteDevice {
  id: string
  name: string
  tokenHash: string          // sha256 of the credential — the raw token is never stored
  tier: DeviceTier
  createdAt: number
  lastSeen: number | null
  revokedAt: number | null
}

const PAIRING_TTL_MS = 5 * 60_000
const pendingCodes = new Map<string, { expiresAt: number }>()

function devicesFile(baseDir: string): string {
  return path.join(baseDir, '.crucible', 'remote-devices.json')
}

function auditFile(baseDir: string): string {
  return path.join(baseDir, '.crucible', 'remote-audit.jsonl')
}

function loadDevices(baseDir: string): RemoteDevice[] {
  try { return JSON.parse(fs.readFileSync(devicesFile(baseDir), 'utf-8')) } catch { return [] }
}

function saveDevices(baseDir: string, devices: RemoteDevice[]): void {
  const file = devicesFile(baseDir)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(devices, null, 2), 'utf-8')
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex')
}

// ── Pairing ───────────────────────────────────────────────────────────────────

/** Desktop-side: mint a 6-digit pairing code, valid for 5 minutes, single-use. */
export function createPairingCode(): { code: string; expiresAt: number } {
  for (const [code, meta] of pendingCodes) if (meta.expiresAt < Date.now()) pendingCodes.delete(code)
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0')
  const expiresAt = Date.now() + PAIRING_TTL_MS
  pendingCodes.set(code, { expiresAt })
  return { code, expiresAt }
}

/** Phone-side: exchange a valid code for a device credential. The token is returned
 *  exactly once and never stored in the clear. New devices start at 'observe' —
 *  granting more is an explicit desktop-side action, never part of pairing. */
export function claimPairingCode(baseDir: string, code: string, name: string): { id: string; token: string; tier: DeviceTier } | null {
  const meta = pendingCodes.get(code)
  if (!meta || meta.expiresAt < Date.now()) return null
  pendingCodes.delete(code)   // single-use
  const token = crypto.randomBytes(32).toString('base64url')
  const device: RemoteDevice = {
    id: crypto.randomBytes(8).toString('hex'),
    name: (name || 'unnamed device').slice(0, 60),
    tokenHash: hashToken(token),
    tier: 'observe',
    createdAt: Date.now(),
    lastSeen: null,
    revokedAt: null,
  }
  const devices = loadDevices(baseDir)
  devices.push(device)
  saveDevices(baseDir, devices)
  appendAudit(baseDir, { deviceId: device.id, action: 'paired', detail: device.name })
  return { id: device.id, token, tier: device.tier }
}

// ── Verification / kill switch ────────────────────────────────────────────────

/** Re-checked on every request — a revoked device dies mid-session. */
export function verifyDeviceToken(baseDir: string, token: string): RemoteDevice | null {
  if (!token) return null
  const hash = hashToken(token)
  const devices = loadDevices(baseDir)
  const device = devices.find(d => d.tokenHash === hash && !d.revokedAt)
  if (!device) return null
  device.lastSeen = Date.now()
  saveDevices(baseDir, devices)
  return device
}

export function listDevices(baseDir: string): Array<Omit<RemoteDevice, 'tokenHash'>> {
  return loadDevices(baseDir).map(({ tokenHash: _hash, ...rest }) => rest)
}

/** Kill switch — immediate, irreversible for this credential. Re-pair to restore. */
export function revokeDevice(baseDir: string, id: string): boolean {
  const devices = loadDevices(baseDir)
  const device = devices.find(d => d.id === id && !d.revokedAt)
  if (!device) return false
  device.revokedAt = Date.now()
  saveDevices(baseDir, devices)
  appendAudit(baseDir, { deviceId: id, action: 'revoked' })
  return true
}

/** Tier changes are desktop-owner actions only — enforced at the route, asserted here. */
export function setDeviceTier(baseDir: string, id: string, tier: DeviceTier): boolean {
  if (!['observe', 'build', 'full'].includes(tier)) return false
  const devices = loadDevices(baseDir)
  const device = devices.find(d => d.id === id && !d.revokedAt)
  if (!device) return false
  const prev = device.tier
  device.tier = tier
  saveDevices(baseDir, devices)
  appendAudit(baseDir, { deviceId: id, action: 'tier_changed', detail: `${prev} -> ${tier}` })
  return true
}

// ── Audit log (§5.2) ─────────────────────────────────────────────────────────
// Append-only JSONL: every remote command and its result, viewable from either
// device, exportable (it's a file).

export interface AuditEntry {
  ts?: number
  deviceId: string
  action: string             // 'paired' | 'revoked' | 'tier_changed' | 'http' | 'tool'
  detail?: string
  ok?: boolean
}

export function appendAudit(baseDir: string, entry: AuditEntry): void {
  try {
    const file = auditFile(baseDir)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, JSON.stringify({ ts: Date.now(), ...entry }) + '\n', 'utf-8')
  } catch { /* audit failure must never break the request */ }
}

export function readAudit(baseDir: string, n = 200): AuditEntry[] {
  try {
    const lines = fs.readFileSync(auditFile(baseDir), 'utf-8').trim().split('\n')
    return lines.slice(-n).map(l => { try { return JSON.parse(l) } catch { return null } }).filter((e): e is AuditEntry => e !== null)
  } catch { return [] }
}

// ── Tier semantics ────────────────────────────────────────────────────────────

/** Tools denied to the 'build' tier: arbitrary shell, UI control, deletes, trash.
 *  'observe' devices never reach tool execution (HTTP layer blocks non-GET), and
 *  'full' passes everything except destructive shell (allowDestructive stays false). */
export const BUILD_TIER_DENIED_TOOLS = new Set([
  'run', 'click_element', 'type_text', 'get_ui_tree',
  'delete_file', 'delete_folder', 'empty_trash', 'move_file',
])

export function tierPermitsTool(tier: DeviceTier, toolName: string): boolean {
  if (tier === 'full') return true
  if (tier === 'build') return !BUILD_TIER_DENIED_TOOLS.has(toolName)
  return false   // observe: no tool execution at all
}
