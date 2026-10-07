import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export async function writeMacUpdateInfo(dir, version) {
  const name = `Author-Studio-${version}-universal.zip`;
  const file = path.join(dir, name);
  const hash = createHash('sha512');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  const sha512 = hash.digest('base64');
  const { size } = await stat(file);
  const info = {
    version,
    files: [{ url: name, sha512, size }],
    path: name,
    sha512,
    releaseDate: new Date().toISOString(),
  };
  // JSON is valid YAML, and avoids another runtime dependency for packaging.
  await writeFile(path.join(dir, 'latest-mac.yml'), `${JSON.stringify(info, null, 2)}\n`);
  return info;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { version } = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
  await writeMacUpdateInfo('dist', version);
}
