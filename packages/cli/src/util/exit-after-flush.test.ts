import { spawn } from 'node:child_process';
import path from 'node:path';

const FIXTURE = path.resolve(__dirname, '../../test/fixtures/chunked-exit.ts');
const TOTAL = 4 * 1024 * 1024;

// Runs the fixture with stdout on a pipe and a reader that starts late, so the child exits while
// most of its output is still queued in user space.
function runChild(mode: 'exit' | 'flush'): Promise<{ bytes: number; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-r', 'ts-node/register/transpile-only', FIXTURE, String(TOTAL), mode], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let bytes = 0;
    child.stdout.pause();
    setTimeout(() => child.stdout.resume(), 300);
    child.stdout.on('data', (buf: Buffer) => (bytes += buf.length));
    child.on('error', reject);
    child.on('close', (code) => resolve({ bytes, code }));
  });
}

describe('exitAfterFlush', () => {
  jest.setTimeout(60_000);

  it('process.exit() drops the tail of piped stdout (control)', async () => {
    const { bytes } = await runChild('exit');
    expect(bytes).toBeLessThan(TOTAL);
  });

  it('delivers all of piped stdout and exits with the given code', async () => {
    const { bytes, code } = await runChild('flush');
    expect(bytes).toBe(TOTAL);
    expect(code).toBe(7);
  });
});
