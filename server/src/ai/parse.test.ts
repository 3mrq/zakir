import { describe, expect, it } from 'vitest';
import { AIError } from './errors.ts';
import { parseCliOutput } from './parse.ts';

const errOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e as AIError;
  }
  throw new Error('expected throw');
};

describe('parseCliOutput', () => {
  it('reads structured_output on success', () => {
    const out = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, structured_output: { a: 1 }, result: '{"a":1}', num_turns: 2, modelUsage: { 'claude-sonnet-5-5': {} } });
    const r = parseCliOutput(out);
    expect(r.data).toEqual({ a: 1 });
    expect(r.meta.model).toBe('claude-sonnet-5-5');
  });

  it('falls back to parsing result text', () => {
    expect(parseCliOutput(JSON.stringify({ is_error: false, result: '{"b":2}' })).data).toEqual({ b: 2 });
  });

  // Captured from the real CLI before login: subtype says "success" but is_error is true.
  it('detects not-logged-in even when subtype is success', () => {
    const e = errOf(() => parseCliOutput(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login' })));
    expect(e.code).toBe('NOT_LOGGED_IN');
    expect(e.userMessage).toContain('claude auth login');
  });

  it('classifies usage limits', () => {
    expect(errOf(() => parseCliOutput(JSON.stringify({ is_error: true, result: 'Claude AI usage limit reached|1760000000' }))).code).toBe('USAGE_LIMIT');
  });

  it('rejects non-JSON stdout and non-JSON results', () => {
    expect(errOf(() => parseCliOutput('Error: boom')).code).toBe('PROCESS_ERROR');
    expect(errOf(() => parseCliOutput(JSON.stringify({ is_error: false, result: 'just text' }))).code).toBe('INVALID_OUTPUT');
  });
});
