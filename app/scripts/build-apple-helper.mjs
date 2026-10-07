// Builds the universal Apple Intelligence helper into resources/bin. On other
// platforms there is nothing to build.
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(appRoot, 'native', 'apple-intelligence', 'main.swift');
const output = path.join(appRoot, 'resources', 'bin', 'author-studio-apple-intelligence');

if (process.platform !== 'darwin') {
  console.log('Skipping the Apple Intelligence helper: it is built only on macOS.');
  process.exit(0);
}

const work = mkdtempSync(path.join(tmpdir(), 'author-studio-helper-'));
try {
  const slices = [];
  for (const arch of ['arm64', 'x86_64']) {
    const slice = path.join(work, `helper-${arch}`);
    execFileSync('xcrun', [
      'swiftc', '-parse-as-library', '-O',
      '-target', `${arch}-apple-macos12.0`,
      '-Xlinker', '-weak_framework', '-Xlinker', 'FoundationModels',
      source, '-o', slice,
    ], { stdio: 'inherit' });
    slices.push(slice);
  }
  mkdirSync(path.dirname(output), { recursive: true });
  execFileSync('xcrun', ['lipo', '-create', ...slices, '-output', output], { stdio: 'inherit' });
  chmodSync(output, 0o755);
  execFileSync('codesign', ['--force', '--sign', '-', output], { stdio: 'inherit' });
  // Older SDKs build a helper that always reports Apple Intelligence as unavailable.
  if (!execFileSync('xcrun', ['otool', '-L', output], { encoding: 'utf8' }).includes('FoundationModels.framework')) {
    const message = 'The helper was built without Apple Intelligence support. Build with Xcode 26 or later (the macOS 26 SDK).';
    if (process.env.REQUIRE_APPLE_INTELLIGENCE === '1') throw new Error(message);
    console.warn(`Warning: ${message}`);
  }
  console.log(`Built ${path.relative(appRoot, output)}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
