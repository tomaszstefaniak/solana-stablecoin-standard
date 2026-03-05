# Architecture

## Overview

SSS is a three-layer framework:

```
Layer 3 — Presets: SSS-1, SSS-2
Layer 2 — Modules: Compliance, Transfer Hook, Role Manager
Layer 1 — Base SDK: Token-2022, TypeScript SDK, CLI
```

## Programs

### sss-token

The main Anchor program. Owns all business logic for both SSS-1 and SSS-2.

**Program ID:** `Gx4YCpm4DhBwDaqZya9QY2ydTP6hVa3ffPSdViPJ45x8`

### transfer-hook

Invoked by Token-2022 on every token transfer (SSS-2 only).

**Program ID:** `9chamxxgkipFSo3VV53sNnLFRk14oJTrKFzRaHRgowfN`

## Account Layout

### GlobalState PDA (seeds: ["sss", mint])

```
master_authority:          Pubkey   (32)
mint:                      Pubkey   (32)
name:                      String   (4 + MAX_NAME_LEN)
symbol:                    String   (4 + MAX_SYMBOL_LEN)
uri:                       String   (4 + MAX_URI_LEN)
decimals:                  u8       (1)
enable_permanent_delegate: bool     (1)
enable_transfer_hook:      bool     (1)
default_account_frozen:    bool     (1)
is_paused:                 bool     (1)
pending_authority:         Option<Pubkey> (1 + 32)
bump:                      u8       (1)
```

### RoleRegistry PDA (seeds: ["roles", mint])

```
mint:        Pubkey          (32)
pauser:      Option<Pubkey>  (1 + 32)
burner:      Option<Pubkey>  (1 + 32)
blacklister: Option<Pubkey>  (1 + 32)  [SSS-2]
seizer:      Option<Pubkey>  (1 + 32)  [SSS-2]
bump:        u8              (1)
```

### MinterState PDA (seeds: ["minter", mint, minter])

```
mint:               Pubkey  (32)
minter:             Pubkey  (32)
max_quota:          u64     (8)
minted_this_epoch:  u64     (8)
epoch_start:        i64     (8)
epoch_duration:     i64     (8)
bump:               u8      (1)
```

### BlacklistEntry PDA (seeds: ["blacklist", mint, address])

```
mint:       Pubkey  (32)
address:    Pubkey  (32)
reason:     String  (4 + MAX_REASON_LEN)
timestamp:  i64     (8)
by:         Pubkey  (32)
bump:       u8      (1)
```

## Data Flows

### Mint Flow

```
Minter → sss-token::mint → [check paused] → [check minter role]
       → [check quota] → [update quota] → Token-2022::mint_to
       → Emit Minted event
```

### Transfer Flow (SSS-2)

```
User → Token-2022::transfer_checked → Transfer Hook invoked
     → transfer_hook::execute
         → [read GlobalState.is_paused]
         → [check source blacklist PDA]
         → [check destination blacklist PDA]
         → [accept or reject]
     → Token-2022 completes or rejects transfer
```

### Seize Flow (SSS-2)

```
Seizer → sss-token::seize → [check seizer role]
       → [check enable_permanent_delegate]
       → Token-2022::transfer_checked (global_state PDA as permanent delegate)
       → Emit Seized event
```

## Security Model

1. **Role isolation**: each role is stored on-chain; no off-chain signatures can bypass.
2. **Feature gating**: SSS-2 instructions check `enable_transfer_hook` / `enable_permanent_delegate` flags set immutably at mint creation.
3. **Overflow protection**: `overflow-checks = true` in profile.dev + profile.release; all arithmetic uses Rust checked ops.
4. **Authority transfer**: two-step (propose + accept) prevents accidental or phishing-based authority hijack.
5. **Anchor constraints**: PDA seeds are verified by Anchor macros, preventing seed confusion attacks.
