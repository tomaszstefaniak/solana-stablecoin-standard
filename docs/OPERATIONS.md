# Operations Runbook

## Daily Operations

### Check Status
```bash
sss-token status
```

### Mint Tokens
```bash
sss-token mint <recipient_token_account> <amount_in_base_units>
# Example: mint 1000 MUSD (6 decimals)
sss-token mint 7Hx...abc 1000000000
```

### Burn Tokens
```bash
sss-token burn <amount>
```

## Emergency Procedures

### Pause All Activity
```bash
sss-token pause --wallet <pauser_wallet>
```

### Freeze Suspicious Account
```bash
sss-token freeze <token_account_address>
```

### SSS-2: Blacklist Address
```bash
sss-token blacklist add <token_account> --reason "Regulatory order #2025-001"
```

### SSS-2: Seize Assets
```bash
sss-token seize <source_token_account> --to <treasury_token_account>
```

### Transfer Authority (Emergency)
```bash
# Step 1 (current authority)
sss-token transfer-authority <new_authority_pubkey>

# Step 2 (new authority, different machine)
sss-token accept-authority
```

## Role Assignment

```bash
# Assign roles
sss-token roles set pauser <pubkey>
sss-token roles set burner <pubkey>
sss-token roles set blacklister <pubkey>   # SSS-2 only
sss-token roles set seizer <pubkey>        # SSS-2 only

# Revoke roles
sss-token roles revoke pauser
```

## Minter Management

```bash
# Add minter (quota = 1M per day)
sss-token minters add <pubkey> --quota 1000000000000 --epoch 86400

# List minters
sss-token minters list
```

## Backend Services

```bash
# Start all services
cd backend && docker-compose up -d

# Check health
curl http://localhost:3001/health
curl http://localhost:3002/health
curl http://localhost:3003/health

# Query events
curl "http://localhost:3002/events?type=Minted&limit=10"

# Compliance audit
curl "http://localhost:3003/compliance/audit-log"
```
