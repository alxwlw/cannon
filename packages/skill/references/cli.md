# CLI Reference

## Debugging

If something is misbehaving, increase debugging verbosity:

```bash
# Using DEBUG environment variable (NodeJS debug module)
DEBUG=cannon:* cannon build

# Or using verbose flags (increasing verbosity)
cannon build -v    # basic verbosity
cannon build -vv   # more verbose
cannon build -vvv  # most verbose
```

## Build Command

```bash
cannon build [options]
```

Options:
- `--chain-id <id>` — Target chain ID (default: 13370, derived from `--rpc-url` if not specified)
- `--rpc-url <url>` — RPC endpoint URL
- `--private-key <key>` — Private key for deployment (or set `CANNON_PRIVATE_KEY` env var)
- `--impersonate <addresses>` — Impersonate specific addresses (comma-separated, recommended for dry-run)
- `--impersonate-all` — Impersonate all addresses (dry-run only)
- `--dry-run` — Simulate without sending transactions (always use before real deployments!)
- `--keep-alive` — Keep anvil running after build (useful with dry-run)
- `--port <port>` — Port for local anvil
- `--write-deployments <dir>` — Output directory for deployment files
- `--upgrade-from <ref>` — Upgrade from existing package (only if auto-detected package is wrong)

Note: If `cannon <package>` is run and the command isn't recognized, Cannon automatically executes `cannon run <package>`.

## Run Command

```bash
cannon run <package-reference> [options]
# Or simply:
cannon <package-reference>
```

Options:
- `--chain-id <id>` — Target chain ID (derived from `--rpc-url` if not specified)
- `--rpc-url <url>` — RPC endpoint URL
- `--private-key <key>` — Private key for transactions (or set `CANNON_PRIVATE_KEY` env var)
- `--impersonate <addresses>` — Impersonate specific addresses

Package reference: `<name>:<version>@<preset>` (preset is optional)

## Test Command

```bash
cannon test [options]
```

Designed to work with Foundry projects. Runs forge tests with Cannon deployment context.

Options:
- `--match-path <pattern>` — Match specific test files
- `--match-contract <pattern>` — Match specific contract tests
- `--chain-id <id>` — Chain ID for test context
- `--rpc-url <url>` — RPC endpoint for tests
- `--verbose` — Show detailed test output

See cannon-std documentation for testing patterns.

## Inspect Command

```bash
cannon inspect <package-reference> [options]
```

Options:
- `--chain-id <id>` — Chain ID
- `--out <format>` — Output format (json, yaml, toml, etc.)
- `--write-deployments <dir>` — Output directory for deployment files

Package reference: `<name>:<version>@<preset>`

## Plan Command

```bash
cannon plan <package-reference> --rpc-url <url> [options]
```

Read-only: checks a deployed package against the live chain and, with `--cannonfile`, lists what the next build would
change. It creates no signer, and every check reads one block, fixed at the start.

Options:
- `--rpc-url <url>` — RPC endpoint of the chain to check (required)
- `--chain-id <id>` — Chain ID of the variant to check
- `--cannonfile <path>` — Cannonfile to compare with the deployed record: the steps a build would add, change or remove
- `--hints <file>` — Hints module (CommonJS, or ESM as `.mjs`), see below
- `--block <number>` — Block to read every check at (default: the latest block); not above the head
- `--depth <number>` — Levels of cloned packages to walk into (default: all); a clone past it is one `unchecked` row
- `--no-bytecode` — Skip the deployed bytecode checks
- `--out <dir>` — Also write `plan.json` and `plan.md` into this directory
- `--json` — Print the report as JSON instead of Markdown

Exit codes:
- `0` — nothing drifted and nothing is pending; `unchecked`, `skipped`, `error` and `may-change` rows, and orphans
  that conflict with no declared step, keep 0
- `2` — a drift, an orphan whose effect explains a declared step's drift, or a step the cannonfile adds, changes or removes
- `1` — the run failed: bad options, an RPC on another chain, a record, registry or block that cannot be read

What is checked:
- each `invoke` step: the getter derived from the setter by name and types (`setX(v)` → `getX()` or `x()`,
  `addToX(m)` → `m` in `getX()`), or a hint for that setter; a value the contract changed and announced in the last
  argument of a recorded event counts as in sync
- the deployed bytecode of `deploy`, `router` and `diamond` contracts against the recorded artifact
- steps kept in the record but no longer in its definition (orphans), and the packages it cloned, up to `--depth`
- a pulled package is someone else's deployment: its `pull` step is one `unchecked` row, and it is not walked

Hints module:

```js
// hints.cjs
module.exports = {
  // keyed by setter function name; return null and the automatic rule runs
  checks: {
    async setThreshold({ step, setter, args, address, abi, events, read }) {
      // args are ABI-decoded: bigint, checksummed address, boolean, tuple object
      const live = await read(address, 'function threshold() view returns (uint256)', []);
      return {
        status: live === args[0] ? 'in-sync' : 'drift',
        getter: 'threshold',
        expected: args[0],
        actual: live,
        slot: { address, getter: 'threshold', keys: '[]' },
      };
    },
  },
  // steps never checked: names or RegExps
  skip: ['invoke.initialize', /^invoke\.legacy/],
  // each sees the walked rows and the same pinned `read`, and returns more report rows
  enumerations: [async ({ results, read }) => []],
};
```

- `expected` and `actual` are kept in one shape: a bigint becomes its decimal string, a 20-byte hex string is
  checksummed, any other hex string is lower case, arrays and plain objects element by element.
- `slot.keys` is a string that must identify exactly one value (for example the JSON of the key arguments): rows of one
  slot are linked, so an earlier drift is superseded and an orphan that wrote the live value explains the drift.
- A check that throws makes its row `error`; an enumeration that throws, or returns anything but an array of rows, is
  one `(enumeration <i>)` row with status `error`.

## Publish Command

```bash
cannon publish [options]
```

Options:
- `--chain-id <id>` — Target chain ID (default: mainnet or optimism)
- `--rpc-url <url>` — RPC endpoint (if not specified, will be requested via stdin)
- `--private-key <key>` — Private key with publish permissions (or set `CANNON_PRIVATE_KEY` env var)

Note: There is a fee each time a package is published (currently 0.0025 ETH). Cannon provides an IPFS service included in the publishing fee.

## Clean Command

```bash
cannon clean [options]
```

Options:
- `--no-confirm` — Skip confirmation prompt
- `--ipfs` — Delete only unreferenced IPFS packages

## Verify Command

```bash
cannon verify [options]
```

Options:
- `--chain-id <id>` — Target chain ID
- `--rpc-url <url>` — RPC endpoint
- `--etherscan-api-key <key>` — Etherscan API key
- `--service <name>` — Verification service: `etherscan`, `sourcify`, or `all` (verifies to both)

## Fetch Command

```bash
cannon fetch <package-reference> [options]
```

Options:
- `--chain-id <id>` — Target chain ID
- `--output-dir <dir>` — Output directory

## Interact Command

```bash
cannon interact <package-reference> [options]
```

Options:
- `--chain-id <id>` — Target chain ID
- `--rpc-url <url>` — RPC endpoint
- `--contract <name>` — Target contract name

## Trace Command

```bash
cannon trace <tx-hash> [options]
```

Options:
- `--chain-id <id>` — Target chain ID
- `--rpc-url <url>` — RPC endpoint
- `--verbose` — Show detailed trace

## Decode Command

```bash
cannon decode <package-reference> <hex-data> [options]
```

Options:
- `--chain-id <id>` — Target chain ID

Decodes function calls, events, and errors using package ABIs.

## Alter Command

Modify existing Cannon packages outside the regular build process.

```bash
cannon alter <package-reference> <subcommand> [options]
```

Subcommands:
- `import <step-type> <step-name> <tx-hash>` — Import existing deployment/transaction
- `set-contract-address <step-name> <address>` — Update contract address
- `mark-complete <step-name>` — Mark step as complete
- `mark-incomplete <step-name>` — Mark step as incomplete
- `set-url <url>` — Update deployment URL reference
- `set-misc <url>` — Update miscellaneous data URL
- `clean-unused` — Remove unused deployment states

Options:
- `--chain-id <id>` — Target chain ID

## Publishers Command

Manage additional publishers for a package.

```bash
cannon publishers <package-reference> [options]
```

Options:
- `--chain-id <id>` — Target chain ID (must be mainnet)
- `--rpc-url <url>` — RPC endpoint
- `--private-key <key>` — Owner's private key

Note: Additional publishers must be set on mainnet when publishing to Optimism.

## Register Command

Register a new package name on the registry.

```bash
cannon register <package-name> [options]
```

Options:
- `--chain-id <id>` — Target chain ID (mainnet only)
- `--rpc-url <url>` — RPC endpoint
- `--private-key <key>` — Private key

## Environment Variables

- `CANNON_PRIVATE_KEY` — Private key for deployments/publishing
- `CANNON_DIRECTORY` — Override default storage directory (default: `~/.local/share/cannon/`)
