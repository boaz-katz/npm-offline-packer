#!/usr/bin/env node
'use strict';

const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ─── Parse CLI arguments ────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
  console.log(`
Usage: node npm-pack-all.js <package-name> [options]

Options:
  --dry-run   List all packages to be collected without downloading anything
  --help, -h  Show this help message

Examples:
  node npm-pack-all.js lodash
  node npm-pack-all.js express --dry-run
  node npm-pack-all.js react@18.2.0
`);
  process.exit(0);
}

const dryRun = args.includes('--dry-run');
const packageArg = args.find(a => !a.startsWith('--'));

if (!packageArg) {
  console.error('Error: No package name provided.');
  process.exit(1);
}

// Package name for output folder (strip version specifier for the folder name)
const packageFolderName = packageArg.replace(/[@^~].*$/, '').replace(/^@/, '').replace(/\//, '__');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function log(msg) {
  console.log(`[npm-pack-all] ${msg}`);
}

function run(cmd, cwd, label) {
  log(`${label || 'Running'}: ${cmd}`);
  const result = spawnSync(cmd, {
    cwd,
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) {
    console.error(result.stderr || result.stdout);
    throw new Error(`Command failed (exit ${result.status}): ${cmd}`);
  }
  return result.stdout;
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function copyFile(src, dest) {
  fs.copyFileSync(src, dest);
}

/**
 * Recursively collect all package directories inside node_modules,
 * including scoped packages (e.g. @scope/pkg).
 */
function collectPackageDirs(nodeModulesDir) {
  const dirs = [];
  if (!fs.existsSync(nodeModulesDir)) return dirs;

  for (const entry of fs.readdirSync(nodeModulesDir)) {
    const fullPath = path.join(nodeModulesDir, entry);
    if (!fs.statSync(fullPath).isDirectory()) continue;

    if (entry.startsWith('.')) continue; // skip .cache, .package-lock.json etc.

    if (entry.startsWith('@')) {
      // Scoped namespace — recurse one level
      for (const scoped of fs.readdirSync(fullPath)) {
        const scopedPath = path.join(fullPath, scoped);
        if (fs.statSync(scopedPath).isDirectory()) {
          dirs.push(scopedPath);
        }
      }
    } else {
      dirs.push(fullPath);
    }
  }
  return dirs;
}

/**
 * Read package.json from a directory and return { name, version }.
 * Returns null if package.json is missing or unreadable.
 */
function readPackageJson(pkgDir) {
  const pkgJsonPath = path.join(pkgDir, 'package.json');
  if (!fs.existsSync(pkgJsonPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Resolve the installed package name from a packageArg like "react@18" or "@scope/pkg".
 * Returns the bare package name (e.g. "react", "@scope/pkg").
 */
function resolveInstalledName(packageArg) {
  // Strip trailing version specifier, but preserve leading @ for scoped packages
  if (packageArg.startsWith('@')) {
    // e.g. @scope/pkg@1.2.3 -> @scope/pkg
    const parts = packageArg.slice(1).split('@');
    return '@' + parts[0];
  }
  return packageArg.split('@')[0];
}

/**
 * Reads peerDependencies from the top-level installed package and installs
 * each one that is not already present in node_modules.
 */
function installMissingPeerDeps(packageArg, tmpDir) {
  const installedName = resolveInstalledName(packageArg);
  const nodeModulesDir = path.join(tmpDir, 'node_modules');

  // Locate the installed package's package.json
  const pkgDir = path.join(nodeModulesDir, installedName);
  const meta = readPackageJson(pkgDir);
  if (!meta || !meta.peerDependencies || Object.keys(meta.peerDependencies).length === 0) {
    return; // nothing to do
  }

  const peers = Object.entries(meta.peerDependencies);
  log(`Found ${peers.length} peerDependencies in ${installedName}: ${peers.map(([n]) => n).join(', ')}`);

  const missing = peers.filter(([name]) => {
    const peerDir = path.join(nodeModulesDir, name);
    return !fs.existsSync(peerDir);
  });

  if (missing.length === 0) {
    log('All peer dependencies are already installed.');
    return;
  }

  log(`Installing ${missing.length} missing peer dependencies...`);
  const peerArgs = missing.map(([name, version]) => {
    // Use the declared version range if it looks like a valid semver range,
    // otherwise fall back to "latest" to avoid install errors.
    const safeVersion = version && version !== '*' && !version.includes(' ') ? version : 'latest';
    return `"${name}@${safeVersion}"`;
  }).join(' ');

  run(
    `npm install ${peerArgs} --include=peer --legacy-peer-deps --no-audit --no-fund`,
    tmpDir,
    'npm install (peer deps)'
  );
  log('Peer dependency installation complete.');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  log(`Package    : ${packageArg}`);
  log(`Dry run    : ${dryRun}`);
  log(`Output dir : ./output/${packageFolderName}/`);
  console.log('');

  // ── Step 1: Create a temp workspace ──────────────────────────────────────

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-pack-all-'));
  log(`Temp workspace: ${tmpDir}`);

  try {
    // ── Step 2: npm install into temp dir ──────────────────────────────────

    if (!dryRun) {
      // Write a minimal package.json so npm install works cleanly
      fs.writeFileSync(
        path.join(tmpDir, 'package.json'),
        JSON.stringify({ name: 'npm-pack-all-workspace', version: '0.0.1', private: true }, null, 2)
      );

      log(`Installing ${packageArg} with all dependencies (this may take a while)...`);
      run(
        `npm install "${packageArg}" --include=peer --legacy-peer-deps --no-audit --no-fund`,
        tmpDir,
        'npm install'
      );
      log('Installation complete.');

      // ── Step 2b: Explicitly install peer dependencies ───────────────────
      // npm does not always install peerDependencies automatically (e.g. react,
      // motion). Read them from the installed package and install any that are
      // missing from node_modules.
      installMissingPeerDeps(packageArg, tmpDir);
      console.log('');
    } else {
      // Dry-run: install only to resolve the dependency tree, then just list
      log('Dry-run mode: resolving dependency tree...');
      fs.writeFileSync(
        path.join(tmpDir, 'package.json'),
        JSON.stringify({ name: 'npm-pack-all-workspace', version: '0.0.1', private: true }, null, 2)
      );
      run(
        `npm install "${packageArg}" --include=peer --legacy-peer-deps --no-audit --no-fund --dry-run`,
        tmpDir,
        'npm install (dry-run)'
      );

      // Dry-run npm install doesn't actually write files, so we do a real install
      // just to list the packages, then exit before packing.
      log('Performing real install to enumerate packages for dry-run listing...');
      run(
        `npm install "${packageArg}" --include=peer --legacy-peer-deps --no-audit --no-fund`,
        tmpDir,
        'npm install (for listing)'
      );
    }

    // ── Step 3: Collect all package directories ────────────────────────────

    const nodeModulesDir = path.join(tmpDir, 'node_modules');
    const packageDirs = collectPackageDirs(nodeModulesDir);

    log(`Found ${packageDirs.length} packages in node_modules.`);
    console.log('');

    if (dryRun) {
      console.log('Packages that would be collected:');
      console.log('─'.repeat(50));
      let count = 0;
      for (const pkgDir of packageDirs) {
        const meta = readPackageJson(pkgDir);
        if (!meta || !meta.name || !meta.version) continue;
        console.log(`  ${meta.name}@${meta.version}`);
        count++;
      }
      console.log('─'.repeat(50));
      console.log(`Total: ${count} packages`);
      return;
    }

    // ── Step 4: Run npm pack on each package ──────────────────────────────

    const outputDir = path.resolve(process.cwd(), 'output', packageFolderName);
    ensureDir(outputDir);
    log(`Output directory: ${outputDir}`);
    console.log('');

    let packed = 0;
    let skipped = 0;
    const errors = [];

    for (let i = 0; i < packageDirs.length; i++) {
      const pkgDir = packageDirs[i];
      const meta = readPackageJson(pkgDir);

      if (!meta || !meta.name || !meta.version) {
        log(`[${i + 1}/${packageDirs.length}] Skipping (no valid package.json): ${pkgDir}`);
        skipped++;
        continue;
      }

      const label = `${meta.name}@${meta.version}`;
      process.stdout.write(`[${i + 1}/${packageDirs.length}] Packing ${label}... `);

      const pkgJsonPath = path.join(pkgDir, 'package.json');
      const BLOCKED_SCRIPTS = ['prepare', 'prepack', 'postpack'];
      let originalPkgJsonText = null;

      try {
        // Strip lifecycle scripts that can trigger dev tools (e.g. husky)
        const pkgJsonText = fs.readFileSync(pkgJsonPath, 'utf8');
        const pkgJson = JSON.parse(pkgJsonText);
        if (pkgJson.scripts && BLOCKED_SCRIPTS.some(s => s in pkgJson.scripts)) {
          originalPkgJsonText = pkgJsonText;
          BLOCKED_SCRIPTS.forEach(s => delete pkgJson.scripts[s]);
          fs.writeFileSync(pkgJsonPath, JSON.stringify(pkgJson, null, 2), 'utf8');
        }

        // npm pack outputs the filename to stdout
        const output = run(`npm pack --pack-destination "${outputDir}"`, pkgDir, '').trim();
        // npm pack may output multiple lines; the last non-empty line is the filename
        const tgzName = output.split(/\r?\n/).filter(Boolean).pop();
        console.log(`-> ${tgzName}`);
        packed++;
      } catch (err) {
        console.log('FAILED');
        errors.push({ label, error: err.message });
        skipped++;
      } finally {
        // Restore original package.json if it was modified
        if (originalPkgJsonText !== null) {
          fs.writeFileSync(pkgJsonPath, originalPkgJsonText, 'utf8');
        }
      }
    }

    // ── Step 5: Summary ───────────────────────────────────────────────────

    console.log('');
    console.log('─'.repeat(60));
    log(`Done! Packed ${packed} packages into: ${outputDir}`);
    if (skipped > 0) {
      log(`Skipped/failed: ${skipped}`);
    }
    if (errors.length > 0) {
      console.log('');
      log('Errors:');
      for (const { label, error } of errors) {
        console.log(`  ${label}: ${error}`);
      }
    }
    console.log('─'.repeat(60));

  } finally {
    // ── Cleanup temp dir ──────────────────────────────────────────────────
    log(`Cleaning up temp dir: ${tmpDir}`);
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      log(`Warning: could not fully remove temp dir ${tmpDir}`);
    }
  }
}

main().catch(err => {
  console.error('\nFatal error:', err.message);
  process.exit(1);
});
