// Loads task prompts from prompts/<kind>.md.
// File format: a "<!-- system -->" section then a "<!-- user -->" section; {{name}} placeholders are filled at run time.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface PromptTemplate {
  system: string;
  user: string;
}

export function parsePromptFile(text: string): PromptTemplate {
  const m = text.match(/<!--\s*system\s*-->([\s\S]*?)<!--\s*user\s*-->([\s\S]*)$/);
  if (!m) throw new Error('ملف التعليمات يجب أن يحتوي على القسمين <!-- system --> ثم <!-- user -->');
  return { system: m[1]!.trim(), user: m[2]!.trim() };
}

export function render(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) => {
    const v = vars[name];
    if (v === undefined) throw new Error(`متغير ناقص في ملف التعليمات: {{${name}}}`);
    return v;
  });
}

export function loadPrompt(dir: string, kind: string): PromptTemplate {
  return parsePromptFile(readFileSync(join(dir, `${kind}.md`), 'utf8'));
}
