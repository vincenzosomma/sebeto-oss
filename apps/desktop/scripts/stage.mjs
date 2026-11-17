// Stage the desktop app for electron-builder: apps/desktop/stage/ becomes a self-contained app
// directory (electron-builder `directories.app`) with
//   package.json            name/version/main + the core's runtime dependencies, pinned to the
//                           versions installed in the workspace (the ones the tests ran against)
//   dist/                   the Electron main process (apps/desktop/dist)
//   build/icon.ico|png      window icon
//   node_modules/           `npm install --omit=dev` of the above, with @sebeto/core and
//                           @sebeto/shared copied in from their built dist/ folders
//
// Why a separate folder: electron-builder rebuilds native modules (better-sqlite3) for Electron's
// ABI in the app directory (`npmRebuild: true`). Doing that in the staged copy leaves the
// workspace's node_modules on Node's ABI, so `npm test` keeps working after `npm run dist`.
import { execFileSync, execSync } from 'node:child_process';
import { rebuild } from '@electron/rebuild';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(desktopDir, '..', '..');
const stageDir = join(desktopDir, 'stage');
const vendorDir = join(stageDir, 'vendor');

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const need = (p, hint) => {
  if (!existsSync(p)) {
    console.error(`stage: missing ${p}\n  ${hint}`);
    process.exit(1);
  }
};

const desktopPkg = readJson(join(desktopDir, 'package.json'));
const corePkgDir = join(repoRoot, 'packages', 'core');
const sharedPkgDir = join(repoRoot, 'packages', 'shared');
need(join(desktopDir, 'dist', 'main.js'), 'run `npm run build` at the repo root first');
need(join(corePkgDir, 'dist', 'main.js'), 'run `npm run build` at the repo root first');
need(join(sharedPkgDir, 'dist', 'index.js'), 'run `npm run build` at the repo root first');
need(join(repoRoot, 'packages', 'ui', 'dist', 'index.html'), 'run `npm run build` at the repo root first');
need(join(desktopDir, 'build', 'icon.ico'), 'run `node scripts/make-icons.mjs` at the repo root');

/** Version of a dependency as installed in the workspace (falls back to the declared range). */
function installedVersion(name, range) {
  for (const base of [join(corePkgDir, 'node_modules'), join(repoRoot, 'node_modules')]) {
    const p = join(base, ...name.split('/'), 'package.json');
    if (existsSync(p)) return readJson(p).version;
  }
  return range;
}

/** Copy a workspace package (package.json + dist + listed extras) into vendor/<name>. */
function vendor(srcDir, extras = []) {
  const pkg = readJson(join(srcDir, 'package.json'));
  const dest = join(vendorDir, pkg.name.replace('/', '__'));
  mkdirSync(dest, { recursive: true });
  cpSync(join(srcDir, 'dist'), join(dest, 'dist'), {
    recursive: true,
    filter: (src) => !/\.(map|test\.js|test\.d\.ts)$/.test(src),
  });
  for (const extra of extras) if (existsSync(join(srcDir, extra))) cpSync(join(srcDir, extra), join(dest, extra), { recursive: true });
  const deps = {};
  for (const [name, range] of Object.entries(pkg.dependencies ?? {})) {
    if (!name.startsWith('@sebeto/')) deps[name] = installedVersion(name, range);
  }
  const { scripts, devDependencies, ...rest } = pkg;
  writeFileSync(join(dest, 'package.json'), JSON.stringify({ ...rest, dependencies: deps }, null, 2) + '\n');
  return { name: pkg.name, spec: `file:./vendor/${pkg.name.replace('/', '__')}` };
}

rmSync(stageDir, { recursive: true, force: true });
mkdirSync(stageDir, { recursive: true });

const shared = vendor(sharedPkgDir);
const core = vendor(corePkgDir, ['oauth-apps.json']);
// The core's own dependency on @sebeto/shared is satisfied by the top-level copy below.

cpSync(join(desktopDir, 'dist'), join(stageDir, 'dist'), { recursive: true, filter: (src) => !src.endsWith('.map') });
mkdirSync(join(stageDir, 'build'), { recursive: true });
for (const f of ['icon.ico', 'icon.png']) cpSync(join(desktopDir, 'build', f), join(stageDir, 'build', f));

writeFileSync(
  join(stageDir, 'package.json'),
  JSON.stringify(
    {
      name: 'sebeto-desktop',
      productName: 'Sebeto',
      version: desktopPkg.version,
      description: 'Sebeto: an open-source AI team orchestrator anyone can use.',
      author: 'Sebeto contributors',
      license: 'MIT',
      homepage: 'https://github.com/vincenzosomma/sebeto-oss',
      private: true,
      type: 'module',
      main: 'dist/main.js',
      dependencies: { [core.name]: core.spec, [shared.name]: shared.spec },
    },
    null,
    2,
  ) + '\n',
);

// Install the production dependencies (Node ABI first; the native ones are rebuilt for Electron
// below). --install-links copies the vendored packages instead of symlinking them.
console.log('stage: installing production dependencies in', stageDir);
// Drop the `-w @sebeto/desktop` settings npm passes down when this runs from `npm run dist -w ...`.
const env = { ...process.env };
for (const k of Object.keys(env)) if (/^npm_config_(workspace|workspaces|include_workspace_root)$/i.test(k)) delete env[k];
execSync('npm install --omit=dev --install-links --no-audit --no-fund --no-package-lock', { cwd: stageDir, stdio: 'inherit', env });
// npm may still link file: dependencies (junctions on Windows), and electron-builder skips links:
// make sure node_modules/@sebeto/* are real folders.
for (const { name } of [shared, core]) {
  const dest = join(stageDir, 'node_modules', ...name.split('/'));
  if (existsSync(dest)) {
    if (lstatSync(dest).isSymbolicLink()) unlinkSync(dest);
    else rmSync(dest, { recursive: true, force: true });
  }
  cpSync(join(vendorDir, name.replace('/', '__')), dest, { recursive: true });
}
// Rebuild native modules for the Electron version electron-builder packages (prebuilt binaries
// are downloaded when available, else compiled). Scoped to stage/ so nothing outside changes.
//
// Target architectures: the host's on Windows and Linux (x64 builds in CI). On macOS the app is
// packaged for both arm64 and x64 (two .dmg files from one staged folder), so every native module
// is rebuilt for each architecture and merged into one fat (universal) binary with `lipo`; both
// packages then carry a .node file that loads on either CPU. SEBETO_STAGE_ARCHS="arm64,x64"
// overrides the list.
const electronVersion = readJson(fileURLToPath(import.meta.resolve('electron/package.json'))).version;
const archs = (process.env.SEBETO_STAGE_ARCHS?.trim() || (process.platform === 'darwin' ? 'arm64,x64' : process.arch))
  .split(',')
  .map((a) => a.trim())
  .filter(Boolean);
if (archs.length > 1 && process.platform !== 'darwin') {
  console.error(`stage: several architectures (${archs.join(', ')}) are only supported on macOS (lipo)`);
  process.exit(1);
}

/** Native modules loaded at run time (better-sqlite3's test extension is excluded by electron-builder.yml). */
const nativeFiles = () =>
  readdirSync(join(stageDir, 'node_modules'), { recursive: true })
    .map(String)
    .filter((p) => p.endsWith('.node') && !/test_extension/.test(p) && /[\\/]build[\\/]Release[\\/]/.test(p))
    .map((p) => join(stageDir, 'node_modules', p));

const perArch = new Map(); // .node path -> [{ arch, copy }]
const archDir = mkdtempSync(join(tmpdir(), 'sebeto-stage-'));
for (const arch of archs) {
  console.log(`stage: rebuilding native modules for Electron ${electronVersion} (${process.platform}-${arch})`);
  await rebuild({ buildPath: stageDir, projectRootPath: stageDir, electronVersion, arch, force: true, mode: 'sequential' });
  if (archs.length > 1) {
    for (const file of nativeFiles()) {
      const copy = join(archDir, arch, String(perArch.size), 'module.node');
      mkdirSync(dirname(copy), { recursive: true });
      cpSync(file, copy);
      if (!perArch.has(file)) perArch.set(file, []);
      perArch.get(file).push({ arch, copy });
    }
  }
}
if (archs.length > 1) {
  for (const [file, builds] of perArch) {
    if (builds.length !== archs.length) {
      console.error(`stage: ${file} was not built for every architecture (${builds.map((b) => b.arch).join(', ')})`);
      process.exit(1);
    }
    execFileSync('lipo', ['-create', '-output', file, ...builds.map((b) => b.copy)], { stdio: 'inherit' });
    console.log(`stage: ${file.slice(stageDir.length + 1)} -> ${execFileSync('lipo', ['-archs', file]).toString().trim()}`);
  }
}
rmSync(archDir, { recursive: true, force: true });
console.log('stage: ready');
