import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createInterface } from 'node:readline';

// Paseo 0.15.2's generic ACP adapter initializes and immediately creates a
// session; it does not call authenticate. Grok's documented ACP flow requires
// that handshake first. Keep it inside this process, using only advertised
// noninteractive methods, without exposing credentials or changing host config.
const AUTH_TIMEOUT_MS = 30_000;
const SHUTDOWN_GRACE_MS = 2_000;
const AUTH_HELP = 'Run grok login or set XAI_API_KEY on the Paseo daemon host.';
type RpcMessage = {
  id?: string | number;
  method?: string;
  result?: { authMethods?: { id?: string }[] };
  error?: unknown;
};
type Initialization = {
  id: string | number;
  response?: string;
  authId?: string;
  released?: boolean;
  timer: ReturnType<typeof setTimeout>;
};

export async function runGrokAcpProcess(
  command: string,
  args: string[],
  transform: (message: unknown) => unknown,
) {
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'inherit'] });
  const state: { initialization: Initialization | null } = { initialization: null };
  const queued: { line: string; message: RpcMessage }[] = [];
  let inputClosed = false;
  let failed = false;
  let closed = false;
  let requestedSignal: NodeJS.Signals | null = null;
  let shutdownTimer: ReturnType<typeof setTimeout> | undefined;
  const stop = (signal: NodeJS.Signals = 'SIGTERM') => {
    if (closed) return;
    child.kill(signal);
    // Authentication deadlines must also bound a CLI that ignores SIGTERM.
    shutdownTimer ??= setTimeout(() => { if (!closed) child.kill('SIGKILL'); }, SHUTDOWN_GRACE_MS);
  };

  const fail = (reason: string) => {
    if (failed || requestedSignal) return;
    failed = true;
    process.exitCode = 1;
    console.error(`SLP Grok: ${reason}`);
    if (state.initialization) {
      clearTimeout(state.initialization.timer);
      // Surface a bounded, actionable initialization failure to Paseo as well
      // as stderr. Never echo Grok's authentication error payload or tokens.
      if (!state.initialization.released) {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: state.initialization.id,
          error: { code: -32000, message: reason } }) + '\n');
      }
      state.initialization = null;
    }
    queued.length = 0;
    stop();
    process.stdin.destroy();
  };
  child.on('error', () => fail('Could not start the Grok executable. Check SLP_GROK_BIN and PATH.'));
  child.stdin.on('error', () => fail('Grok closed its ACP input unexpectedly.'));
  const finished = new Promise<void>(resolve => {
    child.on('close', (code, signal) => {
      closed = true;
      clearTimeout(shutdownTimer);
      if (state.initialization) fail(`Grok exited before initialization/authentication completed. ${AUTH_HELP}`);
      if (!failed) process.exitCode = code ?? ((requestedSignal ?? signal) === 'SIGINT' ? 130 : 143);
      process.stdin.destroy();
      resolve();
    });
  });
  const signals = (['SIGINT', 'SIGTERM', 'SIGHUP'] as const).map(signal => {
    const handler = () => {
      requestedSignal = signal;
      if (state.initialization) clearTimeout(state.initialization.timer);
      state.initialization = null;
      queued.length = 0;
      process.stdin.destroy();
      stop(signal);
    };
    process.on(signal, handler);
    return { signal, handler };
  });

  const send = async (line: string) => {
    if (!failed && !child.stdin.write(line + '\n')) await once(child.stdin, 'drain');
  };
  const forward = async (line: string) => {
    if (!failed && !process.stdout.write(line + '\n')) await once(process.stdout, 'drain');
  };
  const deliver = async (line: string, message: RpcMessage) => {
    const next = transform(message);
    await send(next === message ? line : JSON.stringify(next));
  };
  const endInput = () => {
    if (inputClosed && !state.initialization && !failed) child.stdin.end();
  };
  const ready = async (line: string) => {
    if (state.initialization) {
      clearTimeout(state.initialization.timer);
      state.initialization.released = true;
    }
    clearTimeout(shutdownTimer);
    await forward(line);
    // Hold pipelined session requests until authentication succeeds. Keep the
    // gate in place while draining so newly arriving requests retain order.
    while (queued.length && !failed) {
      const frame = queued.shift()!;
      await deliver(frame.line, frame.message);
    }
    state.initialization = null;
    endInput();
  };

  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const output = createInterface({ input: child.stdout, crlfDelay: Infinity });
  try {
    await Promise.all([
      (async () => {
        try {
          for await (const line of input) {
            if (failed) break;
            if (!line.trim()) continue;
            let message: RpcMessage;
            try { message = JSON.parse(line); }
            catch { fail('Invalid JSON in an ACP client request.'); break; }
            if (message?.method === 'initialize') {
              if (state.initialization || !['string', 'number'].includes(typeof message.id)) {
                fail('Invalid or overlapping ACP initialize request.'); break;
              }
              state.initialization = { id: message.id!, timer: setTimeout(() => {
                fail(`Grok initialization/authentication timed out. ${AUTH_HELP}`);
              }, AUTH_TIMEOUT_MS) };
              await send(line);
            } else if (state.initialization && typeof message?.method === 'string') {
              queued.push({ line, message });
            } else {
              // Client replies to server requests are never held behind the
              // initialization gate; Grok may need them to finish startup.
              await deliver(line, message);
            }
          }
          inputClosed = true;
          endInput();
        } catch (error) {
          if (!failed) fail(error instanceof Error ? error.message : 'ACP request processing failed.');
        }
      })(),
      (async () => {
        try {
          for await (const line of output) {
            if (failed) break;
            if (!line.trim()) continue;
            let message: RpcMessage;
            try { message = JSON.parse(line); }
            catch { fail('Grok returned invalid ACP JSON.'); break; }
            const pending = state.initialization;
            const response = message !== null && typeof message === 'object' && !message.method;
            if (pending && response && message.id === pending.id && pending.response === undefined) {
              if (Object.hasOwn(message, 'error') || message.result === null || typeof message.result !== 'object') {
                fail(`Grok initialization failed. ${AUTH_HELP}`); break;
              }
              const methods = message.result.authMethods;
              if (methods === undefined || (Array.isArray(methods) && methods.length === 0)) {
                await ready(line);
                continue;
              }
              if (!Array.isArray(methods)) {
                fail('Grok returned invalid ACP authentication methods.'); break;
              }
              const ids = new Set(methods.map(method => method?.id));
              const methodId = process.env.XAI_API_KEY?.trim() && ids.has('xai.api_key')
                ? 'xai.api_key' : ids.has('cached_token') ? 'cached_token' : null;
              if (!methodId) {
                fail(`Grok offers no usable noninteractive authentication method. ${AUTH_HELP}`); break;
              }
              pending.response = line;
              pending.authId = `slp-grok-auth:${randomUUID()}`;
              await send(JSON.stringify({ jsonrpc: '2.0', id: pending.authId, method: 'authenticate',
                params: { methodId, _meta: { headless: true } } }));
            } else if (pending?.authId && response && message.id === pending.authId) {
              if (Object.hasOwn(message, 'error') || !Object.hasOwn(message, 'result')) {
                fail(`Grok authentication failed. ${AUTH_HELP}`); break;
              }
              await ready(pending.response!);
            } else {
              await forward(line);
            }
          }
          if (state.initialization && !failed) fail(`Grok closed ACP before authentication completed. ${AUTH_HELP}`);
        } catch {
          if (!failed) fail('Grok ACP response processing failed.');
        }
      })(),
      finished,
    ]);
  } finally {
    if (state.initialization) clearTimeout(state.initialization.timer);
    input.close();
    output.close();
    for (const { signal, handler } of signals) process.off(signal, handler);
  }
}
