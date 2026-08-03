#!/usr/bin/env node

/**
 * Copies the compiled Rust binary to bin/ with platform-specific naming
 */

import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { platform, arch } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

const sourceExt = platform() === 'win32' ? '.exe' : '';
const sourcePath = join(projectRoot, `cli/target/release/agent-browser${sourceExt}`);
const binDir = join(projectRoot, 'bin');

// Determine platform suffix
const platformKey = `${platform()}-${arch()}`;
const ext = platform() === 'win32' ? '.exe' : '';
const targetName = `agent-browser-${platformKey}${ext}`;
const targetPath = join(binDir, targetName);

if (!existsSync(sourcePath)) {
  console.error(`Error: Native binary not found at ${sourcePath}`);
  console.error('Run "cargo build --release --manifest-path cli/Cargo.toml" first');
  process.exit(1);
}

if (!existsSync(binDir)) {
  mkdirSync(binDir, { recursive: true });
}

// Replacing a Mach-O in place while an existing daemon has it mapped can
// leave subsequent launches blocked in dyld on macOS. Stage in the same
// directory and rename atomically so running daemons keep their old inode.
const stagedPath = `${targetPath}.${process.pid}.tmp`;
copyFileSync(sourcePath, stagedPath);
try {
  renameSync(stagedPath, targetPath);
} catch (error) {
  if (platform() !== 'win32') {
    throw error;
  }
  // Windows cannot always replace an existing executable with rename.
  rmSync(targetPath, { force: true });
  renameSync(stagedPath, targetPath);
} finally {
  rmSync(stagedPath, { force: true });
}
console.log(`✓ Copied native binary to ${targetPath}`);
