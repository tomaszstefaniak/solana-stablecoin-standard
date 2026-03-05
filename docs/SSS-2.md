# SSS-2: Compliant Stablecoin Standard

## What is SSS-2?

SSS-2 extends SSS-1 with full regulatory compliance features:

- **Transfer hook**: every token transfer is checked against the blacklist and pause state
- **Permanent delegate**: enables seizure without the account owner's signature
- **Default account state (frozen)**: all new token accounts start frozen until explicitly thawed
- **Blacklist PDAs**: on-chain blacklist entries with audit trail
- **Compliance roles**: blacklister + seizer

## When to use SSS-2

Use SSS-2 when:
- You must comply with OFAC sanctions enforcement
- Your jurisdiction requires asset freezing and seizure capabilities
- The GENIUS Act or similar legislation applies
- Institutional partners require proof of compliance controls

## How the Transfer Hook Works

1. User submits a `transfer_checked` instruction to Token-2022
2. Token-2022 detects the `TransferHook` extension on the mint
3. Token-2022 invokes `transfer_hook::execute` with the transfer accounts
4. The hook reads:
   - `GlobalState.is_paused` (if true → reject with `TransferPaused`)
   - `BlacklistEntry` PDA for source (if exists → reject with `SourceBlacklisted`)
   - `BlacklistEntry` PDA for destination (if exists → reject with `DestinationBlacklisted`)
5. If all checks pass → Token-2022 completes the transfer

## How Seizure Works

1. Seizer calls `sss-token::seize(source, destination, amount)`
2. Program checks: seizer role + `enable_permanent_delegate = true`
3. Program signs as `global_state` PDA (which is the permanent delegate)
4. Token-2022 transfers tokens from source to destination (no owner signature needed)
5. `Seized` event emitted for indexer

## Instructions (SSS-2 additional)

| Instruction          | Who Can Call         |
|----------------------|----------------------|
| add_to_blacklist     | blacklister or master |
| remove_from_blacklist| blacklister or master |
| seize                | seizer or master      |

## Regulatory Considerations

- All blacklist operations emit on-chain events for regulatory reporting
- The compliance service maintains an off-chain audit log with timestamps and reasons
- Authority transfer is two-step to prevent accidental compliance authority loss
- Permanent delegate is set at mint creation — it cannot be changed or removed

## Example Deployment

```bash
sss-token init --preset sss-2 --name "RegUSD" --symbol "RUSD" --decimals 6
sss-token roles set blacklister <compliance_officer_key>
sss-token roles set seizer <legal_authority_key>
sss-token blacklist add <suspected_address> --reason "OFAC SDN list match"
sss-token seize <suspected_address> --to <treasury_account>
```
