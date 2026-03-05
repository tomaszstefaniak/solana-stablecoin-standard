# Compliance Guide

## Regulatory Context

SSS-2 is designed to comply with:

- **OFAC (Office of Foreign Assets Control)**: sanctions enforcement via on-chain blacklist
- **GENIUS Act** (proposed US stablecoin legislation): issuer controls, freeze capabilities, redemption rights
- **FinCEN AML requirements**: audit trail for all compliance actions

## Blacklist Management

### Adding to Blacklist

1. Compliance officer receives OFAC SDN list match or court order
2. CLI or compliance service API call:
   ```bash
   sss-token blacklist add <token_account> --reason "OFAC SDN match: [name], [reason code]"
   ```
3. On-chain BlacklistEntry PDA is created immediately
4. All future transfers to/from this address are blocked by the transfer hook
5. Audit log entry created with timestamp and operator

### Removing from Blacklist

1. Legal clearance obtained
2. CLI call:
   ```bash
   sss-token blacklist remove <token_account>
   ```
3. BlacklistEntry PDA is closed (rent returned)
4. Transfers are allowed again immediately

## Seizure Procedures

Seizure requires:
1. Legal order (court order, regulatory directive)
2. Seizer role key (held by authorized officer)
3. Target account must be frozen first (recommended)

```bash
# Step 1: Freeze account
sss-token freeze <token_account>

# Step 2: Seize to treasury
sss-token seize <token_account> --to <treasury_token_account>
```

## Audit Trail

All compliance actions are recorded on-chain (via Anchor events) and in the
compliance service's audit log:

```json
{
  "id": "1234567890-abc",
  "action": "blacklist_add",
  "address": "7Hx...abc",
  "reason": "OFAC SDN match",
  "operator": "9xyz...def",
  "tx": "5abc...xyz",
  "timestamp": "2025-03-15T10:30:00.000Z"
}
```

Retrieve via:
```bash
curl "http://localhost:3003/compliance/audit-log"
```

## On-Chain Event Reference

| Event                      | Trigger                  |
|----------------------------|--------------------------|
| StablecoinInitialized      | Mint created             |
| Minted                     | Tokens minted            |
| Burned                     | Tokens burned            |
| AccountFrozen              | Account frozen           |
| AccountThawed              | Account thawed           |
| Paused                     | Mint paused              |
| Unpaused                   | Mint unpaused            |
| Blacklisted                | Address blacklisted      |
| RemovedFromBlacklist       | Address unblacklisted    |
| Seized                     | Tokens seized            |
| AuthorityTransferProposed  | Transfer initiated       |
| AuthorityTransferCompleted | Transfer completed       |
