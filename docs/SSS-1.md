# SSS-1: Minimal Stablecoin Standard

## What is SSS-1?

SSS-1 is the minimal viable stablecoin standard on Solana. It provides:

- **Token-2022 mint** with inline metadata (MetadataPointer extension)
- **Freeze authority** (managed by global_state PDA)
- **Role-based access control** (minter, burner, pauser via on-chain PDAs)
- **Per-minter quotas** with epoch-based resets
- **Pause / unpause** for emergency stops
- **Two-step authority transfer**

SSS-1 does NOT include compliance features (blacklist, seizure, transfer hook).

## When to use SSS-1

Use SSS-1 when:
- You need a simple custodial stablecoin
- Regulatory requirements don't mandate transfer-level enforcement
- You want minimal on-chain footprint and gas cost

## Instructions

| Instruction             | Who Can Call         |
|-------------------------|----------------------|
| initialize              | Anyone (payer)       |
| mint                    | minter + quota       |
| burn                    | burner or master     |
| freeze_account          | master or pauser     |
| thaw_account            | master or pauser     |
| pause                   | master or pauser     |
| unpause                 | master or pauser     |
| update_minter           | master               |
| update_roles            | master               |
| propose_authority_transfer | master            |
| accept_authority_transfer  | pending authority |

## Example Deployment

```bash
sss-token init --preset sss-1 --name "MyUSD" --symbol "MUSD" --decimals 6
sss-token minters add <address> --quota 1000000000
sss-token mint <recipient> 1000000
sss-token status
```
