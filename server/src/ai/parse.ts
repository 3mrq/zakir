// Parses the single JSON object printed by `claude -p --output-format json`.

import { AIError } from './errors.ts';
import type { AIResponse } from './provider.ts';

interface CliResult {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: unknown;
  structured_output?: unknown;
  num_turns?: number;
  duration_ms?: number;
  total_cost_usd?: number;
  modelUsage?: Record<string, unknown>;
}

/** Maps an error text from the CLI to our error code. */
export function classifyCliError(text: string): AIError {
  const t = text.toLowerCase();
  if (t.includes('not logged in') || t.includes('/login') || t.includes('invalid api key') || t.includes('oauth token')) {
    return new AIError('NOT_LOGGED_IN', text);
  }
  if (t.includes('usage limit') || t.includes('rate limit') || t.includes('limit reached') || t.includes('limit will reset')) {
    return new AIError('USAGE_LIMIT', text);
  }
  return new AIError('AI_ERROR', text);
}

export function parseCliOutput(stdout: string): AIResponse {
  let r: CliResult;
  try {
    r = JSON.parse(stdout.trim());
  } catch {
    throw new AIError('PROCESS_ERROR', `مخرجات غير JSON: ${stdout.slice(0, 200)}`);
  }
  // `subtype` can be "success" even when the call failed — `is_error` is the reliable flag.
  if (r.is_error) throw classifyCliError(String(r.result ?? r.subtype ?? 'unknown error'));

  let data = r.structured_output;
  if (data === undefined) {
    try {
      data = JSON.parse(String(r.result ?? ''));
    } catch {
      throw new AIError('INVALID_OUTPUT', 'الرد ليس JSON');
    }
  }
  return {
    data,
    meta: {
      durationMs: r.duration_ms,
      turns: r.num_turns,
      model: Object.keys(r.modelUsage ?? {})[0],
      costUsd: r.total_cost_usd,
    },
  };
}
