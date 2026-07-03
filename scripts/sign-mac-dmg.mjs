import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const releaseDir = fileURLToPath(new URL('../release/', import.meta.url));
const identity = process.env.CSC_NAME || 'Developer ID Application: Stichting Kadamba Foundation (438UQRF7JV)';

if (process.env.SKIP_DMG_CODESIGN === '1') {
  console.log('Skipping DMG codesign because SKIP_DMG_CODESIGN=1.');
  process.exit(0);
}

const dmgPaths = readdirSync(releaseDir)
  .filter((name) => name.endsWith('.dmg'))
  .map((name) => join(releaseDir, name))
  .filter((path) => statSync(path).isFile());

if (dmgPaths.length === 0) {
  console.log('No DMG artifacts found to codesign.');
  process.exit(0);
}

for (const dmgPath of dmgPaths) {
  console.log(`Codesigning DMG: ${dmgPath}`);
  execFileSync('/usr/bin/codesign', ['--force', '--timestamp', '--sign', identity, dmgPath], {
    stdio: 'inherit',
  });
}
