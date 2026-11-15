import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { install } from '../plugin/server/runtime/cli/package.ts';
import { createExecutableResolver } from '../plugin/server/executables.ts';
import { createLauncherBuilder } from '../plugin/server/launchers.ts';
import { createRoleInjection } from '../plugin/server/role-injection.ts';
import { FAMILY_IDS } from '../plugin/shared/runtime/families.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const version = 'grok 0.1.0-fixture';
const apiKey = 'fixture-xai-key-not-a-real-credential';
const locators = 'Policy locators — relative to Directory;';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'slp-grok-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const candidate = join(dir, 'candidate');
  const { candidate: identity } = install(root, candidate);
  return {
    dir, candidate, sha: identity.sha256, home: join(dir, 'home'),
    binary: join(dir, 'grok'), capture: join(dir, 'capture.json'), trace: join(dir, 'trace.jsonl'),
  };
}

const envFor = f => ({
  HOME: f.dir, PATH: '/usr/bin:/bin', PASEO_HOME: f.home,
  SLP_GROK_BIN: f.binary, GROK_TEST_CAPTURE: f.capture, GROK_TEST_TRACE: f.trace,
});
const managedEnv = f => ({
  SLP_MANAGED_RUNTIME: '1', PASEO_AGENT_ID: 'fixture-agent',
  SLP_RUNTIME_ROOT: f.candidate, SLP_NODE_BIN: process.execPath, SLP_DAEMON_HOME: f.home,
});
const prompt = (sessionId = 'session', id = 3) => ({
  jsonrpc: '2.0', id, method: 'session/prompt',
  params: { sessionId, prompt: [{ type: 'text', text: 'Inspect the fixture only.' }], fixtureField: 'preserve' },
});
const inputLines = frames => frames.map(frame => typeof frame === 'string' ? frame : JSON.stringify(frame)).join('\n') + '\n';
const outputFrames = out => out.stdout.trim() ? out.stdout.trim().split('\n').map(line => JSON.parse(line)) : [];
const readTrace = f => existsSync(f.trace) ? readFileSync(f.trace, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];

function run(f, { args = [], input = '', role = 'peer', env = {} } = {}) {
  return spawnSync(process.execPath, [join(f.candidate, 'bin/grok-role.mjs'), role, ...args], {
    input, encoding: 'utf8', timeout: 10000, maxBuffer: 4 * 1024 * 1024,
    env: { ...envFor(f), ...env },
  });
}

// This child records real process arguments/environment and echoes exactly the
// bytes the installed wrapper gives it. It has no API or account access.
function echoCli(f) {
  writeFileSync(f.binary, `#!${process.execPath}
const { readFileSync, writeFileSync } = require('node:fs');
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--version') {
  if (process.env.GROK_TEST_VERSION_CAPTURE === '1') writeFileSync(process.env.GROK_TEST_CAPTURE, JSON.stringify({ grantPresent: Object.hasOwn(process.env, 'SLP_SESSION_OPEN_GRANT') }));
  process.stdout.write(${JSON.stringify(version)} + '\\n');
  if (process.env.GROK_TEST_VERSION_STDERR) process.stderr.write(process.env.GROK_TEST_VERSION_STDERR + '\\n');
  process.exit(Number(process.env.GROK_TEST_VERSION_EXIT || 0));
}
writeFileSync(process.env.GROK_TEST_CAPTURE, JSON.stringify({
  args,
  keep: process.env.KEEP,
  apiKey: process.env.XAI_API_KEY,
  grantPresent: Object.hasOwn(process.env, 'SLP_SESSION_OPEN_GRANT'),
  nodeOptionsPresent: Object.hasOwn(process.env, 'NODE_OPTIONS'),
  home: process.env.PASEO_HOME,
  runtime: process.env.SLP_RUNTIME_ROOT,
}));
if (process.env.GROK_TEST_EXIT) process.exit(Number(process.env.GROK_TEST_EXIT));
process.stdout.write(readFileSync(0, 'utf8'));
`, { mode: 0o755 });
}

// A small bidirectional ACP fixture exercises the actual wrapper process.
// Replies retain the host IDs, while authenticate is an internal request.
function acpCli(f) {
  writeFileSync(f.binary, `#!${process.execPath}
const { appendFileSync } = require('node:fs');
const { createInterface } = require('node:readline');
const reply = (id, payload) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, ...payload }) + '\\n');
createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  appendFileSync(process.env.GROK_TEST_TRACE, JSON.stringify(message) + '\\n');
  if (message.method === 'initialize') {
    const result = { protocolVersion: 1, agentCapabilities: { loadSession: true }, fixtureField: 'preserve' };
    if (process.env.GROK_TEST_AUTH_METHODS !== 'omit') result.authMethods = JSON.parse(process.env.GROK_TEST_AUTH_METHODS || '[]');
    reply(message.id, { result });
  } else if (message.method === 'authenticate') {
    if (process.env.GROK_TEST_AUTH_ERROR === '1') {
      reply(message.id, { error: { code: -32000, message: 'Provider rejected credential ' + process.env.XAI_API_KEY } });
    } else {
      reply(message.id, { result: {} });
    }
  } else if (message.method === 'session/new') {
    reply(message.id, { result: { sessionId: 'session' } });
  } else if (message.method === 'session/prompt') {
    reply(message.id, { result: { stopReason: 'end_turn' } });
  } else if (Object.hasOwn(message, 'id')) {
    reply(message.id, { result: {} });
  }
});
`, { mode: 0o755 });
}

const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } };
const newSession = { jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: '/fixture', mcpServers: [] } };
const authMethods = [{ id: 'xai.api_key', name: 'API key' }, { id: 'cached_token', name: 'Cached login' }];
const queuedSession = () => inputLines([initialize, newSession, prompt()]);

test('Grok uses ACP with automatic updates disabled and preserves explicit options and runtime credentials', t => {
  const f = fixture(t); echoCli(f);
  for (const args of [[], ['agent', 'stdio', '--model', 'fixture/model']]) {
    const out = run(f, { args, input: inputLines([prompt()]), env: { KEEP: 'user-env', XAI_API_KEY: apiKey, SLP_SESSION_OPEN_GRANT: 'must-be-consumed' } });
    assert.equal(out.status, 0, out.stderr);
    const capture = JSON.parse(readFileSync(f.capture, 'utf8'));
    assert.deepEqual(capture.args, ['--no-auto-update', ...(args.length ? args : ['agent', 'stdio'])]);
    assert.equal(capture.keep, 'user-env');
    assert.equal(capture.apiKey, apiKey);
    assert.equal(capture.grantPresent, false, 'an open grant must never reach the Grok child');
    assert.ok(!out.stdout.includes(apiKey), 'credentials stay out of role instructions');
    assert.ok(!out.stderr.includes(apiKey));
  }
});

test('Grok entry policy is role-specific, repeats core on every prompt, and rearms independently after session lifecycle requests', t => {
  const f = fixture(t); echoCli(f);
  for (const role of ['supervisor', 'lead', 'peer']) {
    const first = prompt('a');
    first.params.prompt.push({ type: 'resource_link', uri: 'file:///fixture/input.txt', name: 'input.txt' });
    const frames = [first, prompt('a'), prompt('b')];
    for (const method of ['session/load', 'session/resume', 'session/fork']) {
      frames.push({ jsonrpc: '2.0', id: 4, method, params: { sessionId: 'a', cwd: f.dir, mcpServers: [] } }, prompt('a'), prompt('b'));
    }
    const out = run(f, { role, input: inputLines(frames) });
    assert.equal(out.status, 0, out.stderr);
    const received = outputFrames(out);
    assert.equal(received.length, frames.length);
    for (const [i, frame] of frames.entries()) {
      if (frame.method !== 'session/prompt') {
        assert.deepEqual(received[i], frame);
        continue;
      }
      const transformed = received[i];
      assert.deepEqual({ ...transformed, params: { ...transformed.params, prompt: transformed.params.prompt.slice(1) } }, frame);
      const policy = transformed.params.prompt[0];
      assert.equal(policy.type, 'text');
      assert.ok(policy.text.startsWith(`SLP role=${role}\n`));
      assert.ok(policy.text.includes('Human authority is the ceiling'));
      const entry = i === 0 || i === 2 || (i >= 4 && i % 3 === 1);
      assert.equal(policy.text.includes(locators), entry, `${role} frame ${i} entry/re-anchor policy`);
    }
  }
});

test('Grok passes non-prompt ACP requests and client replies through byte-for-byte', t => {
  const f = fixture(t); echoCli(f);
  const frames = [
    '{ "jsonrpc": "2.0", "id": 11, "method": "authenticate", "params": { "methodId": "cached_token", "_meta": { "headless": true } } }',
    '{ "jsonrpc": "2.0", "id": 12, "method": "session/new", "params": { "cwd": "/fixture", "mcpServers": [{ "name": "tools", "command": "/bin/true", "args": [], "env": [] }] } }',
    '{ "jsonrpc": "2.0", "id": 13, "method": "session/set_model", "params": { "sessionId": "s", "modelId": "fixture/model" } }',
    '{ "jsonrpc": "2.0", "id": 14, "method": "session/set_mode", "params": { "sessionId": "s", "modeId": "plan" } }',
    '{ "jsonrpc": "2.0", "id": 15, "method": "session/set_config_option", "params": { "sessionId": "s", "configId": "effort", "value": "high" } }',
    '{ "jsonrpc": "2.0", "method": "session/cancel", "params": { "sessionId": "s" } }',
    '{ "jsonrpc": "2.0", "id": "permission", "result": { "outcome": { "outcome": "cancelled" } } }',
  ];
  const out = run(f, { input: inputLines(frames) });
  assert.equal(out.status, 0, out.stderr);
  assert.equal(out.stdout, inputLines(frames));
});

test('Grok version probes preserve output and status; unsupported commands fail before starting the child', t => {
  const f = fixture(t); echoCli(f);
  const probe = run(f, { args: ['--version'], env: { ...managedEnv(f), GROK_TEST_VERSION_EXIT: '7', GROK_TEST_VERSION_STDERR: 'version diagnostic' } });
  assert.equal(probe.status, 7, probe.stderr);
  assert.equal(probe.stdout, `${version}\n`);
  assert.equal(probe.stderr, 'version diagnostic\n');
  assert.equal(existsSync(f.capture), false);
  for (const args of [['acp'], ['agent'], ['agent', 'http'], ['login'], ['-p', 'task']]) {
    const out = run(f, { args });
    assert.equal(out.status, 1, JSON.stringify(args));
    assert.match(out.stderr, /ACP|agent stdio/);
    assert.equal(existsSync(f.capture), false, `${args.join(' ')} must not start a child`);
  }
});

test('Grok fails on malformed prompts and modified installed policy, and forwards a child exit status', t => {
  const f = fixture(t); echoCli(f);
  for (const frame of [
    { jsonrpc: '2.0', id: 1, method: 'session/prompt', params: { prompt: [] } },
    { jsonrpc: '2.0', id: 1, method: 'session/prompt', params: { sessionId: 's', prompt: 'wrong' } },
  ]) {
    const out = run(f, { input: inputLines([frame]) });
    assert.equal(out.status, 1);
    assert.match(out.stderr, /Malformed session\/prompt/);
    assert.equal(out.stdout, '');
  }
  const exited = run(f, { env: { GROK_TEST_EXIT: '9' } });
  assert.equal(exited.status, 9, exited.stderr);
  rmSync(f.capture, { force: true });
  writeFileSync(join(f.candidate, 'src/common.md'), 'changed after installation');
  const tampered = run(f, { input: inputLines([prompt()]) });
  assert.equal(tampered.status, 1);
  assert.match(tampered.stderr, /Installed candidate changed/);
  assert.equal(existsSync(f.capture), false);
});

test('Grok authenticates an advertised noninteractive method before releasing initialization and queued session traffic', t => {
  const f = fixture(t); acpCli(f);
  const cases = [
    { key: apiKey, offered: authMethods, selected: 'xai.api_key' },
    { key: '', offered: authMethods, selected: 'cached_token' },
    { key: apiKey, offered: [authMethods[1]], selected: 'cached_token' },
  ];
  for (const { key, offered, selected } of cases) {
    rmSync(f.trace, { force: true });
    const out = run(f, { input: queuedSession(), env: { XAI_API_KEY: key, GROK_TEST_AUTH_METHODS: JSON.stringify(offered) } });
    assert.equal(out.status, 0, out.stderr);
    const trace = readTrace(f);
    assert.deepEqual(trace.map(frame => frame.method), ['initialize', 'authenticate', 'session/new', 'session/prompt']);
    assert.deepEqual(trace[0], initialize);
    assert.equal(trace[1].params.methodId, selected);
    assert.equal(trace[1].params._meta.headless, true);
    assert.ok(![initialize.id, newSession.id, prompt().id].includes(trace[1].id), 'internal authentication must not reuse a host request ID');
    assert.ok(!JSON.stringify(trace[1]).includes(apiKey), 'the auth request selects a method without copying the key into RPC');
    assert.deepEqual(trace[2], newSession);
    assert.ok(trace[3].params.prompt[0].text.startsWith('SLP role=peer\n'));
    assert.deepEqual(trace[3].params.prompt.slice(1), prompt().params.prompt);
    const received = outputFrames(out);
    assert.deepEqual(received.map(frame => frame.id), [1, 2, 3], 'internal auth response stays hidden from Paseo');
    assert.deepEqual(received[0], { jsonrpc: '2.0', id: 1, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, fixtureField: 'preserve', authMethods: offered } });
    assert.deepEqual(received[1].result, { sessionId: 'session' });
    assert.deepEqual(received[2].result, { stopReason: 'end_turn' });
    assert.ok(!out.stdout.includes(apiKey));
    assert.ok(!out.stderr.includes(apiKey));
  }
});

test('Grok forwards initialization without an authentication exchange when the CLI advertises none', t => {
  const f = fixture(t); acpCli(f);
  for (const offered of ['omit', '[]']) {
    rmSync(f.trace, { force: true });
    const out = run(f, { input: queuedSession(), env: { XAI_API_KEY: apiKey, GROK_TEST_AUTH_METHODS: offered } });
    assert.equal(out.status, 0, out.stderr);
    assert.deepEqual(readTrace(f).map(frame => frame.method), ['initialize', 'session/new', 'session/prompt']);
    const received = outputFrames(out);
    assert.deepEqual(received.map(frame => frame.id), [1, 2, 3]);
    assert.equal(Object.hasOwn(received[0].result, 'authMethods'), offered !== 'omit');
  }
});

test('Grok rejects a queued malformed prompt without replying to initialize twice', t => {
  const f = fixture(t); acpCli(f);
  const malformed = { jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { sessionId: 'session', prompt: 'not an array' } };
  const out = run(f, {
    input: inputLines([initialize, malformed]),
    env: { XAI_API_KEY: apiKey, GROK_TEST_AUTH_METHODS: JSON.stringify(authMethods) },
  });
  assert.equal(out.error, undefined, 'a queued prompt error must terminate without hanging');
  assert.notEqual(out.status, 0);
  assert.deepEqual(readTrace(f).map(frame => frame.method), ['initialize', 'authenticate']);
  const received = outputFrames(out);
  assert.equal(received.filter(frame => frame.id === initialize.id).length, 1, 'a completed initialize request must never receive a second error response');
  assert.equal(received[0].result.protocolVersion, 1);
  assert.ok(!out.stdout.includes(apiKey));
  assert.ok(!out.stderr.includes(apiKey));
});

test('Grok authentication failures and interactive-only methods never release queued work or print credentials', t => {
  const f = fixture(t); acpCli(f);
  const cases = [
    { methods: authMethods, key: apiKey, error: '1', expected: ['initialize', 'authenticate'] },
    { methods: [{ id: 'browser_login', name: 'Interactive browser login' }], key: apiKey, error: '0', expected: ['initialize'] },
    { methods: [authMethods[0]], key: '', error: '0', expected: ['initialize'] },
  ];
  for (const { methods, key, error, expected } of cases) {
    rmSync(f.trace, { force: true });
    const out = run(f, { input: queuedSession(), env: { XAI_API_KEY: key, GROK_TEST_AUTH_METHODS: JSON.stringify(methods), GROK_TEST_AUTH_ERROR: error } });
    assert.equal(out.error, undefined, 'failed authentication must terminate instead of hanging');
    assert.notEqual(out.status, 0);
    assert.deepEqual(readTrace(f).map(frame => frame.method), expected);
    assert.ok(outputFrames(out).every(frame => !frame.result), 'no successful initialize or session result may escape');
    assert.match(out.stderr + out.stdout, /grok login|XAI_API_KEY/);
    assert.ok(!out.stdout.includes(apiKey));
    assert.ok(!out.stderr.includes(apiKey), 'raw provider auth errors may contain credentials');
  }
});

test('Grok authentication failure terminates a child that ignores SIGTERM without releasing queued work', async t => {
  const f = fixture(t);
  const pidPath = join(f.dir, 'child.pid');
  writeFileSync(f.binary, `#!${process.execPath}
const { appendFileSync, writeFileSync } = require('node:fs');
const { createInterface } = require('node:readline');
writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);
const reply = (id, payload) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, ...payload }) + '\\n');
createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  appendFileSync(process.env.GROK_TEST_TRACE, JSON.stringify(message) + '\\n');
  if (message.method === 'initialize') reply(message.id, { result: { protocolVersion: 1, authMethods: [{ id: 'xai.api_key', name: 'API key' }] } });
  if (message.method === 'authenticate') reply(message.id, { error: { code: -32000, message: 'Fixture authentication refused' } });
});
`, { mode: 0o755 });
  const wrapper = spawn(process.execPath, [join(f.candidate, 'bin/grok-role.mjs'), 'peer'], {
    env: { ...envFor(f), XAI_API_KEY: apiKey }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '', expired = false, childPid;
  wrapper.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  wrapper.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const cleanup = () => {
    if (childPid === undefined && existsSync(pidPath)) childPid = Number(readFileSync(pidPath, 'utf8'));
    if (Number.isInteger(childPid) && childPid > 0) {
      try { process.kill(childPid, 'SIGKILL'); } catch { /* fixture already reaped */ }
    }
    if (wrapper.exitCode === null && wrapper.signalCode === null) wrapper.kill('SIGKILL');
  };
  try {
    const result = await new Promise((resolve, reject) => {
      // Kill both tracked processes on regression: a direct-child timeout
      // alone would leave the fake CLI holding inherited descriptors open.
      const timer = setTimeout(() => { expired = true; cleanup(); }, 6000);
      wrapper.on('error', error => { clearTimeout(timer); reject(error); });
      wrapper.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
      wrapper.stdin.end(queuedSession());
    });
    assert.equal(expired, false, 'authentication failure must escalate termination within the bounded grace period');
    assert.notEqual(result.code, 0, stderr);
    assert.equal(result.signal, null, 'the wrapper must finish its own cleanup instead of being killed by the test');
    assert.deepEqual(readTrace(f).map(frame => frame.method), ['initialize', 'authenticate']);
    assert.ok(outputFrames({ stdout }).every(frame => !frame.result));
    assert.match(stderr, /authentication failed/);
  } finally {
    cleanup();
  }
});

test('Grok is discovered from PATH by its actual version probe, and failed explicit probes cannot activate it', async t => {
  const f = fixture(t); echoCli(f);
  const request = { daemonHome: f.home, stableRoot: join(f.home, 'slp-runtime'), nodePath: process.execPath };
  const resolver = createExecutableResolver({ env: { ...envFor(f), PATH: f.dir } });
  const discovered = await resolver.resolve(request);
  assert.deepEqual(discovered.binaries.grok, { available: true, path: f.binary, version });
  const unavailable = createExecutableResolver({ env: { ...envFor(f), PATH: f.dir, GROK_TEST_VERSION_EXIT: '1' } });
  assert.equal((await unavailable.resolve(request)).binaries.grok.available, false);
  await assert.rejects(unavailable.resolve({ ...request, binaries: { grok: f.binary } }), /grok|version probe/);
});

test('Grok managed launchers require a live grant, freeze the verified executable, and deliver policy for all three roles', async t => {
  const f = fixture(t); echoCli(f);
  const stableRoot = join(f.home, 'slp-runtime');
  const installed = join(stableRoot, f.sha); install(root, installed);
  const binaries = Object.fromEntries(FAMILY_IDS.map(id => [id, id === 'grok'
    ? { available: true, path: f.binary, version }
    : { available: false, path: null, version: null }]));
  const set = await createLauncherBuilder().publish({
    daemonHome: f.home, stableRoot, operationId: 'grok-grant-proof',
    candidate: { sha256: f.sha, runtimePath: installed },
    node: { path: process.execPath, version: process.versions.node }, binaries,
  });
  for (const role of ['supervisor', 'lead', 'peer']) {
    const launcher = join(set.directory, `slp-grok-${role}`);
    const invoke = (extra = {}, args = []) => spawnSync(launcher, args, {
      input: inputLines([prompt()]), encoding: 'utf8', timeout: 10000, maxBuffer: 4 * 1024 * 1024,
      env: { ...envFor(f), PASEO_AGENT_ID: 'fixture-agent', KEEP: 'user-env', ...extra },
    });
    rmSync(f.capture, { force: true });
    for (const grant of [undefined, '']) {
      const denied = invoke(grant === undefined ? {} : { SLP_SESSION_OPEN_GRANT: grant });
      assert.equal(denied.status, 1);
      assert.match(denied.stderr, /without live SLP hook grant/);
      assert.equal(existsSync(f.capture), false);
    }
    const probe = invoke({}, ['--version']);
    assert.equal(probe.status, 0, probe.stderr);
    assert.equal(probe.stdout, `${version}\n`);
    assert.equal(existsSync(f.capture), false);
    const grantedProbe = invoke({ SLP_SESSION_OPEN_GRANT: 'probe-grant', GROK_TEST_VERSION_CAPTURE: '1' }, ['--version']);
    assert.equal(grantedProbe.status, 0, grantedProbe.stderr);
    assert.equal(grantedProbe.stdout, `${version}\n`);
    assert.equal(JSON.parse(readFileSync(f.capture, 'utf8')).grantPresent, false, 'the shim version path must consume a grant before its child starts');
    const allowed = invoke({
      SLP_SESSION_OPEN_GRANT: 'live-grant', SLP_GROK_BIN: '/missing/poisoned-grok',
      SLP_RUNTIME_ROOT: '/missing/poisoned-runtime', PASEO_HOME: '/missing/poisoned-home',
      NODE_OPTIONS: '--require /missing/injected-module',
    });
    assert.equal(allowed.status, 0, allowed.stderr);
    const capture = JSON.parse(readFileSync(f.capture, 'utf8'));
    assert.deepEqual(capture.args, ['--no-auto-update', 'agent', 'stdio']);
    assert.equal(capture.grantPresent, false);
    assert.equal(capture.nodeOptionsPresent, false);
    assert.equal(capture.home, f.home);
    assert.equal(capture.runtime, installed);
    assert.equal(capture.keep, 'user-env');
    const received = outputFrames(allowed)[0];
    assert.ok(received.params.prompt[0].text.startsWith(`SLP role=${role}\n`));
    assert.ok(received.params.prompt[0].text.includes(installed));
    assert.deepEqual(received.params.prompt.slice(1), prompt().params.prompt);
  }
});

test('Grok uses the wrapper role boundary and receives fresh managed grants for every open reason', async t => {
  const f = fixture(t);
  const injection = createRoleInjection({
    readActiveBinding: () => ({ candidateSha256: f.sha, payloadSha256: 'a'.repeat(64), runtimePath: f.candidate, nodePath: process.execPath, daemonHome: f.home }),
    verifyCandidate: async () => {}, deskMint: async () => ({ handle: 'a'.repeat(64) }),
  });
  for (const role of ['supervisor', 'lead', 'peer']) {
    const config = {
      provider: `slp-grok-${role}`, cwd: f.dir, model: 'fixture/model', modeId: 'plan', thinkingOptionId: 'high',
      featureValues: { preserve: true }, providerOptions: { custom: 'keep' }, systemPrompt: 'Human instructions',
      mcpServers: { existing: { type: 'stdio', command: '/bin/true' } },
    };
    const created = await injection.agentCreate({ request: { config, env: { KEEP: 'user-env' } } });
    assert.deepEqual(created.config, config, 'the wrapper owns policy delivery without changing host settings or MCP');
    assert.deepEqual(created.env, { KEEP: 'user-env', SLP_DESK_HANDLE: 'a'.repeat(64) });
    for (const reason of ['create', 'resume', 'refresh', 'import']) {
      const opened = injection.sessionOpen({ request: { provider: config.provider, cwd: f.dir, agentId: 'fixture-agent', workspaceId: 'fixture-workspace', reason, purpose: 'interactive', env: { KEEP: 'user-env', SLP_SESSION_OPEN_GRANT: '' } } });
      assert.equal(opened.env.KEEP, 'user-env');
      assert.ok(opened.env.SLP_SESSION_OPEN_GRANT.length > 0);
    }
  }
});
