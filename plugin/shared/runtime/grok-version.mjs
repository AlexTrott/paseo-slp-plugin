// Grok Build's ACP command (`grok agent stdio`) is the catalog shape Paseo
// records from 0.2.11. Model and reasoning-effort discovery was observed on
// 1.0.77; this predicate does not claim that every later build was live-tested.
// Bootstrap-safe: detection and the role wrapper both import this file, and
// the wrapper cannot depend on TypeScript.
/** @param {string} output */
export function supportsGrokVersion(output) {
  const match = /^(?:grok\s+)?v?(\d+)\.(\d+)\.(\d+)(?:[-+][\w.-]+)?(?:[ \t].*)?$/i.exec(output.trim());
  if (match === null) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  return major > 0 || (major === 0 && minor > 2) || (major === 0 && minor === 2 && patch >= 11);
}

export const GROK_VERSION_REQUIREMENT = 'Grok Build >=0.2.11 (`grok agent stdio`; V1 model catalog observed on 1.0.77)';
