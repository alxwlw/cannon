import commandsConfig from './commands/config';

const mockPlan = jest.fn();
jest.mock('./commands/plan', () => ({ plan: (...a: unknown[]) => mockPlan(...a) }));

describe('cannon plan command', () => {
  const before = process.exitCode;
  beforeEach(() => {
    mockPlan.mockReset();
    mockPlan.mockResolvedValue({ report: {}, exitCode: 2 });
    process.exitCode = undefined;
  });
  afterAll(() => {
    process.exitCode = before;
  });
  // commander keeps option values between parses, so every run gets a fresh program
  const run = (...args: string[]) => {
    let cli!: typeof import('./index').default;
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      cli = require('./index').default;
    });
    return cli.parseAsync(['node', 'cannon', 'plan', ...args]);
  };

  it('maps the options to PlanOptions and sets process.exitCode from the result', async () => {
    await run(
      'pkg:1.0.0',
      '-n',
      'http://rpc.invalid',
      '-c',
      '5',
      '--cannonfile',
      'c.toml',
      '--hints',
      'h.cjs',
      '--block',
      '123',
      '--depth',
      '2',
      '--no-bytecode',
      '-o',
      'outdir',
      '--json'
    );
    expect(mockPlan).toHaveBeenCalledWith({
      packageRef: 'pkg:1.0.0',
      chainId: 5,
      rpcUrl: 'http://rpc.invalid',
      cannonfile: 'c.toml',
      hints: 'h.cjs',
      block: 123n,
      depth: 2,
      bytecode: false,
      out: 'outdir',
      json: true,
    });
    expect(process.exitCode).toBe(2);
  });

  it('defaults: bytecode on, json off, optional values undefined; exit 0 stays 0', async () => {
    mockPlan.mockResolvedValue({ report: {}, exitCode: 0 });
    await run('pkg:1.0.0', '-n', 'http://rpc.invalid');
    expect(mockPlan).toHaveBeenCalledWith({
      packageRef: 'pkg:1.0.0',
      chainId: undefined,
      rpcUrl: 'http://rpc.invalid',
      cannonfile: undefined,
      hints: undefined,
      block: undefined,
      depth: undefined,
      bytecode: true,
      out: undefined,
      json: false,
    });
    expect(process.exitCode).toBe(0);
  });

  it('refuses without --rpc-url and never calls plan()', async () => {
    await expect(run('pkg:1.0.0')).rejects.toThrow('--rpc-url is required');
    expect(mockPlan).not.toHaveBeenCalled();
  });

  it.each([
    ['--depth', 'abc'],
    ['--depth', '-1'],
    ['--depth', '1.5'],
    ['--depth', ''],
    ['--block', 'abc'],
    ['--block', '-5'],
    ['--block', '0x10'],
    ['--block', '9007199254740993'],
  ])('refuses %s %s with a named one-line error, before plan()', async (flag, value) => {
    await expect(run('pkg:1.0.0', '-n', 'http://rpc.invalid', flag, value)).rejects.toThrow(
      new Error(`${flag} must be a non-negative integer, got "${value}"`)
    );
    expect(mockPlan).not.toHaveBeenCalled();
  });

  it('accepts 0 for --depth and --block', async () => {
    await run('pkg:1.0.0', '-n', 'http://rpc.invalid', '--depth', '0', '--block', '0');
    expect(mockPlan).toHaveBeenCalledWith(expect.objectContaining({ depth: 0, block: 0n }));
  });

  it('its help documents the exit codes and the exports of a hints module', () => {
    const config = commandsConfig.plan;
    expect(config.description).toContain('Exit code: 0 in sync, 2 drift or pending changes, 1 the run failed');
    const hints = (config.options ?? []).find((o) => o.flags === '--hints <file>');
    expect(hints?.description).toMatch(/`checks`.*`skip`.*`enumerations`/);
  });
});
