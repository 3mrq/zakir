import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { config } from '../config.ts';
import { loadPrompt, parsePromptFile, render } from './prompts.ts';

describe('prompts', () => {
  it('splits system and user sections', () => {
    expect(parsePromptFile('<!-- system -->\nA\n<!-- user -->\nB {{x}}')).toEqual({ system: 'A', user: 'B {{x}}' });
  });

  it('throws on missing sections or variables', () => {
    expect(() => parsePromptFile('no sections')).toThrow();
    expect(() => render('{{missing}}', {})).toThrow('missing');
  });

  it('every file in prompts/ parses', () => {
    for (const f of readdirSync(config.promptsDir).filter((f) => f.endsWith('.md'))) {
      expect(() => loadPrompt(config.promptsDir, f.replace(/\.md$/, ''))).not.toThrow();
    }
  });
});
