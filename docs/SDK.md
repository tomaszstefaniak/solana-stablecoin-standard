# TypeScript SDK Reference (@stbr/sss-token)

## Installation

```bash
npm install @stbr/sss-token
```

## SolanaStablecoin

### SolanaStablecoin.create(connection, params)

Creates a new stablecoin.

```typescript
const stable = await SolanaStablecoin.create(connection, {
  preset: Presets.SSS_2,          // or Presets.SSS_1
  name: "MyUSD",                  // max 64 chars
  symbol: "MUSD",                 // max 16 chars
  uri: "https://example.com/meta.json", // max 256 chars
  decimals: 6,                    // default: 6
  authority: adminKeypair,        // master authority
  mint: optionalMintKeypair,      // optional, generated if omitted
});
```

### SolanaStablecoin.load(connection, mintPubkey, signer)

Loads an existing stablecoin.

```typescript
const stable = await SolanaStablecoin.load(connection, new PublicKey(mint), signer);
```

### Core Operations

```typescript
// Mint
await stable.mint({ recipient, amount, minter, createAta?: boolean });

// Burn
await stable.burn({ amount, burner, tokenAccount?: PublicKey });

// Freeze / Thaw
await stable.freeze(tokenAccount, authority);
await stable.thaw(tokenAccount, authority);

// Pause / Unpause
await stable.pause(authority);
await stable.unpause(authority);
```

### Role Management

```typescript
// Add/update minter
await stable.updateMinter({ minter, maxQuota, epochDuration?, authority });

// Update role
await stable.updateRoles({ roleType, newKey, authority });
// roleType: "pauser" | "burner" | "blacklister" | "seizer"

// Transfer authority (two-step)
await stable.proposeAuthorityTransfer({ newAuthority, currentAuthority });
await stable.acceptAuthorityTransfer({ newAuthority });
```

### Queries

```typescript
const gs = await stable.getGlobalState();     // GlobalState
const roles = await stable.getRoles();         // RoleRegistry
const ms = await stable.getMinterState(minter); // MinterState | null
const supply = await stable.getTotalSupply();  // BN
const balance = await stable.getBalance(ata); // BN
const ata = stable.ata(ownerPubkey);          // PublicKey
```

## ComplianceModule (SSS-2)

Accessed via `stable.compliance`:

```typescript
// Blacklist
await stable.compliance.blacklistAdd({ address, reason, blacklister });
await stable.compliance.blacklistRemove({ address, blacklister });
const isBlacklisted = await stable.compliance.isBlacklisted(address);
const list = await stable.compliance.getBlacklist(); // BlacklistEntry[]

// Seizure
await stable.compliance.seize({ source, destination, amount, seizer });
```

## Presets

```typescript
import { Presets, PRESET_CONFIGS, PRESET_DESCRIPTIONS } from "@stbr/sss-token";

Presets.SSS_1  // "sss-1"
Presets.SSS_2  // "sss-2"
```
