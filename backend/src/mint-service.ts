/**
 * Mint/Burn Service — port 3001
 *
 * REST API for minting and burning SSS tokens.
 * All operations are submitted on-chain.
 *
 * Routes:
 *   POST /mint     — Mint tokens to a recipient
 *   POST /burn     — Burn tokens from a burner's account
 *   GET  /supply   — Total supply
 *   GET  /health   — Health check
 */

import express, { Request, Response, NextFunction } from "express";
import helmet from "helmet";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { SolanaStablecoin } from "@stbr/sss-token";
import BN from "bn.js";
import { createLogger, format, transports } from "winston";
import { readFileSync } from "fs";

// ─────────────────────────────────────────
// Config
// ─────────────────────────────────────────

const PORT = parseInt(process.env.PORT ?? "3001", 10);
const CLUSTER = process.env.SSS_CLUSTER ?? "https://api.devnet.solana.com";
const WALLET_PATH = process.env.SSS_WALLET ?? `${process.env.HOME}/.config/solana/id.json`;
const MINT_ADDRESS = process.env.SSS_MINT;

// ─────────────────────────────────────────
// Logger
// ─────────────────────────────────────────

const logger = createLogger({
  format: format.combine(format.timestamp(), format.json()),
  transports: [new transports.Console()],
});

// ─────────────────────────────────────────
// App
// ─────────────────────────────────────────

const app = express();
app.use(helmet());
app.use(express.json());

// Request logging middleware
app.use((req: Request, _res: Response, next: NextFunction) => {
  logger.info({ method: req.method, path: req.path, body: req.body });
  next();
});

// ─────────────────────────────────────────
// State
// ─────────────────────────────────────────

let stable: SolanaStablecoin | null = null;

async function initStable(): Promise<void> {
  if (!MINT_ADDRESS) throw new Error("SSS_MINT env variable is required");
  const connection = new Connection(CLUSTER, "confirmed");
  const keypairData = JSON.parse(readFileSync(WALLET_PATH, "utf-8"));
  const signer = Keypair.fromSecretKey(Buffer.from(keypairData));
  stable = await SolanaStablecoin.load(
    connection,
    new PublicKey(MINT_ADDRESS),
    signer
  );
  logger.info({ msg: "Stablecoin loaded", mint: MINT_ADDRESS });
}

// ─────────────────────────────────────────
// Routes
// ─────────────────────────────────────────

app.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    service: "mint-service",
    mint: MINT_ADDRESS ?? null,
    timestamp: new Date().toISOString(),
  });
});

/**
 * POST /mint
 * Body: { recipient: string, amount: string, minterKey: number[] }
 */
app.post("/mint", async (req: Request, res: Response) => {
  try {
    if (!stable) {
      return res.status(503).json({ error: "Service not initialized" });
    }

    const { recipient, amount, minterKey } = req.body as {
      recipient: string;
      amount: string;
      minterKey: number[];
    };

    if (!recipient || !amount || !minterKey) {
      return res.status(400).json({ error: "recipient, amount, minterKey required" });
    }

    const minter = Keypair.fromSecretKey(Buffer.from(minterKey));
    const tx = await stable.mint({
      recipient: new PublicKey(recipient),
      amount: new BN(amount),
      minter,
    });

    logger.info({ action: "mint", recipient, amount, tx });
    return res.json({ success: true, tx, recipient, amount });
  } catch (err: any) {
    logger.error({ action: "mint", error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

/**
 * POST /burn
 * Body: { amount: string, burnerKey: number[], tokenAccount?: string }
 */
app.post("/burn", async (req: Request, res: Response) => {
  try {
    if (!stable) {
      return res.status(503).json({ error: "Service not initialized" });
    }

    const { amount, burnerKey, tokenAccount } = req.body as {
      amount: string;
      burnerKey: number[];
      tokenAccount?: string;
    };

    if (!amount || !burnerKey) {
      return res.status(400).json({ error: "amount, burnerKey required" });
    }

    const burner = Keypair.fromSecretKey(Buffer.from(burnerKey));
    const tx = await stable.burn({
      amount: new BN(amount),
      burner,
      tokenAccount: tokenAccount ? new PublicKey(tokenAccount) : undefined,
    });

    logger.info({ action: "burn", amount, tx });
    return res.json({ success: true, tx, amount });
  } catch (err: any) {
    logger.error({ action: "burn", error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /supply
 * Returns the total token supply.
 */
app.get("/supply", async (_req: Request, res: Response) => {
  try {
    if (!stable) {
      return res.status(503).json({ error: "Service not initialized" });
    }
    const supply = await stable.getTotalSupply();
    return res.json({ supply: supply.toString() });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────
// Start
// ─────────────────────────────────────────

initStable()
  .then(() => {
    app.listen(PORT, () => {
      logger.info({ msg: `Mint service listening on port ${PORT}` });
    });
  })
  .catch((err) => {
    logger.warn({ msg: "Running without stablecoin (set SSS_MINT to enable)", error: err.message });
    app.listen(PORT, () => {
      logger.info({ msg: `Mint service listening on port ${PORT} (no mint)` });
    });
  });

export default app;
