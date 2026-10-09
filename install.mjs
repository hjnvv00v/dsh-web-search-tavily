/**
 * Install (or remove) this plugin in a DSH profile.
 *
 * The plugin is a bundle: the profile's `dsh.profile.bundles` selects it, and its own
 * `cordis.patch.yml` both inserts the loader row and pins `web.searchProvider` — the row id is the
 * settings namespace the browser half binds. Nothing else has to be written, so this script only
 * copies the package in and registers it.
 *
 * The profile patch is still read on install, to warn when the profile overrides `web` in its own
 * layer (which is applied last and would therefore beat the bundle's pin), and written on uninstall
 * to drop the marker-delimited entry older versions of this installer used to add. The settings
 * page also writes this plugin's configuration into that file, so removal recognises whole entries
 * and never deletes anything else. Every edited file is backed up once.
 *
 *   node install.mjs [--profile desktop] [--home <harness home>] [--uninstall] [--dry-run]
 *
 * The same functions are exported so `test/install.mjs` can drive them without spawning.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Package name, and the bundle name the profile's manifest selects. */
export const PACKAGE = 'dsh-web-search-tavily-relay'
/** Loader row id the bundle patch inserts; also this plugin's settings namespace. */
export const BUNDLE_ROW_ID = 'web-search-tavily'
/** Provider id the seam is pointed at. */
export const PROVIDER_ID = 'tavily'
/** Loader entry id the installer owns and rewrites on every run. */
export const MANAGED_ID = 'web'
/**
 * Marker comments around the installer-owned entry.
 *
 * These spell the ORIGINAL package name on purpose and must not follow a rename: they are the
 * fingerprint an uninstall matches against to find and remove a block an earlier version wrote.
 */
export const BEGIN = '# >>> dsh-web-search-tavily (managed block; do not edit by hand) >>>'
export const END = '# <<< dsh-web-search-tavily <<<'

/** Likewise a legacy fingerprint — the suffix already present on backups sitting in the profile. */
const BACKUP_SUFFIX = '.bak-dsh-web-search-tavily'

/** Files that make up the installed package; `test` and `node_modules` stay in the source tree. */
const SHIPPED = ['lib', 'cordis.patch.yml', 'package.json', 'README.md']

const sourceDir = dirname(fileURLToPath(new URL('./package.json', import.meta.url)))

/** Parse the command line. */
export function parseArgs(argv) {
  const options = {
    profile: process.env.DSH_PROFILE ?? 'desktop',
    home: process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh'),
    uninstall: false,
    dryRun: false,
    log: (line) => console.log(line),
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--profile') options.profile = argv[++index]
    else if (arg === '--home') options.home = argv[++index]
    else if (arg === '--uninstall') options.uninstall = true
    else if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else throw new Error(`unknown argument ${JSON.stringify(arg)}`)
  }
  return options
}

/** Write a file after keeping one backup of its previous contents. */
function writeWithBackup(path, contents, options) {
  const backup = `${path}${BACKUP_SUFFIX}`
  if (!options.dryRun) {
    if (!existsSync(backup)) writeFileSync(backup, readFileSync(path))
    writeFileSync(path, contents)
  }
  options.log(`  ${options.dryRun ? 'would write' : 'wrote'} ${path}`)
}

/**
 * The marker-delimited block older versions of this installer wrote into a profile patch.
 *
 * The plugin's own `cordis.patch.yml` pins the provider now, so nothing calls this on install. It
 * stays so an uninstall can still recognise and remove what an earlier version left behind.
 */
export function managedBlock() {
  return [
    BEGIN,
    `- id: ${MANAGED_ID}`,
    "  name: '@deepseek-ai/dsh-web'",
    '  config:',
    `    searchProvider: ${PROVIDER_ID}`,
    END,
    '',
  ].join('\n')
}

/**
 * Split a patch document into top-level blocks, tagging each with the entry id it declares and
 * whether any of its lines sat inside the installer's marker region.
 *
 * The settings page writes a plugin's configuration into this same patch file, and it can land
 * between the markers — so the installer must recognise whole entries rather than trusting the
 * markers to fence off only what it wrote.
 *
 * @param text - the patch document.
 * @returns the blocks in document order; marker comment lines are dropped.
 */
export function splitManaged(text) {
  const blocks = []
  let current = null
  let inside = false
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === BEGIN) {
      inside = true
      continue
    }
    if (trimmed === END) {
      inside = false
      continue
    }
    if (line.startsWith('- ') || line === '-') {
      if (current !== null) blocks.push(current)
      current = { id: undefined, managed: false, lines: [] }
    } else if (current === null) {
      current = { id: undefined, managed: false, lines: [] }
    }
    const match = /^- id:\s*['"]?([^'"\s]+)['"]?\s*$/u.exec(line)
    if (match !== null && current.id === undefined) current.id = match[1]
    if (inside) current.managed = true
    current.lines.push(line)
  }
  if (current !== null) blocks.push(current)
  return blocks
}

/**
 * Strip the installer's own entry, keeping every other entry the file holds.
 *
 * @param text - the patch document.
 * @param options - `dropPluginEntry` also removes this plugin's configuration entry, which is what
 *   an uninstall wants and an install must never do.
 * @returns the document without the managed entry and without the marker comments.
 */
export function stripManagedBlock(text, options = {}) {
  const owned = new Set([BUNDLE_ROW_ID, PACKAGE])
  return splitManaged(text)
    .filter((block) => !(block.managed && block.id === MANAGED_ID))
    .filter((block) => !(options.dropPluginEntry === true && owned.has(block.id)))
    .map((block) => block.lines.join('\n'))
    .join('\n')
}

/** Whether the patch file already overrides the `web` entry outside the managed block. */
export function hasForeignWebEntry(text) {
  return /^- id: *['"]?web['"]? *$/mu.test(stripManagedBlock(text))
}

/**
 * Resolve the three paths an operation touches.
 *
 * @param options - the parsed command line.
 * @returns the profile directory and the files inside it.
 */
function pathsOf(options) {
  const profileDir = resolve(options.home, 'profiles', options.profile)
  return {
    profileDir,
    manifestPath: join(profileDir, 'package.json'),
    patchPath: join(profileDir, 'cordis.patch.yml'),
    targetDir: join(profileDir, 'node_modules', PACKAGE),
  }
}

/**
 * Copy the package into a profile and select it.
 *
 * @param options - `home`, `profile`, `dryRun`, and `log`.
 * @returns the paths written, and whether a foreign `web` override blocked the seam pin.
 */
export function install(options) {
  const { profileDir, manifestPath, patchPath, targetDir } = pathsOf(options)
  options.log(`\nInstalling ${PACKAGE}`)
  options.log(`  profile  ${profileDir}`)
  options.log(`  source   ${sourceDir}\n`)

  if (!existsSync(manifestPath)) {
    throw new Error(`No profile manifest at ${manifestPath}. Pass --profile and --home for the profile you meant.`)
  }

  // 1. Copy the package into the profile's node_modules.
  if (existsSync(targetDir) && !options.dryRun) rmSync(targetDir, { recursive: true, force: true })
  if (!options.dryRun) mkdirSync(targetDir, { recursive: true })
  for (const entry of SHIPPED) {
    const from = join(sourceDir, entry)
    if (!existsSync(from)) throw new Error(`the package is incomplete: ${from} is missing`)
    if (!options.dryRun) cpSync(from, join(targetDir, entry), { recursive: true })
    options.log(`  ${options.dryRun ? 'would copy' : 'copied'} ${entry}`)
  }

  // 2. Select the bundle in the profile manifest.
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.dependencies = { ...manifest.dependencies, [PACKAGE]: `file:${sourceDir.replaceAll('\\', '/')}` }
  manifest.dsh = manifest.dsh ?? {}
  manifest.dsh.profile = manifest.dsh.profile ?? {}
  const bundles = Array.isArray(manifest.dsh.profile.bundles) ? manifest.dsh.profile.bundles : []
  manifest.dsh.profile.bundles = bundles.includes(PACKAGE) ? bundles : [...bundles, PACKAGE]
  writeWithBackup(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, options)

  // 3. Report a profile-layer `web` override. The bundle's pin lives in the plugin's own
  //    cordis.patch.yml; a profile patch is applied after every bundle layer, so its config wins.
  const foreign = existsSync(patchPath) && hasForeignWebEntry(readFileSync(patchPath, 'utf8'))
  if (foreign) {
    options.log(
      '\nThis profile overrides the "web" entry in its own patch layer, which is applied after\n'
      + 'every bundle layer — so that config wins over the pin this plugin ships. Make sure it\n'
      + `selects this provider:\n\n    searchProvider: ${PROVIDER_ID}\n\n`
      + 'Without it, two usable search providers leave web_search ambiguous.',
    )
  }

  options.log(
    '\nInstalled. Reload the Web UI (the profile has HMR, so the row recomposes); on a profile '
    + 'without HMR, restart DSH.\n'
    + `The configuration card is on the Plugins page under ${PACKAGE}.\n`,
  )
  return { profileDir, manifestPath, patchPath, targetDir, foreignWebEntry: foreign }
}

/**
 * Reverse an install, removing this plugin's own configuration entry too.
 *
 * @param options - `home`, `profile`, `dryRun`, and `log`.
 * @returns the paths touched.
 */
export function uninstall(options) {
  const { profileDir, manifestPath, patchPath, targetDir } = pathsOf(options)
  options.log(`\nUninstalling ${PACKAGE}`)
  options.log(`  profile  ${profileDir}\n`)

  if (!existsSync(manifestPath)) {
    throw new Error(`No profile manifest at ${manifestPath}. Pass --profile and --home for the profile you meant.`)
  }
  if (existsSync(targetDir)) {
    if (!options.dryRun) rmSync(targetDir, { recursive: true, force: true })
    options.log(`  ${options.dryRun ? 'would remove' : 'removed'} ${targetDir}`)
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  delete manifest.dependencies?.[PACKAGE]
  if (Array.isArray(manifest.dsh?.profile?.bundles)) {
    manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter((name) => name !== PACKAGE)
  }
  writeWithBackup(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, options)
  if (existsSync(patchPath)) {
    const stripped = stripManagedBlock(readFileSync(patchPath, 'utf8'), { dropPluginEntry: true })
    writeWithBackup(patchPath, stripped, options)
  }
  options.log('\nUninstalled. Reload the Web UI, or restart DSH on a profile without HMR.\n')
  return { profileDir, manifestPath, patchPath, targetDir }
}

/** The command-line entry point. */
function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help === true) {
    const text = readFileSync(fileURLToPath(import.meta.url), 'utf8')
    console.log(text.split('\n').slice(0, 18).map((line) => line.replace(/^\/?\*+ ?/u, '')).join('\n'))
    return
  }
  if (options.uninstall) uninstall(options)
  else install(options)
}

const invokedDirectly = process.argv[1] !== undefined
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedDirectly) {
  try {
    main()
  } catch (error) {
    console.error(`\n${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}
