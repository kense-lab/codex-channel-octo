/**
 * agent-bridge (codex) tests — pure unit tests with a mocked @openai/codex-sdk.
 * No real codex process is spawned: we feed synthetic ThreadEvent streams and
 * assert the bridge's mapping (text yield, redacted progress, threadId capture,
 * side-effect gating, stale-resume recovery).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock the SDK ────────────────────────────────────────────────────────────
// Each test sets `scriptedRuns`: an array of async generators, one per
// startThread/resumeThread().runStreamed() call, consumed in order. `calls`
// records how each thread was created so we can assert resume vs fresh.
type Ev = Record<string, unknown>;
let scriptedRuns: Array<() => AsyncGenerator<Ev>>;
let runIdx: number;
const calls: Array<{ kind: 'start' | 'resume'; resumeId?: string; opts?: Record<string, unknown> }> = [];

function makeThread() {
  return {
    async runStreamed(_prompt: string) {
      void _prompt;
      const gen = scriptedRuns[runIdx++];
      if (!gen) throw new Error('no scripted run left');
      return { events: gen() };
    },
  };
}

vi.mock('@openai/codex-sdk', () => ({
  Codex: class {
    startThread(opts?: Record<string, unknown>) {
      calls.push({ kind: 'start', opts });
      return makeThread();
    }
    resumeThread(id: string, opts?: Record<string, unknown>) {
      calls.push({ kind: 'resume', resumeId: id, opts });
      return makeThread();
    }
  },
}));

import {
  queryAgent,
  buildCodexEnv,
  resolveSandbox,
  summarizeItem,
  buildThreadOptions,
  MAX_TOOL_PARAM_CHARS,
} from '../agent-bridge.js';
import type { Config } from '../config.js';

function cfg(overrides: Partial<Config['sdk']> = {}): Config {
  return {
    botToken: 't',
    apiUrl: 'https://example.com',
    baseDir: '/tmp/cco-test',
    cwd: '/tmp/cco-test/ws',
    cwdBase: '/tmp/cco-test/ws',
    dataDir: '/tmp/cco-test/data',
    sdk: { ...overrides },
    rateLimit: { maxPerMinute: 5 },
    context: { maxContextChars: 6000, historyLimit: 40 },
    maxResponseChars: 524288,
    dispatchTimeoutMs: 300000,
  } as Config;
}

async function collect(it: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const c of it) out.push(c);
  return out;
}

// Event helpers
const started = (id: string): Ev => ({ type: 'thread.started', thread_id: id });
const turnDone: Ev = { type: 'turn.completed', usage: {} };
const msg = (id: string, text: string): Ev => ({
  type: 'item.completed',
  item: { id, type: 'agent_message', text },
});
const cmd = (id: string, command: string, phase: 'started' | 'completed'): Ev => ({
  type: `item.${phase}`,
  item: { id, type: 'command_execution', command, aggregated_output: 'SECRET OUTPUT', status: 'completed' },
});

beforeEach(() => {
  scriptedRuns = [];
  runIdx = 0;
  calls.length = 0;
});

describe('buildCodexEnv', () => {
  it('returns undefined when nothing to add', () => {
    expect(buildCodexEnv({}, { PATH: '/bin' } as NodeJS.ProcessEnv)).toBeUndefined();
  });
  it('injects CODEX_HOME and drops undefined base vars', () => {
    const env = buildCodexEnv(
      { codexHome: '/home/bot/.codex' },
      { PATH: '/bin', EMPTY: undefined } as NodeJS.ProcessEnv,
    );
    expect(env?.CODEX_HOME).toBe('/home/bot/.codex');
    expect(env?.PATH).toBe('/bin');
    expect('EMPTY' in (env as object)).toBe(false);
  });
  it('layers operator env over base', () => {
    const env = buildCodexEnv(
      { env: { FOO: 'bar' }, codexHome: '/h' },
      { PATH: '/bin' } as NodeJS.ProcessEnv,
    );
    expect(env?.FOO).toBe('bar');
    expect(env?.CODEX_HOME).toBe('/h');
  });
});

describe('resolveSandbox', () => {
  it('defaults to read-only', () => {
    expect(resolveSandbox({})).toBe('read-only');
  });
  it('rejects danger-full-access', () => {
    expect(() => resolveSandbox({ sandboxMode: 'danger-full-access' })).toThrow();
  });
  it('downgrades workspace-write without allowWorkspaceWrite', () => {
    expect(resolveSandbox({ sandboxMode: 'workspace-write' })).toBe('read-only');
  });
  it('honors workspace-write with the gate on', () => {
    expect(resolveSandbox({ sandboxMode: 'workspace-write', allowWorkspaceWrite: true })).toBe(
      'workspace-write',
    );
  });
});

describe('buildThreadOptions', () => {
  it('parses network/webSearch from config (default off)', () => {
    const o = buildThreadOptions(cfg(), '/tmp/x');
    expect(o.networkAccessEnabled).toBe(false);
    expect(o.webSearchEnabled).toBe(false);
    expect(o.webSearchMode).toBe('disabled');
    expect(o.sandboxMode).toBe('read-only');
    expect(o.approvalPolicy).toBe('never');
    expect(o.modelReasoningEffort).toBe('medium');
  });
  it('enables web search live when configured', () => {
    const o = buildThreadOptions(cfg({ webSearchEnabled: true }), '/tmp/x');
    expect(o.webSearchEnabled).toBe(true);
    expect(o.webSearchMode).toBe('live');
  });
  it('rejects invalid approvalPolicy', () => {
    expect(() => buildThreadOptions(cfg({ approvalPolicy: 'bogus' }), '/tmp/x')).toThrow();
  });
  it('attaches additionalDirectories under workspace-write', () => {
    const o = buildThreadOptions(
      cfg({ sandboxMode: 'workspace-write', allowWorkspaceWrite: true, additionalDirectories: ['/Users/caster/work-bus'] }),
      '/tmp/x',
    );
    expect(o.sandboxMode).toBe('workspace-write');
    expect(o.additionalDirectories).toEqual(['/Users/caster/work-bus']);
  });
  it('omits additionalDirectories under read-only (inert without write access)', () => {
    // sandbox stays read-only (gate off) → extra writable roots would be meaningless
    const o = buildThreadOptions(
      cfg({ sandboxMode: 'workspace-write', additionalDirectories: ['/Users/caster/work-bus'] }),
      '/tmp/x',
    );
    expect(o.sandboxMode).toBe('read-only');
    expect(o.additionalDirectories).toBeUndefined();
  });
});

describe('summarizeItem redaction', () => {
  it('command_execution emits only the program name, never args or output', () => {
    const s = summarizeItem({
      id: '1',
      type: 'command_execution',
      command: '/usr/bin/git push --force origin main',
      aggregated_output: 'SECRET',
      status: 'completed',
    });
    // Only the program basename — args (which can carry secrets/paths) stripped.
    expect(s).toEqual({ name: 'command', detail: 'git' });
    expect(JSON.stringify(s)).not.toContain('SECRET');
    expect(JSON.stringify(s)).not.toContain('force');
  });
  it('file_change emits only basenames, never diff', () => {
    const s = summarizeItem({
      id: '1',
      type: 'file_change',
      changes: [{ path: 'src/secret/keys.ts', kind: 'update' }],
      status: 'completed',
    });
    expect(s).toEqual({ name: 'file_change', detail: 'keys.ts' });
  });
  it('caps long detail at MAX_TOOL_PARAM_CHARS', () => {
    const s = summarizeItem({
      id: '1',
      type: 'web_search',
      query: 'x'.repeat(MAX_TOOL_PARAM_CHARS + 50),
    });
    expect(s!.detail.length).toBeLessThanOrEqual(MAX_TOOL_PARAM_CHARS + 1); // +1 for ellipsis
  });
  it('returns null for agent_message (not a progress item)', () => {
    expect(summarizeItem({ id: '1', type: 'agent_message', text: 'hi' })).toBeNull();
  });
});

describe('queryAgent event mapping', () => {
  it('yields the final agent message and captures threadId', async () => {
    const seen: string[] = [];
    scriptedRuns = [async function* () {
      yield started('tid-1');
      yield msg('m1', 'hello world');
      yield turnDone;
    }];
    const out = await collect(
      queryAgent('hi', cfg(), undefined, undefined, {
        onSessionId: (id) => seen.push(id),
      }),
    );
    expect(out.join('')).toBe('hello world');
    expect(seen).toEqual(['tid-1']);
    expect(calls[0].kind).toBe('start');
  });

  it('reports redacted progress for command items, never the final body for them', async () => {
    const progress: Array<[string, unknown]> = [];
    scriptedRuns = [async function* () {
      yield started('tid');
      yield cmd('c1', 'rm -rf /tmp/x', 'started');
      yield cmd('c1', 'rm -rf /tmp/x', 'completed');
      yield msg('m1', 'done');
      yield turnDone;
    }];
    const out = await collect(
      queryAgent('hi', cfg(), undefined, (n, i) => progress.push([n, i])),
    );
    // The reply body is only the agent_message; command output never leaks.
    expect(out.join('')).toBe('done');
    expect(progress.some(([n]) => n === 'command')).toBe(true);
    expect(JSON.stringify(progress)).not.toContain('SECRET');
  });

  it('resumes when a resume id is given', async () => {
    scriptedRuns = [async function* () {
      yield started('tid');
      yield msg('m', 'resumed reply');
      yield turnDone;
    }];
    const out = await collect(
      queryAgent('hi', cfg(), undefined, undefined, { resume: 'old-tid' }),
    );
    expect(out.join('')).toBe('resumed reply');
    expect(calls[0]).toMatchObject({ kind: 'resume', resumeId: 'old-tid' });
  });

  it('throws on turn.failed', async () => {
    scriptedRuns = [async function* () {
      yield started('tid');
      yield { type: 'turn.failed', error: { message: 'boom' } };
    }];
    await expect(collect(queryAgent('hi', cfg()))).rejects.toThrow('boom');
  });

  it('throws on a stream-level error event', async () => {
    scriptedRuns = [async function* () {
      yield started('tid');
      yield { type: 'error', message: 'stream broke' };
    }];
    await expect(collect(queryAgent('hi', cfg()))).rejects.toThrow('stream broke');
  });

  it('throws on an ErrorItem (item.type=error) instead of producing no output', async () => {
    scriptedRuns = [async function* () {
      yield started('tid');
      yield { type: 'item.completed', item: { id: 'e1', type: 'error', message: 'tool blew up' } };
    }];
    await expect(collect(queryAgent('hi', cfg()))).rejects.toThrow('tool blew up');
  });

  it('handles item.updated as a snapshot overwrite for agent_message', async () => {
    scriptedRuns = [async function* () {
      yield started('tid');
      yield { type: 'item.updated', item: { id: 'm1', type: 'agent_message', text: 'partial' } };
      yield { type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: 'final full text' } };
      yield turnDone;
    }];
    // Same id → one message, last snapshot wins (no duplication).
    const out = await collect(queryAgent('hi', cfg()));
    expect(out).toEqual(['final full text']);
  });

  it('yields multiple distinct agent_messages in first-seen order', async () => {
    scriptedRuns = [async function* () {
      yield started('tid');
      yield msg('m1', 'first');
      yield msg('m2', 'second');
      yield turnDone;
    }];
    const out = await collect(queryAgent('hi', cfg()));
    expect(out).toEqual(['first', 'second']);
  });

  it('web_search is NOT a side effect — fresh-retry stays open after it', async () => {
    const cleared: boolean[] = [];
    scriptedRuns = [
      async function* () {
        yield started('tid');
        yield { type: 'item.completed', item: { id: 'w1', type: 'web_search', query: 'q' } };
        throw new Error('thread not found'); // stale resume AFTER a search
      },
      async function* () {
        yield started('new');
        yield msg('m', 'after-search recovery');
        yield turnDone;
      },
    ];
    const out = await collect(
      queryAgent('hi', cfg(), undefined, undefined, {
        resume: 'dead',
        onResumeFailed: () => cleared.push(true),
        fallbackRetryPrompt: 'h',
      }),
    );
    expect(out.join('')).toBe('after-search recovery');
    expect(cleared).toEqual([true]);
    expect(calls.length).toBe(2); // resumed, then fresh retry
  });

  it('force-downgrade on AGENTS.md refresh failure also strips additionalDirectories', async () => {
    scriptedRuns = [async function* () {
      yield started('tid');
      yield msg('m', 'ok');
      yield turnDone;
    }];
    // A cwd under a non-directory forces mkdirSync/writeFileSync to throw, so
    // writeAgentsMd returns false and this turn is forced to read-only.
    const c = cfg({
      sandboxMode: 'workspace-write',
      allowWorkspaceWrite: true,
      additionalDirectories: ['/Users/caster/work-bus'],
    });
    c.cwd = '/dev/null/ws';
    c.cwdBase = '/dev/null/ws';
    await collect(queryAgent('hi', c));
    // Downgraded to read-only AND the extra writable roots were dropped: a stale
    // AGENTS.md must never run with write access, including via lingering roots.
    expect(calls[0].opts?.sandboxMode).toBe('read-only');
    expect(calls[0].opts?.additionalDirectories).toBeUndefined();
  });
});

describe('isResumeError discrimination (via recovery behavior)', () => {
  // A non-stale error whose text merely contains "resume" must NOT trigger a
  // fresh retry (would drop a valid thread + re-hit upstream). We assert the
  // error propagates and no second run happens.
  it('does not treat a generic error containing the word "resume" as stale', async () => {
    const cleared: boolean[] = [];
    scriptedRuns = [async function* () {
      yield started('tid');
      throw new Error('rate limited while running codex exec resume');
    }];
    await expect(
      collect(
        queryAgent('hi', cfg(), undefined, undefined, {
          resume: 'valid-tid',
          onResumeFailed: () => cleared.push(true),
          fallbackRetryPrompt: 'h',
        }),
      ),
    ).rejects.toThrow('rate limited');
    expect(cleared).toEqual([]); // id NOT cleared
    expect(calls.length).toBe(1); // NO fresh retry
  });

  it('treats "thread not found" as stale and recovers', async () => {
    scriptedRuns = [
      async function* () {
        yield started('tid');
        throw new Error('thread not found: abc');
      },
      async function* () {
        yield started('new');
        yield msg('m', 'ok');
        yield turnDone;
      },
    ];
    const out = await collect(
      queryAgent('hi', cfg(), undefined, undefined, {
        resume: 'dead',
        fallbackRetryPrompt: 'h',
      }),
    );
    expect(out.join('')).toBe('ok');
    expect(calls.length).toBe(2);
  });
});

describe('queryAgent stale-resume recovery', () => {
  it('retries fresh (with fallback prompt) when resume fails before any side effect', async () => {
    const cleared: boolean[] = [];
    scriptedRuns = [
      // run 1: resume — fails immediately, no output/side-effect
      async function* () {
        yield started('tid');
        throw new Error('thread not found');
      },
      // run 2: fresh retry — succeeds
      async function* () {
        yield started('new-tid');
        yield msg('m', 'recovered');
        yield turnDone;
      },
    ];
    const out = await collect(
      queryAgent('hi', cfg(), undefined, undefined, {
        resume: 'dead',
        onResumeFailed: () => cleared.push(true),
        fallbackRetryPrompt: 'history + hi',
      }),
    );
    expect(out.join('')).toBe('recovered');
    expect(cleared).toEqual([true]);
    expect(calls[0]).toMatchObject({ kind: 'resume', resumeId: 'dead' });
    expect(calls[1]).toMatchObject({ kind: 'start' });
  });

  it('does NOT fresh-retry when a side effect already happened (avoids duplicate work)', async () => {
    const cleared: boolean[] = [];
    scriptedRuns = [
      async function* () {
        yield started('tid');
        yield cmd('c1', 'touch x', 'completed'); // side effect!
        throw new Error('thread not found');
      },
    ];
    await expect(
      collect(
        queryAgent('hi', cfg(), undefined, undefined, {
          resume: 'dead',
          onResumeFailed: () => cleared.push(true),
          fallbackRetryPrompt: 'history + hi',
        }),
      ),
    ).rejects.toThrow();
    // id is still cleared (so next turn starts fresh) but no fresh retry ran.
    expect(cleared).toEqual([true]);
    expect(calls.length).toBe(1);
  });
});
