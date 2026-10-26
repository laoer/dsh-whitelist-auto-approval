import { access } from 'node:fs/promises'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('../', import.meta.url)
const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
const patch = await readFile(new URL('cordis.patch.yml', root), 'utf8')
const client = await readFile(new URL('client.js', root), 'utf8')

test('manifest: names the bundle and the client half', () => {
  assert.equal(pkg.name, 'dsh-whitelist-auto-approval')
  assert.equal(pkg.version, '0.3.1-beta')
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.exports['.'], './index.js')
  assert.equal(pkg.exports['./client'], './client.js')
  assert.equal(pkg.exports['./locale/*.json'], './locale/*.json')
  assert.equal(pkg.exports['./icon'], './icon.svg')
})

test('manifest: the client half is a web module that waits for the Plugins page', () => {
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.equal(pkg.dsh.client.immediately, true)
  assert.deepEqual(pkg.dsh.client.inject, [
    '@deepseek-ai/dsh-client-ui-plugin-manager',
    '@deepseek-ai/dsh-client-locale',
  ])
  assert.match(client, /id:\s*'dsh-whitelist-auto-approval'/)
})

test('manifest: every runtime file ships and the schema is vendored', () => {
  for (const required of ['index.js', 'matcher.js', 'overlay.js', 'schema.js', 'client.js', 'cordis.patch.yml', 'icon.svg']) {
    assert.ok(pkg.files.includes(required), `${required} is missing from files`)
  }
  assert.ok(pkg.files.includes('locale/*.json'))
  assert.ok(pkg.files.includes('vendor/**'))
  assert.equal(pkg.dependencies, undefined)
})

test('manifest: the bundle patch keeps the row id and the default rules', () => {
  assert.match(patch, /id:\s*bash-sandbox-auto-approval/)
  assert.match(patch, /name:\s*'dsh-whitelist-auto-approval'/)
  assert.match(patch, /command:\s*lark-cli/)
  assert.match(patch, /command:\s*gh/)
})

test('vendor: both copies and their licenses are present', async () => {
  for (const path of [
    'vendor/README.md',
    'vendor/schemastery/index.mjs',
    'vendor/schemastery/LICENSE',
    'vendor/cosmokit/index.js',
    'vendor/cosmokit/LICENSE',
  ]) {
    await access(new URL(path, root))
  }
})
