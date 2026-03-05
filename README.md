# Solana Stablecoin Standard (SSS)

> A production-ready framework for issuing regulated stablecoins on Solana using Token-2022.

[![CI](https://github.com/tomaszstefaniak/solana-stablecoin-standard/actions/workflows/ci.yml/badge.svg)](https://github.com/tomaszstefaniak/solana-stablecoin-standard/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## Overview

The Solana Stablecoin Standard defines a layered, composable framework for deploying stablecoins on Solana. It provides two preset configurations that cover the most common use cases — from simple custodial tokens to fully regulated, compliance-enforced stablecoins.

### Why SSS?

Solana's Token-2022 program introduces powerful extensions (transfer hooks, permanent delegate, metadata, default account state) that enable regulatory compliance natively at the protocol level. SSS packages these extensions into auditable, role-based programs with a clean TypeScript SDK and admin CLI.

---

## Preset Comparison

| Feature                      | SSS-1 (Minimal) | SSS-2 (Compliant) |
|------------------------------|:---------------:|:-----------------:|
| Token-2022 mint              | ✓               | ✓                 |
| Inline metadata              | ✓               | ✓                 |
| Freeze authority             | ✓               | ✓                 |
| Role-based access control    | ✓               | ✓                 |
| Per-minter quotas            | ✓               | ✓                 |
| Pause / unpause              | ✓               | ✓                 |
| Two-step authority transfer  | ✓               | ✓                 |
| Transfer hook (blacklist)    | ✗               | ✓                 |
| Permanent delegate (seizure) | ✗               | ✓                 |
| Default account frozen       | ✗               | ✓                 |
| Compliance roles             | ✗               | ✓                 |

**Use SSS-1** for stablecoins that need basic mint/burn/freeze capabilities without full compliance machinery.

**Use SSS-2** for regulated stablecoins that must comply with OFAC sanctions lists, the GENIUS Act, or similar regulatory requirements.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                   SSS Framework                         │
│                                                         │
│  ┌─────────────────────────────────────────────────┐    │
│  │              Layer 3 — Presets                  │    │
│  │         SSS-1 (Minimal)  │  SSS-2 (Compliant)   │    │
│  └──────────────────────────┴──────────────────────┘    │
│                                                         │
│  ┌─────────────────────────────────────────────────┐    │
│  │            Layer 2 — Modules                    │    │
│  │  Role Manager  │  Compliance  │  Transfer Hook  │    │
│  └──────────────────────────────────────────────────┘    │
│                                                         │
│  ┌─────────────────────────────────────────────────┐    │
│  │             Layer 1 — Base SDK                  │    │
│  │   Token-2022 mint  │  TypeScript SDK  │  CLI    │    │
│  └─────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────┘

Programs:
  sss-token    — Main program (all SSS-1 + SSS-2 instructions)
  transfer-hook — Transfer hook program (invoked by Token-2022 on every transfer)

On-chain PDAs:
  ["sss", mint]               → GlobalState
  ["roles", mint]             → RoleRegistry
  ["minter", mint, minter]    → MinterState (per-minter quota)
  ["blacklist", mint, addr]   → BlacklistEntry (SSS-2)

Off-chain services:
  mint-service   :3001  — REST API for mint/burn
  indexer        :3002  — Event indexer (on-chain log subscriptions)
  compliance     :3003  — Compliance API (SSS-2)
```

---

## Quick Start

### Prerequisites

- Rust + Cargo
- Anchor CLI 0.30.x
- Node.js 20+
- Solana CLI

### 1. Install the SDK

```bash
npm install @stbr/sss-token
```

### 2. Initialize a stablecoin

```typescript
import { SolanaStablecoin, Presets } from "@stbr/sss-token";
import { Connection, Keypair } from "@solana/web3.js";

const connection = new Connection("https://api.devnet.solana.com", "confirmed");
const authority = Keypair.generate(); // load your keypair in production

// SSS-1: simple stablecoin
const stable = await SolanaStablecoin.create(connection, {
  preset: Presets.SSS_1,
  name: "My USD",
  symbol: "MUSD",
  decimals: 6,
  authority,
});

// SSS-2: compliant stablecoin
const compliantStable = await SolanaStablecoin.create(connection, {
  preset: Presets.SSS_2,
  name: "Regulated USD",
  symbol: "RUSD",
  decimals: 6,
  authority,
});
```

### 3. Mint tokens

```typescript
await stable.updateMinter({
  minter: minterKeypair.publicKey,
  maxQuota: 1_000_000_000_000n, // 1M tokens with 6 decimals
  authority,
});

await stable.mint({
  recipient: recipientPubkey,
  amount: 1_000_000n, // 1 MUSD
  minter: minterKeypair,
});
```

### 4. SSS-2 compliance

```typescript
// Blacklist an address (blocks all transfers to/from)
await compliantStable.compliance.blacklistAdd({
  address: suspiciousTokenAccount,
  reason: "OFAC SDN match — enforcement action",
  blacklister: blacklisterKeypair,
});

// Seize tokens without the account owner's signature
await compliantStable.compliance.seize({
  source: frozenAccount,
  destination: treasuryTokenAccount,
  amount: await compliantStable.getBalance(frozenAccount),
  seizer: seizerKeypair,
});
```

### 5. Admin CLI

```bash
# Initialize SSS-2 stablecoin
sss-token init --preset sss-2 --name "RegUSD" --symbol "RUSD" --decimals 6

# Mint 1000 tokens
sss-token mint <recipient_address> 1000000000

# Compliance operations
sss-token blacklist add <address> --reason "OFAC SDN match"
sss-token seize <source_account> --to <treasury>

# Status
sss-token status
```

### 6. Backend services

```bash
cd backend
SSS_MINT=<your_mint> docker-compose up
```

Services:
- Mint/burn API: `http://localhost:3001`
- Event indexer: `http://localhost:3002`
- Compliance API: `http://localhost:3003` (SSS-2)

---

## Repository Structure

```
solana-stablecoin-standard/
├── programs/
│   ├── sss-token/          # Main Anchor program (SSS-1 + SSS-2)
│   └── transfer-hook/      # Transfer hook (SSS-2 blacklist enforcement)
├── sdk/                    # @stbr/sss-token TypeScript SDK
├── cli/                    # sss-token admin CLI
├── backend/                # REST APIs + Docker
├── tests/                  # Integration + unit tests
├── docs/                   # Full documentation
└── .github/workflows/      # CI
```

---

## Documentation

| Document | Description |
|----------|-------------|
| [docs/SSS-1.md](docs/SSS-1.md) | Minimal Stablecoin Standard spec |
| [docs/SSS-2.md](docs/SSS-2.md) | Compliant Stablecoin Standard spec |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System architecture and data flows |
| [docs/SDK.md](docs/SDK.md) | Full TypeScript SDK reference |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | Operator runbook |
| [docs/COMPLIANCE.md](docs/COMPLIANCE.md) | Regulatory compliance guide |
| [docs/API.md](docs/API.md) | Backend API reference |

---

## Security

- **Iron-tight access control**: every instruction validates the caller's role via on-chain PDAs.
- **Checked arithmetic**: `overflow-checks = true` in Cargo.toml; all arithmetic uses Rust's checked operations.
- **Two-step authority transfer**: prevents accidental or malicious authority loss.
- **Immutable extensions**: Token-2022 extensions (permanent delegate, transfer hook) are set at mint creation and cannot be changed.
- **Reentrancy**: Anchor's account model prevents cross-instruction reentrancy by design.
- **SSS-2 feature gating**: SSS-2 instructions fail with `FeatureNotEnabled` if used on SSS-1 tokens.

---

## License

MIT © 2025 Superteam Brazil / Tomasz Stefaniak
