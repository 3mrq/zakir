// Provider abstraction: the rest of the app only talks to AIProvider.
// Adding Ollama or the Claude API later means one new implementation of this interface.

import type { AIHealth } from '@zakir/shared';

export interface AIRequest {
  system: string;
  user: string;
  /** JSON Schema the output must follow. */
  jsonSchema: object;
  model: string;
  /** 'none' for text tasks (sources are inlined in the prompt); 'read' only for reading scanned pages/images. */
  tools: 'none' | 'read';
  /** Directory the provider may read from when tools = 'read'. */
  workDir: string;
}

export interface AIResponse {
  /** Parsed JSON output — not yet validated against the task's Zod schema. */
  data: unknown;
  meta: { durationMs?: number; turns?: number; model?: string; costUsd?: number };
}

export interface AIProvider {
  readonly id: string;
  healthCheck(): Promise<AIHealth>;
  /** Throws AIError on failure. Must stop the work promptly when `signal` aborts. */
  run(req: AIRequest, signal: AbortSignal): Promise<AIResponse>;
}
