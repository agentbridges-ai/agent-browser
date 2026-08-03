#!/usr/bin/env node

/**
 * Verifies that package.json and cli/Cargo.toml have the same version.
 * Used in CI to catch version drift.
 */

import { readFileSync } from 'fs';
import { createHash } from 'crypto';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');

// Read package.json version
const packageJson = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf-8'));
const packageVersion = packageJson.version;

// Read Cargo.toml version
const cargoToml = readFileSync(join(rootDir, 'cli/Cargo.toml'), 'utf-8');
const cargoVersionMatch = cargoToml.match(/^version\s*=\s*"([^"]*)"/m);

if (!cargoVersionMatch) {
  console.error('Could not find version in cli/Cargo.toml');
  process.exit(1);
}

const cargoVersion = cargoVersionMatch[1];

// Read dashboard package.json version
const dashboardPkg = JSON.parse(readFileSync(join(rootDir, 'packages/dashboard/package.json'), 'utf-8'));
const dashboardVersion = dashboardPkg.version;

// Read sandbox package versions
const sandboxPkg = JSON.parse(readFileSync(join(rootDir, 'packages/@agent-browser/sandbox/package.json'), 'utf-8'));
const sandboxVersion = sandboxPkg.version;
const sandboxVersionSource = readFileSync(join(rootDir, 'packages/@agent-browser/sandbox/src/version.ts'), 'utf-8');
const sandboxVersionMatch = sandboxVersionSource.match(/AGENT_BROWSER_SANDBOX_VERSION\s*=\s*"([^"]*)"/);

if (!sandboxVersionMatch) {
  console.error('Could not find AGENT_BROWSER_SANDBOX_VERSION in packages/@agent-browser/sandbox/src/version.ts');
  process.exit(1);
}

const sandboxRuntimeVersion = sandboxVersionMatch[1];

// Read Eve package version
const evePkg = JSON.parse(readFileSync(join(rootDir, 'packages/@agent-browser/eve/package.json'), 'utf-8'));
const eveVersion = evePkg.version;
const eveSandboxDependency = evePkg.dependencies?.['@agent-browser/sandbox'];

// Read Chrome extension provider versions
const chromeExtensionProviderPkg = JSON.parse(
  readFileSync(join(rootDir, 'packages/@agent-browser/chrome-extension-provider/package.json'), 'utf-8'),
);
const chromeExtensionProviderVersion = chromeExtensionProviderPkg.version;
const chromeExtensionProviderVersionSource = readFileSync(
  join(rootDir, 'packages/@agent-browser/chrome-extension-provider/src/version.ts'),
  'utf-8',
);
const chromeExtensionProviderRuntimeVersionMatch = chromeExtensionProviderVersionSource.match(
  /CHROME_EXTENSION_PROVIDER_VERSION\s*=\s*"([^"]*)"/,
);
const chromeExtensionProviderWxtSource = readFileSync(
  join(rootDir, 'packages/@agent-browser/chrome-extension-provider/wxt.config.ts'),
  'utf-8',
);
const chromeExtensionProviderManifestVersionMatch = chromeExtensionProviderWxtSource.match(
  /version:\s*"([^"]*)"/,
);
const chromeExtensionProviderManifestKeyMatch = chromeExtensionProviderWxtSource.match(
  /key:\s*"([^"]*)"/,
);
const chromeExtensionProviderConfigSource = readFileSync(
  join(rootDir, 'packages/@agent-browser/chrome-extension-provider/src/config.ts'),
  'utf-8',
);
const chromeExtensionProviderPinnedIdMatch = chromeExtensionProviderConfigSource.match(
  /PINNED_CHROME_EXTENSION_ID\s*=\s*"([a-p]{32})"/,
);

if (!chromeExtensionProviderRuntimeVersionMatch) {
  console.error(
    'Could not find CHROME_EXTENSION_PROVIDER_VERSION in packages/@agent-browser/chrome-extension-provider/src/version.ts',
  );
  process.exit(1);
}
if (!chromeExtensionProviderManifestVersionMatch) {
  console.error(
    'Could not find manifest version in packages/@agent-browser/chrome-extension-provider/wxt.config.ts',
  );
  process.exit(1);
}
if (!chromeExtensionProviderManifestKeyMatch) {
  console.error(
    'Could not find manifest key in packages/@agent-browser/chrome-extension-provider/wxt.config.ts',
  );
  process.exit(1);
}
if (!chromeExtensionProviderPinnedIdMatch) {
  console.error(
    'Could not find PINNED_CHROME_EXTENSION_ID in packages/@agent-browser/chrome-extension-provider/src/config.ts',
  );
  process.exit(1);
}

const chromeExtensionProviderRuntimeVersion = chromeExtensionProviderRuntimeVersionMatch[1];
const chromeExtensionProviderManifestVersion = chromeExtensionProviderManifestVersionMatch[1];
const chromeExtensionProviderPinnedId = chromeExtensionProviderPinnedIdMatch[1];
const chromeExtensionProviderManifestId = chromeExtensionIdFromKey(
  chromeExtensionProviderManifestKeyMatch[1],
);

const mismatches = [];
if (packageVersion !== cargoVersion) {
  mismatches.push(`  cli/Cargo.toml:              ${cargoVersion}`);
}
if (packageVersion !== dashboardVersion) {
  mismatches.push(`  packages/dashboard:          ${dashboardVersion}`);
}
if (packageVersion !== sandboxVersion) {
  mismatches.push(`  packages/@agent-browser/sandbox/package.json: ${sandboxVersion}`);
}
if (packageVersion !== sandboxRuntimeVersion) {
  mismatches.push(`  packages/@agent-browser/sandbox/src/version.ts: ${sandboxRuntimeVersion}`);
}
if (packageVersion !== eveVersion) {
  mismatches.push(`  packages/@agent-browser/eve/package.json: ${eveVersion}`);
}
if (eveSandboxDependency !== 'workspace:^') {
  mismatches.push(`  packages/@agent-browser/eve dependency @agent-browser/sandbox: ${eveSandboxDependency}`);
}
if (packageVersion !== chromeExtensionProviderVersion) {
  mismatches.push(
    `  packages/@agent-browser/chrome-extension-provider/package.json: ${chromeExtensionProviderVersion}`,
  );
}
if (packageVersion !== chromeExtensionProviderRuntimeVersion) {
  mismatches.push(
    `  packages/@agent-browser/chrome-extension-provider/src/version.ts: ${chromeExtensionProviderRuntimeVersion}`,
  );
}
if (packageVersion !== chromeExtensionProviderManifestVersion) {
  mismatches.push(
    `  packages/@agent-browser/chrome-extension-provider/wxt.config.ts: ${chromeExtensionProviderManifestVersion}`,
  );
}
if (chromeExtensionProviderPinnedId !== chromeExtensionProviderManifestId) {
  mismatches.push(
    `  packages/@agent-browser/chrome-extension-provider manifest id: ${chromeExtensionProviderManifestId}`,
  );
  mismatches.push(
    `  packages/@agent-browser/chrome-extension-provider pinned id: ${chromeExtensionProviderPinnedId}`,
  );
}

if (mismatches.length > 0) {
  console.error('Version mismatch detected!');
  console.error(`  package.json:                ${packageVersion}`);
  for (const m of mismatches) console.error(m);
  console.error('');
  console.error("Run 'pnpm run version:sync' to fix this.");
  process.exit(1);
}

console.log(`Versions are in sync: ${packageVersion}`);

function chromeExtensionIdFromKey(key) {
  const digest = createHash('sha256').update(Buffer.from(key, 'base64')).digest();
  return [...digest.subarray(0, 16)]
    .flatMap((byte) => [byte >> 4, byte & 0x0f])
    .map((nibble) => String.fromCharCode('a'.charCodeAt(0) + nibble))
    .join('');
}
