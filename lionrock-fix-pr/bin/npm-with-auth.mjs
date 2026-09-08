#!/usr/bin/env node
// Run npm against the repository's feeds using the existing ADO workload identity.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function credentialScopes(config) {
  const scopes = new Set();
  for (const line of config.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:@[^:]+:)?registry\s*=\s*(\S+)\s*$/);
    if (!match) continue;
    const url = new URL(match[1]);
    // Never attach an organisation token to an arbitrary URL from a checkout.
    if (url.protocol !== 'https:' || url.port || url.username || url.password || url.search || url.hash) {
      throw new Error('npm registry must be an HTTPS URL without credentials or query parameters');
    }
    const trusted = url.hostname === 'msazure.pkgs.visualstudio.com'
      || (url.hostname === 'pkgs.dev.azure.com' && url.pathname.startsWith('/msazure/'));
    if (!trusted) continue;
    if (!url.pathname.endsWith('/npm/registry/')) throw new Error('unsupported Azure Artifacts npm registry path');
    // Tarball URLs are under npm/, while metadata is under npm/registry/.
    scopes.add(`//${url.host}${url.pathname.slice(0, -'registry/'.length)}`);
  }
  return [...scopes];
}

async function main() {
  const [directory, ...args] = process.argv.slice(2);
  if (!directory) throw new Error('usage: npm-with-auth.mjs <project directory> [npm arguments]');
  const cwd = path.resolve(directory);
  const scopes = credentialScopes(fs.readFileSync(path.join(cwd, '.npmrc'), 'utf8'));
  if (!scopes.length) throw new Error('no supported Azure Artifacts feeds in the project .npmrc');
  const { ado } = await import('../../_iris-shared/index.mjs');
  const token = await ado.adoToken({ timeout: 60 });
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-npm-'));
  try {
    const config = path.join(temp, 'npmrc');
    fs.writeFileSync(config, scopes.map(scope => `${scope}:_authToken=${token}\n`).join(''), { mode: 0o600 });
    const code = await new Promise((resolve, reject) => {
      const child = spawn('npm', args.length ? args : ['ci'], {
        cwd, stdio: 'inherit', env: { ...process.env, NPM_CONFIG_USERCONFIG: config },
      });
      child.once('error', reject);
      child.once('close', (code) => resolve(code ?? 1));
    });
    process.exitCode = code;
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(`npm-with-auth: ${error.message}`); process.exitCode = 1; });
}
