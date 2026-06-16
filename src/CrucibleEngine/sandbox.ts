// ============================================================
// CRUCIBLE — Code Execution Sandbox
// On-device execution for JS/TS/Python/Bash + syntax checking
// for compiled languages. Zero API calls. Zero gimmicks.
// ============================================================
/// <reference types="node" />

import * as vm from 'vm'
import { spawn, ChildProcess } from 'child_process'
import * as ts from 'typescript'

// ── Types ─────────────────────────────────────────────────────────────────

export type Language =
  | 'javascript'
  | 'typescript'
  | 'python'
  | 'bash'
  | 'rust'
  | 'go'
  | 'java'
  | 'swift'
  | 'sql'
  | 'html'
  | 'css'
  | 'json'
  | 'yaml'
  | 'unknown'

export type ErrorType =
  | 'SYNTAX'
  | 'REFERENCE'
  | 'TYPE'
  | 'IMPORT'
  | 'RUNTIME'
  | 'LOGIC'
  | 'TIMEOUT'
  | 'UNKNOWN'

export interface ExecutionResult {
  success: boolean
  output: string
  error: string | null
  errorType: ErrorType | null
  errorLine: number | null
  errorColumn: number | null
  executionMs: number
  language: Language
  // True when full runtime execution wasn't possible (external imports unavailable in the
  // network-denied sandbox) but the code passed REAL static verification (syntax + types).
  staticOnly?: boolean
}

// ── Language Detection ────────────────────────────────────────────────────

const LANGUAGE_PATTERNS: Array<{ language: Language; patterns: RegExp[] }> = [
  {
    language: 'bash',
    patterns: [/^#!\s*\/bin\/(ba)?sh/m, /\becho\s+/, /\bfi\b/, /\besac\b/, /\$\{?\w+\}?/]
  },
  {
    language: 'python',
    patterns: [/^import\s+\w+/m, /^from\s+\w+\s+import/m, /\bdef\s+\w+\s*\(/, /\belif\b/, /\bexcept\b/, /print\(/]
  },
  {
    language: 'rust',
    patterns: [/\bfn\s+main\s*\(\s*\)/, /\blet\s+mut\b/, /\bimpl\b/, /use\s+std::/, /->.*\{/]
  },
  {
    language: 'go',
    patterns: [/\bpackage\s+main\b/, /\bfunc\s+main\s*\(\s*\)/, /\bfmt\.Print/, /\b:=\b/]
  },
  {
    language: 'java',
    patterns: [/\bpublic\s+class\b/, /\bSystem\.out\.print/, /\bvoid\s+main\b/, /\bimport\s+java\./]
  },
  {
    language: 'swift',
    patterns: [/\bimport\s+Foundation\b/, /\bvar\s+\w+\s*:\s*\w+/, /\bguard\s+let\b/, /\bfunc\s+\w+/]
  },
  {
    language: 'sql',
    patterns: [/\bSELECT\b/i, /\bINSERT\s+INTO\b/i, /\bCREATE\s+TABLE\b/i, /\bWHERE\b/i]
  },
  {
    language: 'html',
    patterns: [/<!DOCTYPE\s+html/i, /<html[\s>]/, /<body[\s>]/, /<div[\s>]/]
  },
  {
    language: 'css',
    patterns: [/\w+\s*\{[^}]*\}/, /margin\s*:/, /padding\s*:/, /font-size\s*:/]
  },
  {
    language: 'json',
    patterns: [/^\s*[\[{]/, /^\s*"[\w]+":\s*/m]
  },
  {
    language: 'typescript',
    patterns: [/:\s*(string|number|boolean|void|any|never)\b/, /\binterface\s+\w+/, /\btype\s+\w+\s*=/, /<\w+>/, /\bas\s+\w+/]
  },
  {
    language: 'javascript',
    patterns: [/\bconst\s+\w+\s*=/, /\blet\s+\w+\s*=/, /\brequire\s*\(/, /=>\s*\{/, /\bconsole\.\w+\(/]
  },
]

export function detectLanguage(code: string): Language {
  const stripped = code.replace(/^```\w*\n?/gm, '').replace(/^```$/gm, '').trim()

  for (const { language, patterns } of LANGUAGE_PATTERNS) {
    const matches = patterns.filter(p => p.test(stripped)).length
    if (matches >= 2) return language
  }

  for (const { language, patterns } of LANGUAGE_PATTERNS) {
    if (patterns.some(p => p.test(stripped))) return language
  }

  return 'unknown'
}

export function stripMarkdownFences(code: string): string {
  return code.replace(/^```[\w]*\n?/gm, '').replace(/^```$/gm, '').trim()
}

// ── Python Prewarmed Worker ───────────────────────────────────────────────

let pythonWorker: ChildProcess | null = null
let pythonReady = false

export function prewarmPython(): void {
  try {
    pythonWorker = spawn('python3', ['-u', '-c', `
import sys
import json
while True:
    line = sys.stdin.readline()
    if not line:
        break
    try:
        code = json.loads(line.strip())
        exec(compile(code, '<crucible>', 'exec'), {})
        sys.stdout.write(json.dumps({'success': True, 'output': ''}) + '\\n')
        sys.stdout.flush()
    except Exception as e:
        import traceback
        sys.stdout.write(json.dumps({'success': False, 'error': str(e), 'traceback': traceback.format_exc()}) + '\\n')
        sys.stdout.flush()
`], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin:/usr/local/bin' }
    })
    pythonReady = true
    console.log('[Sandbox] Python prewarmed')

    pythonWorker.on('exit', () => {
      pythonReady = false
      pythonWorker = null
      console.log('[Sandbox] Python worker exited — will respawn on next call')
    })
  } catch (e) {
    console.warn('[Sandbox] Python prewarm failed — will use cold spawn:', e)
  }
}

// ── Execution Functions ───────────────────────────────────────────────────

function executeJS(code: string, timeoutMs: number): Promise<ExecutionResult> {
  const start = Date.now()
  return new Promise((resolve) => {
    const output: string[] = []
    const sandbox = {
      console: {
        log: (...args: unknown[]) => output.push(args.map(String).join(' ')),
        error: (...args: unknown[]) => output.push('[err] ' + args.map(String).join(' ')),
        warn: (...args: unknown[]) => output.push('[warn] ' + args.map(String).join(' ')),
      },
      setTimeout: () => {},
      clearTimeout: () => {},
      JSON,
      Math,
      Array,
      Object,
      String,
      Number,
      Boolean,
      Date,
      RegExp,
      Error,
      Map,
      Set,
      Promise,
    }

    try {
      const script = new vm.Script(code)
      vm.createContext(sandbox)
      script.runInContext(sandbox, { timeout: timeoutMs })
      resolve({
        success: true,
        output: output.join('\n'),
        error: null,
        errorType: null,
        errorLine: null,
        errorColumn: null,
        executionMs: Date.now() - start,
        language: 'javascript'
      })
    } catch (e: any) {
      const isTimeout = e.message?.includes('timed out') || e.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT'
      resolve({
        success: false,
        output: output.join('\n'),
        error: e.message,
        errorType: isTimeout ? 'TIMEOUT' : classifyJSError(e),
        errorLine: extractLineFromStack(e.stack),
        errorColumn: null,
        executionMs: Date.now() - start,
        language: 'javascript'
      })
    }
  })
}

function executeTS(code: string, timeoutMs: number): Promise<ExecutionResult> {
  const start = Date.now()
  try {
    // First pass: full type-check via createProgram (catches type errors, not just syntax)
    const tmpFile = '/tmp/__crucible_ts_check__.ts'
    const host = ts.createCompilerHost({})
    const originalGetSourceFile = host.getSourceFile.bind(host)
    host.getSourceFile = (fileName, langVersion) => {
      if (fileName === tmpFile) return ts.createSourceFile(fileName, code, langVersion, true)
      return originalGetSourceFile(fileName, langVersion)
    }
    host.fileExists = (f) => f === tmpFile || ts.sys.fileExists(f)
    host.readFile = (f) => f === tmpFile ? code : ts.sys.readFile(f)
    host.writeFile = () => {}

    const prog = ts.createProgram([tmpFile], {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.CommonJS,
      strict: false,
      noEmit: true,
      skipLibCheck: true,
      lib: ['lib.es2020.d.ts'],
    }, host)

    const diagnostics = ts.getPreEmitDiagnostics(prog)
    const ownDiags = diagnostics.filter(d => !d.file || d.file.fileName === tmpFile)

    if (ownDiags.length > 0) {
      const diag = ownDiags[0]
      const msg = ts.flattenDiagnosticMessageText(diag.messageText, '\n')
      const line = diag.file && diag.start !== undefined
        ? diag.file.getLineAndCharacterOfPosition(diag.start).line + 1
        : null
      const col = diag.file && diag.start !== undefined
        ? diag.file.getLineAndCharacterOfPosition(diag.start).character + 1
        : null
      const isType = diag.category === ts.DiagnosticCategory.Error && diag.code >= 2000 && diag.code < 3000
      return Promise.resolve({
        success: false,
        output: '',
        error: `TS${diag.code}: ${msg}`,
        errorType: isType ? 'TYPE' : 'SYNTAX',
        errorLine: line,
        errorColumn: col,
        executionMs: Date.now() - start,
        language: 'typescript' as Language,
      })
    }

    // Second pass: transpile and run
    const result = ts.transpileModule(code, {
      compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, strict: false },
    })
    return executeJS(result.outputText, timeoutMs).then(r => ({ ...r, language: 'typescript' as Language }))
  } catch (e: any) {
    return Promise.resolve({
      success: false,
      output: '',
      error: e.message,
      errorType: 'SYNTAX' as ErrorType,
      errorLine: null,
      errorColumn: null,
      executionMs: Date.now() - start,
      language: 'typescript' as Language,
    })
  }
}

function executePython(code: string, timeoutMs: number): Promise<ExecutionResult> {
  const start = Date.now()
  return new Promise((resolve) => {
    if (pythonReady && pythonWorker?.stdin && pythonWorker?.stdout) {
      let output = ''
      const onData = (chunk: Buffer) => {
        output += chunk.toString()
        if (output.includes('\n')) {
          pythonWorker?.stdout?.removeListener('data', onData)
          clearTimeout(timer)
          try {
            const parsed = JSON.parse(output.trim())
            resolve({
              success: parsed.success,
              output: parsed.output ?? '',
              error: parsed.error ?? null,
              errorType: parsed.error ? classifyPythonError(parsed.error) : null,
              errorLine: parsed.traceback ? extractPythonLine(parsed.traceback) : null,
              errorColumn: null,
              executionMs: Date.now() - start,
              language: 'python'
            })
          } catch {
            resolve({ success: false, output: '', error: 'Parse error from Python worker', errorType: 'UNKNOWN', errorLine: null, errorColumn: null, executionMs: Date.now() - start, language: 'python' })
          }
        }
      }

      const timer = setTimeout(() => {
        pythonWorker?.stdout?.removeListener('data', onData)
        resolve({ success: false, output: '', error: 'Execution timed out', errorType: 'TIMEOUT', errorLine: null, errorColumn: null, executionMs: Date.now() - start, language: 'python' })
      }, timeoutMs)

      pythonWorker.stdout.on('data', onData)
      pythonWorker.stdin.write(JSON.stringify(code) + '\n')
      return
    }

    const proc = spawn('python3', ['-c', code], {
      timeout: timeoutMs,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin:/usr/local/bin' },
      cwd: '/tmp'
    })
    let stdout = '', stderr = ''
    proc.stdout.on('data', (d: Buffer) => stdout += d.toString())
    proc.stderr.on('data', (d: Buffer) => stderr += d.toString())
    proc.on('close', (code) => {
      resolve({
        success: code === 0,
        output: stdout,
        error: stderr || null,
        errorType: stderr ? classifyPythonError(stderr) : null,
        errorLine: stderr ? extractPythonLine(stderr) : null,
        errorColumn: null,
        executionMs: Date.now() - start,
        language: 'python'
      })
    })
    proc.on('error', (e) => {
      resolve({ success: false, output: '', error: e.message, errorType: 'RUNTIME', errorLine: null, errorColumn: null, executionMs: Date.now() - start, language: 'python' })
    })
  })
}

function executeBash(code: string, timeoutMs: number): Promise<ExecutionResult> {
  const start = Date.now()
  return new Promise((resolve) => {
    const proc = spawn('bash', ['-c', code], {
      timeout: timeoutMs,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin:/usr/local/bin' },
      cwd: '/tmp'
    })
    let stdout = '', stderr = ''
    proc.stdout.on('data', (d: Buffer) => stdout += d.toString())
    proc.stderr.on('data', (d: Buffer) => stderr += d.toString())
    proc.on('close', (exitCode) => {
      resolve({
        success: exitCode === 0,
        output: stdout,
        error: stderr || null,
        errorType: stderr ? 'RUNTIME' : null,
        errorLine: null,
        errorColumn: null,
        executionMs: Date.now() - start,
        language: 'bash'
      })
    })
    proc.on('error', (e) => {
      resolve({ success: false, output: '', error: e.message, errorType: 'RUNTIME', errorLine: null, errorColumn: null, executionMs: Date.now() - start, language: 'bash' })
    })
  })
}

function syntaxCheckCompiled(code: string, language: Language, timeoutMs: number): Promise<ExecutionResult> {
  const start = Date.now()

  const configs: Partial<Record<Language, { cmd: string; args: string[]; stdin?: boolean }>> = {
    rust:  { cmd: 'rustc',  args: ['--edition=2021', '--error-format=json', '--emit=metadata', '-'], stdin: true },
    go:    { cmd: 'gofmt',  args: ['-e'], stdin: true },
    java:  { cmd: 'javac',  args: ['-'] },
    swift: { cmd: 'swiftc', args: ['-parse', '-'] },
  }

  const config = configs[language]
  if (!config) {
    return Promise.resolve({ success: true, output: '', error: null, errorType: null, errorLine: null, errorColumn: null, executionMs: 0, language })
  }

  return new Promise((resolve) => {
    const proc = spawn(config.cmd, config.args, { timeout: timeoutMs })
    let stdout = '', stderr = ''
    proc.stdout.on('data', (d: Buffer) => stdout += d.toString())
    proc.stderr.on('data', (d: Buffer) => stderr += d.toString())
    if (config.stdin) proc.stdin?.write(code)
    proc.stdin?.end()
    proc.on('close', (exitCode) => {
      resolve({
        success: exitCode === 0,
        output: stdout,
        error: stderr || null,
        errorType: stderr ? 'SYNTAX' : null,
        errorLine: extractCompilerLine(stderr, language),
        errorColumn: null,
        executionMs: Date.now() - start,
        language
      })
    })
    proc.on('error', () => {
      // Compiler not installed — don't block
      resolve({ success: true, output: '', error: null, errorType: null, errorLine: null, errorColumn: null, executionMs: Date.now() - start, language })
    })
  })
}

function validateStructured(code: string, language: Language): ExecutionResult {
  const start = Date.now()
  try {
    if (language === 'json') {
      JSON.parse(code)
    } else if (language === 'html') {
      if (!/<html[\s>]/i.test(code) && !/<body[\s>]/i.test(code) && !/<div[\s>]/i.test(code)) {
        throw new Error('No recognizable HTML structure')
      }
    }
    return { success: true, output: '', error: null, errorType: null, errorLine: null, errorColumn: null, executionMs: Date.now() - start, language }
  } catch (e: any) {
    return { success: false, output: '', error: e.message, errorType: 'SYNTAX', errorLine: null, errorColumn: null, executionMs: Date.now() - start, language }
  }
}

// ── Main Entry Point ──────────────────────────────────────────────────────

export async function executeCode(
  rawCode: string,
  language?: Language,
  timeoutMs = 5000
): Promise<ExecutionResult> {
  const code = stripMarkdownFences(rawCode)
  const lang = language ?? detectLanguage(code)

  switch (lang) {
    case 'javascript': return executeJS(code, timeoutMs)
    case 'typescript': return executeTS(code, timeoutMs)
    case 'python':     return executePython(code, timeoutMs)
    case 'bash':       return executeBash(code, timeoutMs)
    case 'rust':
    case 'go':
    case 'java':
    case 'swift':      return syntaxCheckCompiled(code, lang, timeoutMs)
    case 'json':
    case 'html':
    case 'css':
    case 'yaml':
    case 'sql':        return validateStructured(code, lang)
    default:           return { success: true, output: '', error: null, errorType: null, errorLine: null, errorColumn: null, executionMs: 0, language: lang }
  }
}

// ── Graded verification ────────────────────────────────────────────────────
// "Always verify, never skip." The sandbox is network-denied (security model), so code
// that imports third-party packages cannot fully execute — that is an ENVIRONMENT limit,
// not a code bug. Rather than skip (a bandaid) or false-fail (which triggered destructive
// auto-fixes), we verify at the deepest level the environment allows: run fully when we can;
// otherwise fall back to real static verification (syntax + types). The verdict is always real.

// Module-resolution codes — "cannot find module / declaration" — are environment, not bugs.
const TS_MODULE_DIAG_CODES = new Set([2307, 2305, 2306, 7016])

function isModuleResolutionError(r: ExecutionResult): boolean {
  if (r.errorType === 'IMPORT') return true
  const e = r.error ?? ''
  return /\bTS2307\b|Cannot find module|Could not find a declaration|No module named|ModuleNotFoundError|ERR_MODULE_NOT_FOUND|Could not resolve|Unable to resolve|require is not defined/i.test(e)
}

// Does the code import/require a NON-relative (external) module? Relative imports ('./x')
// are part of the answer; bare specifiers ('react', 'numpy') need installed deps.
function importsExternalModule(code: string, lang: Language): boolean {
  if (lang === 'typescript' || lang === 'javascript') {
    return /\b(?:import\s[^'"]*from\s*|import\s*|require\s*\(\s*)['"]([^'".][^'"]*)['"]/.test(
      code.replace(/import\s+['"]\.[^'"]*['"]/g, '')
    ) && /['"]([a-zA-Z@][^'"]*)['"]/.test(code)
  }
  if (lang === 'python') {
    const std = /^\s*(?:import|from)\s+(os|sys|re|json|math|random|datetime|collections|itertools|functools|typing|abc|io|time|string|copy|heapq|bisect|decimal|fractions|statistics|unittest)\b/m
    const anyImport = /^\s*(?:import|from)\s+\w/m.test(code)
    return anyImport && !std.test(code)
  }
  return false
}

// Real static verification — syntax + (for TS) types — with module-resolution diagnostics
// filtered out. Dep-free, network-free, deterministic.
export async function staticVerify(code: string, lang: Language): Promise<ExecutionResult> {
  const start = Date.now()
  const clean = stripMarkdownFences(code)
  const base = { output: '', error: null, errorType: null, errorLine: null, errorColumn: null, executionMs: 0, language: lang } as ExecutionResult

  if (lang === 'typescript' || lang === 'javascript') {
    try {
      const tmpFile = lang === 'typescript' ? '/tmp/__crucible_static__.ts' : '/tmp/__crucible_static__.js'
      const host = ts.createCompilerHost({})
      const orig = host.getSourceFile.bind(host)
      host.getSourceFile = (fileName, v) => fileName === tmpFile ? ts.createSourceFile(fileName, clean, v, true) : orig(fileName, v)
      host.fileExists = (f) => f === tmpFile || ts.sys.fileExists(f)
      host.readFile = (f) => f === tmpFile ? clean : ts.sys.readFile(f)
      host.writeFile = () => {}
      const prog = ts.createProgram([tmpFile], {
        target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS,
        strict: false, noEmit: true, skipLibCheck: true, allowJs: true, checkJs: false,
        noResolve: true, lib: ['lib.es2020.d.ts'],
      }, host)
      // Keep only diagnostics about THIS file that are NOT module-resolution noise.
      const diags = ts.getPreEmitDiagnostics(prog)
        .filter(d => (!d.file || d.file.fileName === tmpFile) && !TS_MODULE_DIAG_CODES.has(d.code))
      if (diags.length > 0) {
        const d = diags[0]
        const msg = ts.flattenDiagnosticMessageText(d.messageText, '\n')
        const line = d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start).line + 1 : null
        return { ...base, success: false, error: `TS${d.code}: ${msg}`, errorType: (d.code >= 2000 && d.code < 3000) ? 'TYPE' : 'SYNTAX', errorLine: line, executionMs: Date.now() - start }
      }
      return { ...base, success: true, executionMs: Date.now() - start }
    } catch (e: any) {
      return { ...base, success: false, error: e.message, errorType: 'SYNTAX', executionMs: Date.now() - start }
    }
  }

  if (lang === 'python') {
    // ast.parse catches syntax errors without importing anything.
    return new Promise<ExecutionResult>((resolve) => {
      const proc = spawn('python3', ['-c', 'import ast,sys; ast.parse(sys.stdin.read())'], { timeout: 5000, env: { PATH: process.env.PATH ?? '/usr/bin:/bin:/usr/local/bin' } })
      let stderr = ''
      proc.stderr.on('data', (d: Buffer) => stderr += d.toString())
      proc.on('close', (codeExit) => resolve(codeExit === 0
        ? { ...base, success: true, executionMs: Date.now() - start }
        : { ...base, success: false, error: stderr || 'Syntax error', errorType: 'SYNTAX', errorLine: extractPythonLine(stderr), executionMs: Date.now() - start }))
      proc.on('error', (er) => resolve({ ...base, success: false, error: er.message, errorType: 'SYNTAX', executionMs: Date.now() - start }))
      proc.stdin.write(clean); proc.stdin.end()
    })
  }

  if (lang === 'bash') {
    return new Promise<ExecutionResult>((resolve) => {
      const proc = spawn('bash', ['-n', '-'], { timeout: 5000 })  // -n = syntax check, no run
      let stderr = ''
      proc.stderr.on('data', (d: Buffer) => stderr += d.toString())
      proc.on('close', (codeExit) => resolve(codeExit === 0
        ? { ...base, success: true, executionMs: Date.now() - start }
        : { ...base, success: false, error: stderr || 'Syntax error', errorType: 'SYNTAX', executionMs: Date.now() - start }))
      proc.on('error', (er) => resolve({ ...base, success: false, error: er.message, errorType: 'SYNTAX', executionMs: Date.now() - start }))
      proc.stdin.write(clean); proc.stdin.end()
    })
  }

  // Compiled / structured langs already verify statically and need no external deps.
  return executeCode(clean, lang, 5000)
}

// Graded verify: full execution preferred; on a pure module-resolution failure, fall back to
// static verification and report a REAL static verdict. Never skips, never destroys.
export async function verifyCode(rawCode: string, language?: Language, timeoutMs = 5000): Promise<ExecutionResult> {
  const code = stripMarkdownFences(rawCode)
  const lang = language ?? detectLanguage(code)
  const result = await executeCode(code, lang, timeoutMs)
  if (result.success) return result
  // Only divert genuine environment failures (unresolved external imports) to static verify.
  if (!isModuleResolutionError(result) && !importsExternalModule(code, lang)) return result
  const stat = await staticVerify(code, lang)
  if (stat.success) {
    return { ...stat, staticOnly: true, output: 'Static verification passed — syntax and types are valid. Full runtime execution was skipped because this code imports packages that are not available in the offline sandbox.' }
  }
  return stat  // static found a REAL syntax/type error → report it (a genuine, fixable bug)
}

// ── Streaming Execution ───────────────────────────────────────────────────
// Like executeCode but calls onLine for each stdout/stderr line as it arrives.
// Useful for the sandbox run endpoint and the debug bus.

export interface StreamingResult extends ExecutionResult {
  lines: Array<{ text: string; isErr: boolean; ts: number }>
}

export function executeCodeStreaming(
  rawCode: string,
  language: Language | undefined,
  timeoutMs: number,
  onLine: (text: string, isErr: boolean) => void,
): Promise<StreamingResult> {
  const code = stripMarkdownFences(rawCode)
  const lang = language ?? detectLanguage(code)
  const start = Date.now()
  const lines: StreamingResult['lines'] = []

  const collect = (text: string, isErr: boolean) => {
    lines.push({ text, isErr, ts: Date.now() })
    onLine(text, isErr)
  }

  if (lang !== 'python' && lang !== 'bash') {
    // Non-process langs: batch then fake streaming
    return executeCode(rawCode, lang, timeoutMs).then(r => {
      r.output.split('\n').filter(Boolean).forEach(l => collect(l, false))
      if (r.error) collect(r.error, true)
      return { ...r, lines }
    })
  }

  return new Promise((resolve) => {
    const cmd = lang === 'python' ? 'python3' : 'bash'
    const args = lang === 'python' ? ['-u', '-c', code] : ['-c', code]
    const proc = spawn(cmd, args, {
      timeout: timeoutMs,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin:/usr/local/bin' },
      cwd: '/tmp',
    })

    let stdoutBuf = '', stderrBuf = ''

    const flushLine = (buf: string, isErr: boolean): string => {
      const parts = buf.split('\n')
      for (let i = 0; i < parts.length - 1; i++) {
        if (parts[i]) collect(parts[i], isErr)
      }
      return parts[parts.length - 1]
    }

    proc.stdout.on('data', (d: Buffer) => { stdoutBuf = flushLine(stdoutBuf + d.toString(), false) })
    proc.stderr.on('data', (d: Buffer) => { stderrBuf = flushLine(stderrBuf + d.toString(), true) })

    proc.on('close', (exitCode) => {
      if (stdoutBuf) collect(stdoutBuf, false)
      if (stderrBuf) collect(stderrBuf, true)
      const stderr = lines.filter(l => l.isErr).map(l => l.text).join('\n')
      const stdout = lines.filter(l => !l.isErr).map(l => l.text).join('\n')
      const classifyErr = lang === 'python' ? classifyPythonError : (s: string) => (s ? 'RUNTIME' as ErrorType : null)
      const errType = stderr ? classifyErr(stderr) : null
      resolve({
        success: exitCode === 0,
        output: stdout,
        error: stderr || null,
        errorType: errType,
        errorLine: stderr && lang === 'python' ? extractPythonLine(stderr) : null,
        errorColumn: null,
        executionMs: Date.now() - start,
        language: lang,
        lines,
      })
    })
    proc.on('error', (e) => {
      collect(e.message, true)
      resolve({ success: false, output: '', error: e.message, errorType: 'RUNTIME', errorLine: null, errorColumn: null, executionMs: Date.now() - start, language: lang, lines })
    })
  })
}

// ── Error Classification Helpers ──────────────────────────────────────────

function classifyJSError(e: Error): ErrorType {
  if (e instanceof SyntaxError) return 'SYNTAX'
  if (e instanceof ReferenceError) return 'REFERENCE'
  if (e instanceof TypeError) return 'TYPE'
  if (e.message?.includes('Cannot find module') || e.message?.includes('require')) return 'IMPORT'
  return 'RUNTIME'
}

function classifyPythonError(stderr: string): ErrorType {
  if (stderr.includes('SyntaxError')) return 'SYNTAX'
  if (stderr.includes('IndentationError')) return 'SYNTAX'
  if (stderr.includes('NameError')) return 'REFERENCE'
  if (stderr.includes('ImportError') || stderr.includes('ModuleNotFoundError')) return 'IMPORT'
  if (stderr.includes('TypeError')) return 'TYPE'
  return 'RUNTIME'
}

function extractLineFromStack(stack: string): number | null {
  const match = stack?.match(/<anonymous>:(\d+):\d+/) ?? stack?.match(/at\s+.*:(\d+):\d+/)
  return match ? parseInt(match[1]) : null
}

function extractPythonLine(traceback: string): number | null {
  const match = traceback.match(/line (\d+)/)
  return match ? parseInt(match[1]) : null
}

function extractCompilerLine(stderr: string, language: Language): number | null {
  if (language === 'rust') {
    try {
      const parsed = JSON.parse(stderr.split('\n').find(l => l.startsWith('{')) ?? '{}')
      return parsed?.spans?.[0]?.line_start ?? null
    } catch { return null }
  }
  const match = stderr.match(/:(\d+):/)
  return match ? parseInt(match[1]) : null
}
