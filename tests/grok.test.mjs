import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, writeFileSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { install } from '../plugin/server/runtime/cli/package.ts';
import { createExecutableResolver } from '../plugin/server/executables.ts';
import { createLauncherBuilder } from '../plugin/server/launchers.ts';
import { FAMILY_IDS } from '../plugin/shared/runtime/families.ts';
import { supportsGrokVersion } from '../plugin/shared/runtime/grok-version.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
function fixture(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'slp-grok-test-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const candidate = join(dir, 'candidate');
  const { candidate: identity } = install(root, candidate);
  return { dir, candidate, sha: identity.sha256 };
}
const envFor = f => ({ HOME: f.dir, PATH: '/usr/bin:/bin', PASEO_HOME: join(f.dir, 'home') });

test('Grok version selection accepts the catalog floor and observed banner, and refuses older or malformed output', () => {
  for (const version of [
    'grok 1.0.77 (50ca579fa996) [stable]',
    'grok v1.0.77',
    '0.2.11',
    'grok 9.9.9-fake',
    'grok 2.0.24',
    'grok 2.0.25',
  ]) assert.equal(supportsGrokVersion(version), true, version);
  for (const version of ['0.2.10', 'grok development', 'not-grok 1.0.77', '1.0', 'grok 1.0.77\nnoise']) {
    assert.equal(supportsGrokVersion(version), false, version);
  }
});

test('standalone Grok prepends role bytes on session/prompt and keeps other frames', t => {
  const f = fixture(t);
  const fake = join(f.dir, 'grok');
  writeFileSync(fake, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "grok 1.0.77 (50ca579fa996) [stable]"; exit 0; fi\ncat\n', { mode: 0o755 });
  const initialize = '{ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": 1 } }';
  const prompt = { jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { sessionId: 's', prompt: [{ type: 'text', text: 'task' }] } };
  const out = spawnSync(process.execPath, [join(f.candidate, 'bin/grok-role.mjs'), 'peer'], {
    input: [initialize, JSON.stringify(prompt)].join('\n'),
    encoding: 'utf8',
    timeout: 10000,
    env: { ...envFor(f), SLP_GROK_BIN: fake },
  });
  assert.equal(out.status, 0, out.stderr);
  const lines = out.stdout.trim().split('\n');
  assert.equal(lines[0], initialize);
  const framed = JSON.parse(lines[1]);
  assert.ok(framed.params.prompt[0].text.includes('Human authority is the ceiling'));
  assert.deepEqual(framed.params.prompt[1], prompt.params.prompt[0]);
});

test('standalone Grok accepts only agent stdio, probes version before spawn, and preserves a version probe', t => {
  const f = fixture(t);
  const fake = join(f.dir, 'grok');
  const marker = join(f.dir, 'spawned');
  writeFileSync(fake, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "grok 1.0.77 (50ca579fa996) [stable]:$KEEP"; echo diagnostic >&2; exit 7; fi\necho "$@:$KEEP" > '${marker}'\n`, { mode: 0o755 });
  const run = args => spawnSync(process.execPath, [join(f.candidate, 'bin/grok-role.mjs'), 'peer', ...args], {
    encoding: 'utf8', timeout: 10000, env: { ...envFor(f), KEEP: 'env-kept', SLP_GROK_BIN: fake },
  });
  const probe = run(['--version']);
  assert.equal(probe.status, 7);
  assert.equal(probe.stdout, 'grok 1.0.77 (50ca579fa996) [stable]:env-kept\n');
  assert.equal(probe.stderr, 'diagnostic\n');
  assert.equal(existsSync(marker), false);
  for (const args of [['serve'], ['headless'], ['agent'], ['agent', 'stdio', 'extra']]) {
    const refused = run(args);
    assert.equal(refused.status, 1, args.join(' '));
    assert.match(refused.stderr, /supports only `grok agent stdio`/);
    assert.equal(existsSync(marker), false);
  }
  writeFileSync(fake, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "grok 1.0.77 (50ca579fa996) [stable]"; exit 0; fi\necho "$@:$KEEP" > '${marker}'\n`, { mode: 0o755 });
  const launched = run([]);
  assert.equal(launched.status, 0, launched.stderr);
  assert.equal(readFileSync(marker, 'utf8'), 'agent stdio:env-kept\n');
  rmSync(marker);
  for (const version of ['0.2.10', 'grok development', 'garbage']) {
    writeFileSync(fake, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo '${version}'; exit 0; fi\ntouch '${marker}'\n`, { mode: 0o755 });
    const out = run([]);
    assert.equal(out.status, 1, version);
    assert.match(out.stderr, /executable version was not verified/);
    assert.equal(existsSync(marker), false);
  }
});

test('managed Grok shim requires a live grant, consumes it, and refuses an unverified executable', async t => {
  const f = fixture(t);
  const fake = join(f.dir, 'grok');
  const marker = join(f.dir, 'spawned');
  const writeBinary = version => writeFileSync(fake, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo '${version}'; exit 0; fi\necho "$@:$KEEP:$SLP_SESSION_OPEN_GRANT" > '${marker}'\ncat\n`, { mode: 0o755 });
  writeBinary('grok 1.0.77 (50ca579fa996) [stable]');
  const home = join(f.dir, 'home');
  const stableRoot = join(home, 'slp-runtime');
  const installed = join(stableRoot, f.sha);
  install(root, installed);
  const binaries = Object.fromEntries(FAMILY_IDS.map(id => [id, id === 'grok'
    ? { available: true, path: fake, version: 'grok 1.0.77 (50ca579fa996) [stable]' }
    : { available: false, path: null, version: null }]));
  const set = await createLauncherBuilder().publish({
    daemonHome: home,
    stableRoot,
    operationId: 'grok-grant-proof',
    candidate: { sha256: f.sha, runtimePath: installed },
    node: { path: process.execPath, version: process.versions.node, execPath: process.execPath },
    binaries,
  });
  const launcher = join(set.directory, 'slp-grok-peer');
  const message = { jsonrpc: '2.0', id: 1, method: 'session/prompt', params: { sessionId: 's', prompt: [{ type: 'text', text: 'local echo fixture' }] } };
  const run = (extra = {}, args = []) => spawnSync(launcher, args, {
    input: JSON.stringify(message) + '\n',
    encoding: 'utf8',
    timeout: 10000,
    env: { ...envFor(f), PASEO_AGENT_ID: 'agent', KEEP: 'env-kept', ...extra },
  });
  for (const grant of [undefined, '']) {
    const out = run(grant === undefined ? {} : { SLP_SESSION_OPEN_GRANT: grant });
    assert.equal(out.status, 1);
    assert.match(out.stderr, /without live SLP hook grant/);
    assert.equal(existsSync(marker), false);
  }
  const probe = run({}, ['--version']);
  assert.equal(probe.status, 0, probe.stderr);
  assert.equal(probe.stdout, 'grok 1.0.77 (50ca579fa996) [stable]\n');
  assert.equal(existsSync(marker), false);
  const allowed = run({ SLP_SESSION_OPEN_GRANT: 'live-grant' });
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(readFileSync(marker, 'utf8'), 'agent stdio:env-kept:\n');
  const transformed = JSON.parse(allowed.stdout);
  assert.ok(transformed.params.prompt[0].text.startsWith('SLP role=peer\n'));
  assert.deepEqual(transformed.params.prompt[1], message.params.prompt[0]);
  rmSync(marker);
  writeBinary('0.2.10');
  const refused = run({ SLP_SESSION_OPEN_GRANT: 'live-grant' });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /executable version was not verified/);
  assert.equal(existsSync(marker), false);
});

test('resolver refuses an explicit old Grok and follows a verified PATH alias', async t => {
  const f = fixture(t);
  const binary = join(f.dir, 'native');
  const alias = join(f.dir, 'grok');
  writeFileSync(binary, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  symlinkSync(binary, alias);
  let version = 'grok 1.0.77 (50ca579fa996) [stable]';
  const resolver = createExecutableResolver({
    env: { PATH: f.dir },
    run: async (file, args) => ({
      code: 0,
      stderr: '',
      stdout: args[0] === '-e' ? JSON.stringify({ node: process.versions.node, electron: null, execPath: process.execPath }) : version,
    }),
  });
  const request = { daemonHome: join(f.dir, 'home'), stableRoot: join(f.dir, 'stable'), nodePath: process.execPath };
  assert.equal((await resolver.resolve(request)).binaries.grok.path, alias);
  for (version of ['0.2.10', 'grok development', 'garbage']) {
    assert.equal((await resolver.resolve(request)).binaries.grok.available, false);
    await assert.rejects(resolver.resolve({ ...request, binaries: { grok: alias } }), /requires Grok Build >=0\.2\.11/);
  }
});
