/**
 * Mock runtime: a fake, deterministic agent for development and tests (docs/15 #10).
 * No network, no tokens. Behaviour is driven by keywords in the prompt (case-insensitive,
 * matched as whole words so e.g. "task" does not trigger "ask"):
 *   ask   → emits an `ask` event (a question for the user)
 *   fail  → emits an `error` event and finishes with `done.isError`
 *   block → proposes status `blocked`
 *   done  → proposes status `done`
 */
import type { AgentEvent, RuntimeAdapter, TicketRun } from '@sebeto/shared';

export interface MockAdapterOptions {
  /** Delay between events in ms (default 0). Useful to see runs "live" in the UI. */
  delayMs?: number;
}

export const MOCK_COST_USD = 0.01;
export const MOCK_TOKENS_IN = 100;
export const MOCK_TOKENS_OUT = 50;

/** Sleep that resolves early (with false) when the signal aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  if (ms <= 0) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function hasWord(text: string, word: string): boolean {
  return new RegExp(`\\b${word}\\b`, 'i').test(text);
}

export function createMockAdapter(opts: MockAdapterOptions = {}): RuntimeAdapter {
  const delayMs = opts.delayMs ?? 0;

  async function* run(r: TicketRun): AsyncGenerator<AgentEvent> {
    const { signal } = r;
    // Each step waits first, then yields; abort stops the run promptly.
    const step = async (): Promise<boolean> => !signal.aborted && (await sleep(delayMs, signal)) && !signal.aborted;

    if (!(await step())) return;
    // Stable id per ticket for new sessions; reuse the existing one when resuming.
    const externalSessionId = r.externalSessionId ?? r.newExternalSessionId ?? `mock-${r.ticketId}`;
    yield { kind: 'session', externalSessionId };

    if (!(await step())) return;
    const preview = r.prompt.replace(/\s+/g, ' ').trim().slice(0, 80);
    yield { kind: 'text', text: `I am the free test agent (no AI), so I cannot do real work. I received: "${preview}". Assign a real agent such as Assistant to get it done.` };

    if (!(await step())) return;
    yield { kind: 'tool', name: 'mock.read', summary: 'Looked at the files in the ticket folder' };

    if (!(await step())) return;
    const prompt = r.prompt;
    if (hasWord(prompt, 'fail')) {
      yield { kind: 'error', message: 'The mock agent failed on purpose (prompt contained "fail").' };
      yield { kind: 'usage', tokensIn: MOCK_TOKENS_IN, tokensOut: MOCK_TOKENS_OUT, costUsd: MOCK_COST_USD };
      yield { kind: 'done', costUsd: MOCK_COST_USD, tokensIn: MOCK_TOKENS_IN, tokensOut: MOCK_TOKENS_OUT, isError: true };
      return;
    }
    if (hasWord(prompt, 'ask')) {
      yield { kind: 'ask', question: 'Could you tell me a bit more about what you want?' };
    }
    if (hasWord(prompt, 'block')) {
      yield { kind: 'status', status: 'blocked', note: 'The mock agent is blocked on purpose.' };
    } else if (hasWord(prompt, 'done')) {
      yield { kind: 'text', text: 'All finished. Please review the result.' };
      yield { kind: 'status', status: 'done', note: 'Work complete.' };
    }

    if (!(await step())) return;
    yield { kind: 'usage', tokensIn: MOCK_TOKENS_IN, tokensOut: MOCK_TOKENS_OUT, costUsd: MOCK_COST_USD };
    yield { kind: 'done', costUsd: MOCK_COST_USD, tokensIn: MOCK_TOKENS_IN, tokensOut: MOCK_TOKENS_OUT, isError: false };
  }

  return {
    id: 'mock',
    displayName: 'Mock agent (no AI, for testing)',
    capabilities: { tools: false, resume: true, costReport: true },
    detect: async () => ({ installed: true, version: '0.1.0', loggedIn: true }),
    models: async () => ['mock'],
    run,
  };
}
