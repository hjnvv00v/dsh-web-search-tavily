/**
 * Installer regression test.
 *
 * The failure this pins down is real and was hit once: the settings page writes a plugin's
 * configuration into the same patch file the installer edits, and it can land *between* the
 * installer's marker comments. An installer that trusts the markers to fence off only what it
 * wrote deletes the user's configuration on the next run.
 *
 * Run with: node test/install.mjs
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { install, uninstall } from '../install.mjs'

const sourceDir = dirname(fileURLToPath(new URL('../package.json', import.meta.url)))
const sandbox = join(sourceDir, '_installer-test')
const home = join(sandbox, 'home')
const profileDir = join(home, 'profiles', 'desktop')
const patchPath = join(profileDir, 'cordis.patch.yml')
const manifestPath = join(profileDir, 'package.json')

let failures = 0
let passes = 0

/** Run one named check, reporting rather than throwing so the whole suite always runs. */
function check(label, run) {
  try {
    run()
    passes += 1
    console.log(`  ok   ${label}`)
  } catch (error) {
    failures += 1
    console.log(`  FAIL ${label}\n       ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Run the installer against a profile, quietly. */
function run(action, target = home) {
  return action({ home: target, profile: 'desktop', dryRun: false, log: () => {} })
}

/** A patch file shaped the way a real profile's looks after the settings page has written to it. */
const PATCH_FIXTURE = [
  '# Your patch layer for this dsh profile.',
  '- id: ui-theme',
  '  name: "@deepseek-ai/dsh-client-ui-theme"',
  '  config:',
  '    preference: dark',
  '- id: ui-chat',
  '  name: "@deepseek-ai/dsh-client-ui-chat"',
  '  config:',
  '    transcriptView: standard',
  '',
  '# >>> dsh-web-search-tavily (managed block; do not edit by hand) >>>',
  '- id: web',
  "  name: '@deepseek-ai/dsh-web'",
  '  config:',
  '    searchProvider: tavily',
  // Written by the settings page, and it landed inside the markers.
  '- id: web-search-tavily',
  '  name: dsh-web-search-tavily',
  '  config:',
  '    baseURL: https://relay.example',
  "    includeAnswer: 'true'",
  '',
  '# <<< dsh-web-search-tavily <<<',
  '',
].join('\n')

rmSync(sandbox, { recursive: true, force: true })
mkdirSync(profileDir, { recursive: true })
writeFileSync(patchPath, PATCH_FIXTURE)
writeFileSync(manifestPath, `${JSON.stringify({
  name: 'dsh-profile-desktop',
  private: true,
  dependencies: { dshmarket: '^1.66.12' },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dshmarket'] } },
}, null, 2)}\n`)

console.log('\ninstaller')

run(install)

check('the user\'s configuration inside the marker region survives an install', () => {
  const patch = readFileSync(patchPath, 'utf8')
  assert.match(patch, /baseURL: https:\/\/relay\.example/u, 'baseURL must survive')
  assert.match(patch, /includeAnswer: 'true'/u, 'includeAnswer must survive')
})

check('the pre-existing entries survive', () => {
  const patch = readFileSync(patchPath, 'utf8')
  assert.match(patch, /- id: ui-theme/u)
  assert.match(patch, /- id: ui-chat/u)
  assert.match(patch, /preference: dark/u)
})

check('exactly one managed web override exists, after a second install too', () => {
  run(install)
  const patch = readFileSync(patchPath, 'utf8')
  assert.equal(patch.match(/^- id: web$/gmu)?.length, 1, 'the managed entry must not be duplicated')
  assert.equal(patch.match(/- id: web-search-tavily$/gmu)?.length, 1, 'the user entry must not be duplicated')
  assert.equal(patch.match(/managed block; do not edit by hand/gu)?.length, 1, 'the marker must not be duplicated')
  assert.match(patch, /baseURL: https:\/\/relay\.example/u, 'baseURL must survive a second install')
})

check('the bundle is selected and the dependency recorded', () => {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  assert.ok(manifest.dsh.profile.bundles.includes('dsh-web-search-tavily'))
  assert.equal(manifest.dependencies['dsh-web-search-tavily'], `file:${sourceDir.replaceAll('\\', '/')}`)
  assert.equal(manifest.dsh.profile.bundles.filter((name) => name === 'dsh-web-search-tavily').length, 1)
})

check('the package is copied without the development node_modules', () => {
  const target = join(profileDir, 'node_modules', 'dsh-web-search-tavily')
  assert.ok(existsSync(join(target, 'lib', 'index.js')))
  assert.ok(existsSync(join(target, 'lib', 'client.js')))
  assert.ok(existsSync(join(target, 'cordis.patch.yml')))
  assert.ok(!existsSync(join(target, 'node_modules')), 'the dev-only peer junctions must not ship')
})

check('a profile that already overrides web itself is left alone', () => {
  const foreign = join(sandbox, 'foreign')
  const foreignProfile = join(foreign, 'profiles', 'desktop')
  mkdirSync(foreignProfile, { recursive: true })
  writeFileSync(join(foreignProfile, 'cordis.patch.yml'), '- id: web\n  name: "@deepseek-ai/dsh-web"\n  config:\n    fetchProvider: http\n')
  writeFileSync(join(foreignProfile, 'package.json'), '{"name":"p","private":true}\n')
  const result = run(install, foreign)
  assert.equal(result.foreignWebEntry, true, 'a foreign web override must be detected, not overwritten')
  const patch = readFileSync(join(foreignProfile, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /fetchProvider: http/u, 'a foreign web override must be untouched')
  assert.doesNotMatch(patch, /managed block/u, 'no managed entry may be written over a foreign one')
})

run(uninstall)

check('uninstall removes the managed entry and this plugin\'s configuration, and nothing else', () => {
  const patch = readFileSync(patchPath, 'utf8')
  assert.doesNotMatch(patch, /searchProvider: tavily/u)
  assert.doesNotMatch(patch, /- id: web-search-tavily/u, 'the plugin config belongs to the plugin')
  assert.doesNotMatch(patch, /managed block/u)
  assert.match(patch, /- id: ui-theme/u)
  assert.match(patch, /- id: ui-chat/u)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  assert.deepEqual(manifest.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dshmarket'])
  assert.equal(manifest.dependencies['dsh-web-search-tavily'], undefined)
  assert.ok(!existsSync(join(profileDir, 'node_modules', 'dsh-web-search-tavily')))
})

rmSync(sandbox, { recursive: true, force: true })
console.log(`\n${passes} passed, ${failures} failed\n`)
process.exitCode = failures === 0 ? 0 : 1
