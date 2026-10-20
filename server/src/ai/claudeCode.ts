// AIProvider backed by the local Claude Code CLI (`claude -p`), using the user's subscription.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { AIHealth } from '@zakir/shared';
import { AIError, errorInfo } from './errors.ts';
import { classifyCliError, parseCliOutput } from './parse.ts';
import type { AIProvider, AIRequest, AIResponse } from './provider.ts';

const isWin = process.platform === 'win32';
const EXE = isWin ? 'claude.exe' : 'claude';

/**
 * Finds the native claude binary. We never go through claude.cmd: cmd.exe fails on
 * non-ASCII paths (e.g. an Arabic Windows user name).
 */
export function resolveClaudeBin(configured?: string): string | undefined {
  if (configured) return existsSync(configured) ? configured : undefined;
  const candidates: string[] = [];
  if (isWin && process.env.APPDATA) {
    candidates.push(join(process.env.APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', EXE));
  }
  if (process.env.USERPROFILE) candidates.push(join(process.env.USERPROFILE, '.local', 'bin', EXE));
  if (process.env.HOME) candidates.push(join(process.env.HOME, '.local', 'bin', EXE));
  for (const dir of (process.env.PATH ?? '').split(delimiter)) if (dir) candidates.push(join(dir, EXE));
  return candidates.find((p) => existsSync(p));
}

/** Environment without variables inherited from a parent Claude session (they can redirect auth). */
function cleanEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|ANTHROPIC)/i.test(k)));
}

/** Locked-down flags shared by every call. The user prompt goes through stdin. */
export function buildArgs(req: AIRequest): string[] {
  const args = [
    '-p',
    '--output-format', 'json',
    '--model', req.model,
    '--system-prompt', req.system,
    '--json-schema', JSON.stringify(req.jsonSchema),
    '--permission-mode', 'dontAsk',
    '--restricted', // no shell/code tools, no WebFetch, file tools confined to cwd
    '--strict-mcp-config',
    '--setting-sources', '',
    '--disable-slash-commands',
    '--no-session-persistence',
  ];
  if (req.tools === 'read') args.push('--tools', 'Read', '--allowedTools', 'Read');
  else args.push('--tools', '');
  return args;
}

function killTree(pid: number | undefined) {
  if (!pid) return;
  if (isWin) spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  else {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function abortError(signal: AbortSignal): AIError {
  return signal.reason === 'timeout' ? new AIError('TIMEOUT') : new AIError('CANCELLED');
}

function exec(bin: string, args: string[], opts: { cwd?: string; stdin?: string; signal?: AbortSignal }): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const { signal } = opts;
    if (signal?.aborted) return reject(abortError(signal));
    const child = spawn(bin, args, { cwd: opts.cwd, env: cleanEnv(), shell: false, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d) => (stderr += d));
    // On abort, kill the process tree and settle only once it has exited: on Windows a live
    // process keeps its cwd locked, and the caller deletes that directory right after.
    let fallback: NodeJS.Timeout | undefined;
    const onAbort = () => {
      killTree(child.pid);
      fallback = setTimeout(() => reject(abortError(signal!)), 5_000);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (e: NodeJS.ErrnoException) => {
      signal?.removeEventListener('abort', onAbort);
      reject(e.code === 'ENOENT' ? new AIError('NOT_INSTALLED', e.message) : new AIError('PROCESS_ERROR', e.message));
    });
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      clearTimeout(fallback);
      if (signal?.aborted) reject(abortError(signal));
      else resolve({ code, stdout, stderr });
    });
    child.stdin.on('error', () => {}); // the process may exit before reading stdin
    child.stdin.end(opts.stdin ?? '', 'utf8');
  });
}

export class ClaudeCodeProvider implements AIProvider {
  readonly id = 'claude-code';

  constructor(private readonly configuredBin?: string) {}

  async healthCheck(): Promise<AIHealth> {
    const fail = (code: AIHealth['code'], err: 'NOT_INSTALLED' | 'NOT_LOGGED_IN' | 'PROCESS_ERROR', extra: Partial<AIHealth> = {}, detail?: string): AIHealth => {
      const info = errorInfo(err);
      return { provider: this.id, code, message: detail ? `${info.message} (${detail})` : info.message, fix: info.fix, ...extra };
    };
    const bin = resolveClaudeBin(this.configuredBin);
    if (!bin) return fail('not_installed', 'NOT_INSTALLED');
    try {
      const v = await exec(bin, ['--version'], { signal: AbortSignal.timeout(20_000) });
      const version = v.stdout.trim().split(/\s/)[0];
      const a = await exec(bin, ['auth', 'status'], { signal: AbortSignal.timeout(20_000) });
      let status: { loggedIn?: boolean; subscriptionType?: string };
      try {
        status = JSON.parse(a.stdout);
      } catch {
        return fail('error', 'PROCESS_ERROR', { bin, version }, (a.stderr || a.stdout).slice(0, 200));
      }
      if (!status.loggedIn) return fail('not_logged_in', 'NOT_LOGGED_IN', { bin, version });
      const sub = status.subscriptionType;
      return {
        provider: this.id,
        code: 'ok',
        bin,
        version,
        subscription: sub,
        message: `Claude Code جاهز (الإصدار ${version}${sub ? `، اشتراك ${sub}` : ''}).`,
      };
    } catch (e) {
      if (e instanceof AIError && e.code === 'NOT_INSTALLED') return fail('not_installed', 'NOT_INSTALLED');
      return fail('error', 'PROCESS_ERROR', { bin }, e instanceof Error ? e.message : String(e));
    }
  }

  async run(req: AIRequest, signal: AbortSignal): Promise<AIResponse> {
    const bin = resolveClaudeBin(this.configuredBin);
    if (!bin) throw new AIError('NOT_INSTALLED');
    const res = await exec(bin, buildArgs(req), { cwd: req.workDir, stdin: req.user, signal });
    if (res.stdout.trim()) return parseCliOutput(res.stdout);
    const msg = (res.stderr || `exit code ${res.code}`).trim();
    throw res.code === 0 ? new AIError('PROCESS_ERROR', 'لا توجد مخرجات') : classifyCliError(msg);
  }
}
