import { test } from 'node:test';
import assert from 'node:assert/strict';
import { credentialScopes } from '../bin/npm-with-auth.mjs';

test('credentials cover metadata and tarballs for both configured feed forms', () => {
  assert.deepEqual(credentialScopes(`
registry=https://msazure.pkgs.visualstudio.com/One/_packaging/Public/npm/registry/
@ags:registry=https://pkgs.dev.azure.com/msazure/One/_packaging/Private/npm/registry/
ignore-scripts=true
`), [
    '//msazure.pkgs.visualstudio.com/One/_packaging/Public/npm/',
    '//pkgs.dev.azure.com/msazure/One/_packaging/Private/npm/',
  ]);
});

test('organisation credentials never follow lookalike hosts or another organisation', () => {
  assert.deepEqual(credentialScopes(`
registry=https://msazure.pkgs.visualstudio.com.example.com/One/_packaging/Public/npm/registry/
@other:registry=https://pkgs.dev.azure.com/someone-else/One/_packaging/Public/npm/registry/
`), []);
  assert.throws(() => credentialScopes('registry=http://msazure.pkgs.visualstudio.com/One/_packaging/Public/npm/registry/'), /HTTPS/);
  assert.throws(() => credentialScopes('registry=https://msazure.pkgs.visualstudio.com/One/_packaging/Public/npm/registry/?redirect=other'), /query/);
});
