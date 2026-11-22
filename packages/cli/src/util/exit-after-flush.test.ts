import { exitAfterFlush } from './exit-after-flush';
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

describe('exitAfterFlush exit code', () => {
  // the flush itself is covered by the spawned tests above; here the streams acknowledge at once
  const run = async (code?: number) => {
    const ack = (_chunk: unknown, cb?: () => void) => {
      cb?.();
      return true;
    };
    jest.spyOn(process.stdout, 'write').mockImplementation(ack as never);
    jest.spyOn(process.stderr, 'write').mockImplementation(ack as never);
    const before = process.exitCode;
    const exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    try {
      exitAfterFlush(code);
      expect(exit).toHaveBeenCalledTimes(1);
      return exit.mock.calls[0][0];
    } finally {
      process.exitCode = before;
      jest.restoreAllMocks();
    }
  };

  it('uses process.exitCode when no code is given', async () => {
    process.exitCode = 2;
    expect(await run()).toBe(2);
  });

  it('an explicit code wins over process.exitCode', async () => {
    process.exitCode = 2;
    expect(await run(7)).toBe(7);
  });
});
