/**
 * Installer regression test.
 *
 * Two failures are pinned down here, both real and both hit once:
 *
 * 1. The settings page writes a plugin's configuration into the same patch file the installer
 *    edits, and it can land *between* the installer's marker comments. An installer that trusts the
 *    markers to fence off only what it wrote deletes the user's configuration on the next run.
 * 2. The installer used to *write* the seam's provider pin into the profile patch. That is not its
 *    job — the plugin's own `cordis.patch.yml` carries the pin, and a plain `dsh plugin add` never
 *    runs this script at all. So the installer must now leave the profile patch alone.
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
const shippedPatch = join(sourceDir, 'cordis.patch.yml')

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

/**
 * A patch file shaped the way a real profile's looks after an older installer ran and the settings
 * page then wrote this plugin's configuration into the marker region.
 */
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
  // Marker and package name below are the ORIGINAL ones: this fixture reproduces what an older
  // installer wrote, so uninstall must still recognise it after the package was renamed.
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

check('install leaves the profile patch byte-for-byte alone, on a repeat run too', () => {
  const before = readFileSync(patchPath, 'utf8')
  run(install)
  assert.equal(
    readFileSync(patchPath, 'utf8'),
    before,
    'the shipped cordis.patch.yml owns the provider pin; the installer must not write to the profile',
  )
})

check('the bundle is selected and the dependency recorded', () => {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  assert.ok(manifest.dsh.profile.bundles.includes('dsh-web-search-tavily-relay'))
  assert.equal(manifest.dependencies['dsh-web-search-tavily-relay'], `file:${sourceDir.replaceAll('\\', '/')}`)
  assert.equal(manifest.dsh.profile.bundles.filter((name) => name === 'dsh-web-search-tavily-relay').length, 1)
})

check('the package is copied without the development node_modules', () => {
  const target = join(profileDir, 'node_modules', 'dsh-web-search-tavily-relay')
  assert.ok(existsSync(join(target, 'lib', 'index.js')))
  assert.ok(existsSync(join(target, 'lib', 'client.js')))
  assert.ok(existsSync(join(target, 'cordis.patch.yml')))
  assert.ok(!existsSync(join(target, 'node_modules')), 'the dev-only peer junctions must not ship')
})

check('a profile that overrides web itself is reported, and never overwritten', () => {
  const foreign = join(sandbox, 'foreign')
  const foreignProfile = join(foreign, 'profiles', 'desktop')
  mkdirSync(foreignProfile, { recursive: true })
  const foreignPatch = '- id: web\n  name: "@deepseek-ai/dsh-web"\n  config:\n    fetchProvider: http\n'
  writeFileSync(join(foreignProfile, 'cordis.patch.yml'), foreignPatch)
  writeFileSync(join(foreignProfile, 'package.json'), '{"name":"p","private":true}\n')
  const result = run(install, foreign)
  assert.equal(result.foreignWebEntry, true, 'a foreign web override must be detected, not overwritten')
  assert.equal(
    readFileSync(join(foreignProfile, 'cordis.patch.yml'), 'utf8'),
    foreignPatch,
    'a foreign web override must be untouched — it is applied last, so it wins over the bundle pin',
  )
})

check('the shipped bundle patch selects this provider and mounts the plugin', () => {
  const text = readFileSync(shippedPatch, 'utf8')
  // A patch replaces the whole `config` of the entry it targets rather than merging into it, so the
  // pin has to be stated here: registering a provider does not select it, and the seam refuses to
  // guess between two usable ones.
  assert.match(text, /^- id: web$/mu, 'the web entry must be targeted at top level')
  assert.match(text, /^\s+searchProvider: tavily$/mu, 'the seam must be pointed at this provider')
  assert.match(text, /^- insert:$/mu)
  assert.match(text, /^\s+- id: web-search-tavily$/mu, 'the loader row must be inserted')
  assert.match(text, /^\s+name: 'dsh-web-search-tavily-relay'$/mu)
  // fetchProvider is deliberately absent: restating it would pin a fetch backend this plugin does
  // not own, and a stock profile mounts exactly one, which the seam auto-selects.
  const body = text.split('\n').filter((line) => !line.trimStart().startsWith('#')).join('\n')
  assert.doesNotMatch(body, /fetchProvider/u, 'the patch must not pin a fetch provider it does not own')
})

run(uninstall)

check('uninstall removes the legacy managed entry and this plugin\'s configuration, and nothing else', () => {
  const patch = readFileSync(patchPath, 'utf8')
  assert.doesNotMatch(patch, /searchProvider: tavily/u)
  assert.doesNotMatch(patch, /- id: web-search-tavily/u, 'the plugin config belongs to the plugin')
  assert.doesNotMatch(patch, /managed block/u)
  assert.match(patch, /- id: ui-theme/u)
  assert.match(patch, /- id: ui-chat/u)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  assert.deepEqual(manifest.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dshmarket'])
  assert.equal(manifest.dependencies['dsh-web-search-tavily-relay'], undefined)
  assert.ok(!existsSync(join(profileDir, 'node_modules', 'dsh-web-search-tavily-relay')))
})

rmSync(sandbox, { recursive: true, force: true })
console.log(`\n${passes} passed, ${failures} failed\n`)
process.exitCode = failures === 0 ? 0 : 1
