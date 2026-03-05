# Task: Build the Solana Stablecoin Standard (SSS)

You are building a complete, production-quality SDK for stablecoins on Solana.
Working directory: ~/Projects/solana-stablecoin-standard (already on branch feat/sss-token-sdk)
Submit to: github.com/tomaszstefaniak/solana-stablecoin-standard (fork), PR will go to solanabr/solana-stablecoin-standard

## Context
This is a bounty submission for Superteam Brazil. Prize: $5,000 USDC. Reference repo for quality/structure: github.com/solanabr/solana-vault-standard.
The repo currently has only a LICENSE file. Build everything from scratch.

## Architecture (3 layers)

### Layer 1 — Base SDK
- Token-2022 mint creation with: metadata extension, freeze authority, mint authority
- Role management program (Anchor)
- TypeScript SDK + CLI

### Layer 2 — Modules (composable, optional)
- Compliance module: transfer hook program, blacklist PDAs, permanent delegate
- Each module independently testable

### Layer 3 — Standard Presets
- **SSS-1 (Minimal Stablecoin):** mint authority + freeze authority + metadata. Nothing more.
- **SSS-2 (Compliant Stablecoin):** SSS-1 + permanent delegate + transfer hook + blacklist enforcement

## Repo Structure to Create
```
solana-stablecoin-standard/
├── programs/
│   ├── sss-token/          # Main Anchor program (SSS-1 + SSS-2)
│   │   └── src/lib.rs
│   └── transfer-hook/      # Transfer hook program (SSS-2 only)
│       └── src/lib.rs
├── sdk/                    # TypeScript SDK (@stbr/sss-token)
│   ├── src/
│   │   ├── index.ts
│   │   ├── presets.ts
│   │   ├── stablecoin.ts
│   │   ├── compliance.ts   # SSS-2 compliance module
│   │   └── types.ts
│   ├── package.json
│   └── tsconfig.json
├── cli/                    # Admin CLI (sss-token command)
│   ├── src/
│   │   └── index.ts
│   └── package.json
├── backend/                # Backend services (TypeScript + Docker)
│   ├── src/
│   │   ├── mint-service.ts
│   │   ├── indexer.ts
│   │   └── compliance-service.ts  # SSS-2
│   ├── Dockerfile
│   ├── docker-compose.yml
│   └── package.json
├── tests/
│   ├── sss-1.ts            # SSS-1 integration tests
│   ├── sss-2.ts            # SSS-2 integration tests
│   └── unit/
├── docs/
│   ├── SSS-1.md
│   ├── SSS-2.md
│   ├── ARCHITECTURE.md
│   ├── SDK.md
│   ├── OPERATIONS.md
│   ├── COMPLIANCE.md
│   └── API.md
├── Anchor.toml
├── Cargo.toml
├── package.json
└── README.md
```

## On-Chain Program (Anchor 0.30.x)

### StablecoinConfig
```rust
pub struct StablecoinConfig {
    pub name: String,
    pub symbol: String,
    pub uri: String,
    pub decimals: u8,
    // SSS-2 compliance flags
    pub enable_permanent_delegate: bool,
    pub enable_transfer_hook: bool,
    pub default_account_frozen: bool,
}
```

### Roles (stored in a RoleRegistry PDA)
- `master_authority` — can do everything, transfer authority
- `minter` — can mint, has per-minter quotas (max_mint_amount per epoch)
- `burner` — can burn
- `blacklister` — SSS-2 only, can add/remove blacklist
- `pauser` — can pause/unpause
- `seizer` — SSS-2 only, can seize via permanent delegate

### Core Instructions (all presets)
- `initialize(config: StablecoinConfig)` — creates mint with Token-2022 extensions based on config
- `mint(recipient, amount)` — requires minter role + quota check + not paused
- `burn(amount)` — requires burner role + not paused
- `freeze_account(target)` — requires master or pauser
- `thaw_account(target)` — requires master or pauser
- `pause()` — requires pauser role
- `unpause()` — requires pauser role
- `update_minter(minter, new_quota)` — requires master authority
- `update_roles(role_type, new_key)` — requires master authority
- `transfer_authority(new_master)` — requires master authority (two-step: propose + accept)

### SSS-2 Additional Instructions
- `add_to_blacklist(address, reason)` — requires blacklister; creates blacklist PDA
- `remove_from_blacklist(address)` — requires blacklister; closes blacklist PDA
- `seize(source_account, destination_account, amount)` — requires seizer; uses permanent delegate

### Transfer Hook Program (SSS-2)
Separate program that intercepts every token transfer and:
1. Checks if source account is blacklisted (via blacklist PDA lookup)
2. Checks if destination account is blacklisted
3. Checks if token is paused (via global state PDA)
4. Rejects transfer if any check fails

### Security Requirements
- All SSS-2 instructions MUST fail with clear error if `enable_transfer_hook`/`enable_permanent_delegate` was false at init
- PDA seeds for all accounts (deterministic derivation)
- Checked arithmetic throughout (no overflow)
- Emit events for all state changes (for indexer)
- Reentrancy safety (Anchor's account model handles this, but note it)

### Account Seeds
- Stablecoin config: `["sss", mint_pubkey]`
- Role registry: `["roles", mint_pubkey]`
- Blacklist entry: `["blacklist", mint_pubkey, address_pubkey]`
- Minter state: `["minter", mint_pubkey, minter_pubkey]`

## TypeScript SDK

```typescript
import { SolanaStablecoin, Presets } from "@stbr/sss-token";

// Preset initialization
const stable = await SolanaStablecoin.create(connection, {
  preset: Presets.SSS_2,
  name: "My Stablecoin",
  symbol: "MYUSD",
  decimals: 6,
  authority: adminKeypair,
});

// Or custom config
const custom = await SolanaStablecoin.create(connection, {
  name: "Custom Stable",
  symbol: "CUSD",
  extensions: {
    permanentDelegate: true,
    transferHook: false,
  },
});

// Operations
await stable.mint({ recipient, amount: 1_000_000, minter });
await stable.burn({ amount: 500_000, burner });
await stable.freeze(targetAccount);
await stable.thaw(targetAccount);
await stable.pause();
await stable.unpause();

// SSS-2 compliance
await stable.compliance.blacklistAdd(address, "Sanctions match");
await stable.compliance.blacklistRemove(address);
await stable.compliance.seize(frozenAccount, treasury, amount);

// Queries
const supply = await stable.getTotalSupply();
const isBlacklisted = await stable.compliance.isBlacklisted(address);
const roles = await stable.getRoles();
```

## Admin CLI

The CLI must support these exact commands:
```bash
# Preset init
sss-token init --preset sss-1 --name "MyUSD" --symbol "MUSD" --decimals 6
sss-token init --preset sss-2 --name "RegUSD" --symbol "RUSD" --decimals 6
sss-token init --custom config.toml

# Core operations
sss-token mint <recipient> <amount>
sss-token burn <amount>
sss-token freeze <address>
sss-token thaw <address>
sss-token pause
sss-token unpause
sss-token status        # show supply, roles, pause state
sss-token supply        # show total supply

# Role management
sss-token minters list
sss-token minters add <address> --quota <amount>
sss-token minters remove <address>

# SSS-2 compliance
sss-token blacklist add <address> --reason "OFAC match"
sss-token blacklist remove <address>
sss-token blacklist list
sss-token seize <address> --to <treasury> [--amount <amount>]
sss-token audit-log [--action <type>] [--limit 100]

# Holder queries
sss-token holders [--min-balance <amount>]
```

Config via `--mint <address>` flag and `~/.config/sss-token/config.toml` file or env vars (SSS_CLUSTER, SSS_WALLET, SSS_MINT).

## Backend Services (TypeScript + Docker)

### Mint/Burn Service
REST API:
- `POST /mint` — {recipient, amount, minterKey} → submit mint tx
- `POST /burn` — {amount, burnerKey} → submit burn tx
- `GET /supply` — total supply
- `GET /health` — health check

### Event Indexer
- Subscribe to program logs on-chain
- Parse all SSS events (Minted, Burned, Blacklisted, Seized, Paused, etc.)
- Maintain in-memory + file-based event log
- `GET /events` — paginated event log
- `GET /events?type=Minted` — filtered

### Compliance Service (SSS-2)
- `POST /compliance/blacklist` — add to blacklist
- `DELETE /compliance/blacklist/:address` — remove
- `GET /compliance/blacklist` — list all blacklisted
- `POST /compliance/seize` — initiate seizure
- `GET /compliance/audit-log` — audit trail with timestamps + reasons

### Docker
```yaml
# docker-compose.yml
services:
  mint-service:
    ports: ["3001:3001"]
  indexer:
    ports: ["3002:3002"]
  compliance:
    ports: ["3003:3003"]
```

All services: environment-based config, structured JSON logging, /health endpoint.

## Tests

### SSS-1 Integration Tests (tests/sss-1.ts)
1. Initialize SSS-1 stablecoin
2. Add minter + set quota
3. Mint tokens to recipient
4. Verify balance + supply
5. Freeze account
6. Verify transfer blocked while frozen
7. Thaw account
8. Burn tokens
9. Pause + verify mint blocked
10. Unpause
11. Transfer authority

### SSS-2 Integration Tests (tests/sss-2.ts)
1. Initialize SSS-2 (with permanent delegate + transfer hook)
2. Mint tokens
3. Add to blacklist
4. Verify transfer blocked (transfer hook rejects)
5. Remove from blacklist
6. Verify transfer succeeds
7. Seize tokens via permanent delegate
8. Verify SSS-2 instructions fail on SSS-1 token (feature gating)

### Unit Tests
- Test each instruction's access control in isolation
- Test quota enforcement
- Test arithmetic edge cases

## Documentation Required

### README.md
- Overview of SSS (what it is, why it exists)
- Preset comparison table (SSS-1 vs SSS-2)
- Quick start (5 min to first stablecoin)
- Architecture diagram (ASCII)
- Links to all docs

### ARCHITECTURE.md
- Layer model explanation
- Data flows for mint/burn/transfer/seize
- Account layout diagrams
- PDA derivations
- Security model

### SSS-1.md
- Full spec of the Minimal Stablecoin Standard
- When to use SSS-1
- What you get, what you don't
- Example deployment

### SSS-2.md
- Full spec of the Compliant Stablecoin Standard
- When to use SSS-2 (regulatory requirements)
- How transfer hook works
- How seizure works
- Regulatory considerations

### SDK.md
- Full TypeScript SDK reference
- All methods with types
- Preset configs
- Custom config examples

### OPERATIONS.md
- Operator runbook
- Day-to-day operations (mint, freeze, blacklist, seize)
- Emergency procedures (pause, authority transfer)
- CLI examples for each operation

### COMPLIANCE.md
- Regulatory context (GENIUS Act, OFAC, etc.)
- Audit trail format
- Blacklist management procedures
- Seizure procedures

### API.md
- Backend API reference (all endpoints)
- Request/response schemas
- Authentication
- Error codes

## Important Notes

1. Use Anchor 0.30.x — same version as already installed on this machine
2. Use Token-2022 (spl-token-2022) for all mints — NOT legacy SPL Token
3. The transfer hook is a SEPARATE Anchor program (not part of the main program)
4. Permanent delegate must be set at mint creation time (Token-2022 extension, immutable after creation)
5. Transfer hook program address must be set at mint creation time (immutable after creation)
6. Default account state (frozen) is also a Token-2022 extension
7. For the test runner: integration tests should be skippable by default (RUN_INTEGRATION=true env var)
8. All events should be emitted via Anchor's #[event] macro for off-chain indexing
9. Minter quotas: track per-minter mint amounts with epoch-based reset (epoch = configurable time window)

## Workflow
1. Set up Anchor project structure (Anchor.toml, Cargo.toml, workspace)
2. Implement transfer hook program first (simpler)
3. Implement main sss-token program
4. Compile and verify (cargo check)
5. Write TypeScript SDK
6. Write CLI
7. Write backend services
8. Write tests (skip integration by default)
9. Write all documentation
10. Set up CI (.github/workflows/ci.yml) — cargo fmt, cargo check, npm builds, tsc checks
11. Commit everything to branch feat/sss-token-sdk
12. Push to github.com/tomaszstefaniak/solana-stablecoin-standard

## Quality Bar
- Follow the patterns from github.com/solanabr/solana-vault-standard (see README there for reference)
- Clean code, good comments, no hacks
- All access control must be iron-tight
- README must be excellent — this is what reviewers see first

## When Done
Run: openclaw system event --text "Done: Solana Stablecoin Standard (SSS-1 + SSS-2) built — Anchor program, TS SDK, CLI, backend, docs, tests. Branch feat/sss-token-sdk pushed." --mode now
