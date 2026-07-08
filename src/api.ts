// Backend base URL — resolved at runtime from the page's own hostname.
//
// On the Mac:        page is http://localhost:5173   → API = http://localhost:3001
// On a phone (LAN):  page is http://192.168.x.x:5173 → API = http://192.168.x.x:3001
// Through a tunnel:  page is https://foo.trycloudflare.com → API = same origin (see below)
//
// This means the device that loads the UI always talks to the backend at the SAME
// host it loaded the page from — never a bare "localhost", which on a phone would
// point at the phone itself.

function resolveApiBase(): string {
  const { protocol, hostname } = window.location

  // Allow an explicit override (e.g. a tunnel URL) via localStorage for advanced use.
  const override = (() => {
    try { return localStorage.getItem('crucible_api_base') } catch { return null }
  })()
  if (override) return override.replace(/\/$/, '')

  // Through a tunnel or any non-localhost host: API is same origin, proxied by Vite.
  if (hostname !== 'localhost' && hostname !== '127.0.0.1' && !hostname.match(/^192\.168\.|^10\.|^172\.(1[6-9]|2\d|3[01])\./)) {
    return `${protocol}//${hostname}`
  }

  // Standard local-network case: same host, backend on port 3001.
  return `${protocol}//${hostname}:3001`
}

export const API_BASE = resolveApiBase()

// ── Remote Brain device credential (design spec §5.2) ───────────────────────
// When this browser has paired as a remote device, its token rides every request
// as x-crucible-device. The backend re-verifies per request, so revocation from
// either surface kills the session immediately.

const DEVICE_TOKEN_KEY = 'crucible_device_token'

export function getDeviceToken(): string | null {
  try { return localStorage.getItem(DEVICE_TOKEN_KEY) } catch { return null }
}

export function setDeviceToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(DEVICE_TOKEN_KEY, token)
    else localStorage.removeItem(DEVICE_TOKEN_KEY)
  } catch { /* private mode */ }
}

// Credentials-included fetch — used for all /api/* requests so httpOnly cookies
// are sent automatically. Keeps every call site clean.
export function apiFetch(url: string, init?: RequestInit): Promise<Response> {
  const token = getDeviceToken()
  const headers = token
    ? { ...(init?.headers as Record<string, string> | undefined), 'x-crucible-device': token }
    : init?.headers
  return fetch(url, { credentials: 'include', ...init, headers })
}
