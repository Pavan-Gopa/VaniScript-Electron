// Cross-platform Electron test runner.
//
// Discovers every `*.test.js` file under Electron/test/ and executes them with
// Node's own test runner (`node --test <files>`). Delegating to `node --test`
// gives us the standard, fully-supported reporter and exit code on every OS,
// while the discovery step keeps the suite scoped to Electron (the repo also
// contains `*.test.ts` files under src/ that must not be picked up, and
// npm-script glob expansion is not reliable across shells).
import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

function findTestFiles(dir) {
  const out = [];
  const walk = (current) => {
    let entries;
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(full);
      } else if (entry.endsWith('.test.js')) {
        out.push(full);
      }
    }
  };
  walk(dir);
  return out.sort();
}

const testDir = join(process.cwd(), 'test');
const files = findTestFiles(testDir);

if (files.length === 0) {
  console.error('No Electron tests discovered under test/');
  process.exit(1);
}

console.log(`Discovered ${files.length} Electron test file(s):`);
for (const file of files) {
  console.log(`  - ${relative(process.cwd(), file)}`);
}

const result = spawnSync(process.execPath, ['--test', ...files], {
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
