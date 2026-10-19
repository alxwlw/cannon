// Child process for exit-after-flush.test.ts: writes `total` bytes to stdout in 16-byte chunks,
// the way `inspect --out deploy-json` does, then exits either the old way (`process.exit()`) or
// through `exitAfterFlush`.
import { exitAfterFlush } from '../../src/util/exit-after-flush';

const total = Number(process.argv[2]);
const mode = process.argv[3];
const chunk = 'x'.repeat(16);

for (let written = 0; written < total; written += chunk.length) {
  process.stdout.write(chunk);
}

if (mode === 'exit') {
  process.exit();
} else {
  exitAfterFlush(7);
}
