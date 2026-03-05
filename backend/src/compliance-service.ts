/**
 * Compliance Service — port 3003 (SSS-2 only)
 *
 * REST API for compliance operations: blacklist management, seizure, audit log.
 * All operations are submitted on-chain.
 *
 * Routes:
 *   POST   /compliance/blacklist         — Add to blacklist
 *   DELETE /compliance/blacklist/:addr   — Remove from blacklist
 *   GET    /compliance/blacklist         — List all blacklisted
 *   POST   /compliance/seize             — Seize tokens
 *   GET    /compliance/audit-log         — Audit trail
 *   GET    /health                       — Health check
 */

import express, { Request, Response, NextFunction } from "express";
import helmet from "helmet";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { SolanaStablecoin } from "@stbr/sss-token";
import { createLogger, format, transports } from "winston";
import { readFileSync, existsSync, writeFileSync } from "fs";
import BN from "bn.js";

// ─────────────────────────────────────────
// Config
// ─────────────────────────────────────────

const PORT = parseInt(process.env.PORT ?? "3003", 10);
const CLUSTER = process.env.SSS_CLUSTER ?? "https://api.devnet.solana.com";
const WALLET_PATH = process.env.SSS_WALLET ?? `${process.env.HOME}/.config/solana/id.json`;
const MINT_ADDRESS = process.env.SSS_MINT;
const AUDIT_LOG_PATH = process.env.AUDIT_LOG_PATH ?? "./compliance-audit.json";

// ─────────────────────────────────────────
// Logger
// ─────────────────────────────────────────

const logger = createLogger({
  format: format.combine(format.timestamp(), format.json()),
  transports: [new transports.Console()],
});

// ─────────────────────────────────────────
// Audit log
// ─────────────────────────────────────────

interface AuditEntry {
  id: string;
  action: "blacklist_add" | "blacklist_remove" | "seize";
  address: string;
  reason?: string;
  amount?: string;
  destination?: string;
  operator: string;
  tx: string;
  timestamp: string;
}

let auditLog: AuditEntry[] = [];

function loadAuditLog(): void {
  if (existsSync(AUDIT_LOG_PATH)) {
    try {
      auditLog = JSON.parse(readFileSync(AUDIT_LOG_PATH, "utf-8"));
    } catch {
      auditLog = [];
    }
  }
}

function appendAudit(entry: Omit<AuditEntry, "id" | "timestamp">): AuditEntry {
  const full: AuditEntry = {
    ...entry,
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    timestamp: new Date().toISOString(),
  };
  auditLog.push(full);
  try {
    writeFileSync(AUDIT_LOG_PATH, JSON.stringify(auditLog, null, 2));
  } catch {
    // non-critical
  }
  return full;
}

// ─────────────────────────────────────────
// State
// ─────────────────────────────────────────

let stable: SolanaStablecoin | null = null;
let operatorKp: Keypair | null = null;

async function initStable(): Promise<void> {
  if (!MINT_ADDRESS) throw new Error("SSS_MINT is required");
  const connection = new Connection(CLUSTER, "confirmed");
  const keypairData = JSON.parse(readFileSync(WALLET_PATH, "utf-8"));
  operatorKp = Keypair.fromSecretKey(Buffer.from(keypairData));
  stable = await SolanaStablecoin.load(
    connection,
    new PublicKey(MINT_ADDRESS),
    operatorKp
  );
  logger.info({ msg: "Compliance service initialized", mint: MINT_ADDRESS });
}

// ─────────────────────────────────────────
// App
// ─────────────────────────────────────────

const app = express();
app.use(helmet());
app.use(express.json());

app.use((req: Request, _res: Response, next: NextFunction) => {
  logger.info({ method: req.method, path: req.path });
  next();
});

app.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    service: "compliance",
    mint: MINT_ADDRESS ?? null,
    auditEntries: auditLog.length,
    timestamp: new Date().toISOString(),
  });
});

/**
 * POST /compliance/blacklist
 * Body: { address: string, reason: string, blacklisterKey?: number[] }
 */
app.post("/compliance/blacklist", async (req: Request, res: Response) => {
  try {
    if (!stable || !operatorKp) return res.status(503).json({ error: "Not initialized" });

    const { address, reason, blacklisterKey } = req.body as {
      address: string;
      reason: string;
      blacklisterKey?: number[];
    };

    if (!address || !reason) {
      return res.status(400).json({ error: "address and reason required" });
    }

    const blacklister = blacklisterKey
      ? Keypair.fromSecretKey(Buffer.from(blacklisterKey))
      : operatorKp;

    const tx = await stable.compliance.blacklistAdd({
      address: new PublicKey(address),
      reason,
      blacklister,
    });

    const entry = appendAudit({
      action: "blacklist_add",
      address,
      reason,
      operator: blacklister.publicKey.toBase58(),
      tx,
    });

    logger.info({ action: "blacklist_add", address, reason, tx });
    return res.status(201).json({ success: true, tx, auditId: entry.id });
  } catch (err: any) {
    logger.error({ action: "blacklist_add", error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /compliance/blacklist/:address
 * Body: { blacklisterKey?: number[] }
 */
app.delete("/compliance/blacklist/:address", async (req: Request, res: Response) => {
  try {
    if (!stable || !operatorKp) return res.status(503).json({ error: "Not initialized" });

    const { address } = req.params;
    const { blacklisterKey } = req.body as { blacklisterKey?: number[] };

    const blacklister = blacklisterKey
      ? Keypair.fromSecretKey(Buffer.from(blacklisterKey))
      : operatorKp;

    const tx = await stable.compliance.blacklistRemove({
      address: new PublicKey(address),
      blacklister,
    });

    const entry = appendAudit({
      action: "blacklist_remove",
      address,
      operator: blacklister.publicKey.toBase58(),
      tx,
    });

    logger.info({ action: "blacklist_remove", address, tx });
    return res.json({ success: true, tx, auditId: entry.id });
  } catch (err: any) {
    logger.error({ action: "blacklist_remove", error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /compliance/blacklist
 * Returns all blacklisted addresses.
 */
app.get("/compliance/blacklist", async (_req: Request, res: Response) => {
  try {
    if (!stable) return res.status(503).json({ error: "Not initialized" });

    const entries = await stable.compliance.getBlacklist();
    return res.json({
      count: entries.length,
      entries: entries.map((e) => ({
        address: e.address.toBase58(),
        reason: e.reason,
        addedBy: e.by.toBase58(),
        timestamp: new Date(e.timestamp.toNumber() * 1000).toISOString(),
      })),
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * POST /compliance/seize
 * Body: { source: string, destination: string, amount?: string, seizerKey?: number[] }
 */
app.post("/compliance/seize", async (req: Request, res: Response) => {
  try {
    if (!stable || !operatorKp) return res.status(503).json({ error: "Not initialized" });

    const { source, destination, amount, seizerKey } = req.body as {
      source: string;
      destination: string;
      amount?: string;
      seizerKey?: number[];
    };

    if (!source || !destination) {
      return res.status(400).json({ error: "source and destination required" });
    }

    const seizer = seizerKey
      ? Keypair.fromSecretKey(Buffer.from(seizerKey))
      : operatorKp;

    let seizureAmount: BN;
    if (amount) {
      seizureAmount = new BN(amount);
    } else {
      seizureAmount = await stable.getBalance(new PublicKey(source));
    }

    const tx = await stable.compliance.seize({
      source: new PublicKey(source),
      destination: new PublicKey(destination),
      amount: seizureAmount,
      seizer,
    });

    const entry = appendAudit({
      action: "seize",
      address: source,
      amount: seizureAmount.toString(),
      destination,
      operator: seizer.publicKey.toBase58(),
      tx,
    });

    logger.info({ action: "seize", source, destination, amount: seizureAmount.toString(), tx });
    return res.json({ success: true, tx, amount: seizureAmount.toString(), auditId: entry.id });
  } catch (err: any) {
    logger.error({ action: "seize", error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /compliance/audit-log
 * Query params: action, limit, offset, since
 */
app.get("/compliance/audit-log", (req: Request, res: Response) => {
  const { action, limit = "100", offset = "0", since } = req.query as Record<string, string>;

  let filtered = [...auditLog].reverse(); // newest first

  if (action) {
    filtered = filtered.filter((e) => e.action === action);
  }
  if (since) {
    const sinceDate = new Date(since).getTime();
    filtered = filtered.filter((e) => new Date(e.timestamp).getTime() >= sinceDate);
  }

  const total = filtered.length;
  const page = filtered.slice(parseInt(offset), parseInt(offset) + parseInt(limit));

  return res.json({ total, offset: parseInt(offset), limit: parseInt(limit), entries: page });
});

// ─────────────────────────────────────────
// Start
// ─────────────────────────────────────────

loadAuditLog();
initStable()
  .then(() => {
    app.listen(PORT, () => {
      logger.info({ msg: `Compliance service listening on port ${PORT}` });
    });
  })
  .catch((err) => {
    logger.warn({ msg: "Starting without stablecoin", error: err.message });
    app.listen(PORT, () => {
      logger.info({ msg: `Compliance service listening on port ${PORT} (no mint)` });
    });
  });

export default app;
