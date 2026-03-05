# Backend API Reference

## Mint Service (port 3001)

### GET /health
Returns service health status.

**Response:**
```json
{ "status": "ok", "service": "mint-service", "mint": "...", "timestamp": "..." }
```

### POST /mint
Mint tokens to a recipient.

**Request:**
```json
{
  "recipient": "<token_account_pubkey>",
  "amount": "1000000",
  "minterKey": [1, 2, 3, ...]
}
```

**Response:**
```json
{ "success": true, "tx": "<signature>", "recipient": "...", "amount": "1000000" }
```

### POST /burn
Burn tokens.

**Request:**
```json
{
  "amount": "500000",
  "burnerKey": [1, 2, 3, ...],
  "tokenAccount": "<optional_token_account>"
}
```

### GET /supply
Returns total token supply.

**Response:**
```json
{ "supply": "10000000000" }
```

---

## Event Indexer (port 3002)

### GET /health
Service health + event count.

### GET /events
Returns paginated event list.

**Query params:**
- `type` — filter by event type (e.g., `Minted`, `Seized`)
- `limit` — max results (default: 100)
- `offset` — pagination offset (default: 0)
- `since` — ISO timestamp filter

**Response:**
```json
{
  "total": 42,
  "offset": 0,
  "limit": 100,
  "events": [
    {
      "id": "...",
      "type": "Minted",
      "data": { "raw": "..." },
      "slot": 12345,
      "signature": "...",
      "timestamp": "2025-03-15T10:00:00.000Z"
    }
  ]
}
```

---

## Compliance Service (port 3003)

### GET /health
Service health.

### POST /compliance/blacklist
Add address to blacklist.

**Request:**
```json
{
  "address": "<token_account_pubkey>",
  "reason": "OFAC SDN match",
  "blacklisterKey": [1, 2, 3, ...]
}
```

**Response:**
```json
{ "success": true, "tx": "...", "auditId": "..." }
```

### DELETE /compliance/blacklist/:address
Remove from blacklist.

### GET /compliance/blacklist
List all blacklisted addresses.

**Response:**
```json
{
  "count": 2,
  "entries": [
    {
      "address": "...",
      "reason": "OFAC SDN match",
      "addedBy": "...",
      "timestamp": "2025-03-15T10:00:00.000Z"
    }
  ]
}
```

### POST /compliance/seize
Seize tokens.

**Request:**
```json
{
  "source": "<source_token_account>",
  "destination": "<destination_token_account>",
  "amount": "1000000",
  "seizerKey": [1, 2, 3, ...]
}
```

### GET /compliance/audit-log
Full compliance audit trail with pagination.

**Query params:** `action`, `limit`, `offset`, `since`
