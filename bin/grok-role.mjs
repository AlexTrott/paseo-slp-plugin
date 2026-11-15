#!/usr/bin/env node
// Grok Build speaks ACP via `agent stdio`; the host's generic ACP adapter
// needs a noninteractive authentication bridge before session discovery.
import { fileURLToPath } from 'node:url';
import { runRoleProcess } from '../plugin/server/runtime/cli/role-process.ts';
import { runGrokAcpProcess } from '../plugin/server/runtime/cli/grok-acp.ts';
import { roleDelivery } from '../plugin/server/runtime/cli/role-bundle.ts';
import { verifyInstall } from '../plugin/server/runtime/cli/package.ts';
import { acpRolePrompt } from '../plugin/server/runtime/cli/role-transport.ts';

const [role, ...args] = process.argv.slice(2);
const root = fileURLToPath(new URL('..', import.meta.url));
try {
  verifyInstall(root);
  const delivery = roleDelivery(root, role);
  const binary = process.env.SLP_GROK_BIN || 'grok';
  const command = args.length ? [...args] : ['agent', 'stdio'];
  if (command[0] === '--no-auto-update') command.shift();
  const versionProbe = command.length === 1 && command[0] === '--version';
  if (!versionProbe && (command[0] !== 'agent' || command[1] !== 'stdio')) {
    throw new Error('SLP Grok supports only ACP stdio (agent stdio); interactive and print sessions are unsupported');
  }
  if (!versionProbe && process.env.SLP_MANAGED_RUNTIME === '1' && process.env.PASEO_AGENT_ID && !process.env.SLP_SESSION_OPEN_GRANT) {
    throw new Error('managed Grok session launched without live SLP hook grant');
  }
  // The grant belongs to this open, never to Grok or any process it creates.
  delete process.env.SLP_SESSION_OPEN_GRANT;
  if (versionProbe) {
    await runRoleProcess(binary, command, { protocol: false, transform: message => message });
  } else {
    const seen = new Set();
    await runGrokAcpProcess(binary, ['--no-auto-update', ...command],
      message => acpRolePrompt(message, delivery, seen));
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
