/**
 * Event Indexer — port 3002
 *
 * Subscribes to sss-token program logs and indexes all emitted events.
 * Maintains an in-memory event log with optional file persistence.
 *
 * Routes:
 *   GET /events              — Paginated event list
 *   GET /events?type=Minted  — Filtered by event type
 *   GET /health              — Health check
 */

import express, { Request, Response } from "express";
import helmet from "helmet";
import { Connection, PublicKey } from "@solana/web3.js";
import { SSS_TOKEN_PROGRAM_ID } from "@stbr/sss-token";
import { createLogger, format, transports } from "winston";
import { writeFileSync, existsSync, readFileSync } from "fs";

// ─────────────────────────────────────────
// Config
// ─────────────────────────────────────────

const PORT = parseInt(process.env.PORT ?? "3002", 10);
const CLUSTER = process.env.SSS_CLUSTER ?? "https://api.devnet.solana.com";
const EVENT_LOG_PATH = process.env.EVENT_LOG_PATH ?? "./events.json";
const MAX_EVENTS = parseInt(process.env.MAX_EVENTS ?? "10000", 10);

// ─────────────────────────────────────────
// Logger
// ─────────────────────────────────────────

const logger = createLogger({
  format: format.combine(format.timestamp(), format.json()),
  transports: [new transports.Console()],
});

// ─────────────────────────────────────────
// Event types (mirrors Anchor event definitions)
// ─────────────────────────────────────────

interface SssEvent {
  id: string;
  type: string;
  data: Record<string, unknown>;
  slot: number;
  signature: string;
  timestamp: string;
}

// ─────────────────────────────────────────
// In-memory event store
// ─────────────────────────────────────────

let events: SssEvent[] = [];

function persistEvents(): void {
  try {
    writeFileSync(EVENT_LOG_PATH, JSON.stringify(events, null, 2));
  } catch {
    // non-critical
  }
}

function loadPersistedEvents(): void {
  if (existsSync(EVENT_LOG_PATH)) {
    try {
      events = JSON.parse(readFileSync(EVENT_LOG_PATH, "utf-8"));
      logger.info({ msg: `Loaded ${events.length} events from disk` });
    } catch {
      events = [];
    }
  }
}

// ─────────────────────────────────────────
// Log parsing
// ─────────────────────────────────────────

/**
 * Anchor emits events as base64-encoded log lines prefixed with
 * "Program data: " followed by base64(discriminator + borsh-encoded data).
 * We parse them here.
 */
function parseEventFromLogs(
  logs: string[],
  slot: number,
  signature: string
): SssEvent[] {
  const result: SssEvent[] = [];

  for (const log of logs) {
    if (!log.startsWith("Program data: ")) continue;

    const b64 = log.slice("Program data: ".length);
    let decoded: Buffer;
    try {
      decoded = Buffer.from(b64, "base64");
    } catch {
      continue;
    }

    // Anchor event: first 8 bytes = sha256("event:<EventName>")[..8]
    // We pattern-match on known event discriminators.
    const hex = decoded.slice(0, 8).toString("hex");
    const eventName = EVENT_DISCRIMINATORS[hex];
    if (!eventName) continue;

    const event: SssEvent = {
      id: `${signature}-${result.length}`,
      type: eventName,
      data: { raw: decoded.slice(8).toString("hex") },
      slot,
      signature,
      timestamp: new Date().toISOString(),
    };

    result.push(event);
    logger.info({ msg: "Event indexed", type: eventName, signature });
  }

  return result;
}

/**
 * Known event discriminators (sha256("event:<Name>")[..8] as hex).
 * Generated via: sha256("event:Minted")[..8].
 * These are deterministic and can be pre-computed.
 */
const EVENT_DISCRIMINATORS: Record<string, string> = {
  // These would be computed from the actual Anchor IDL in production.
  // Placeholder values — replace with `anchor idl event-discriminator <name>`.
  "e445a52e51cb9a1d": "StablecoinInitialized",
  "4b1f8f47f8e3e3e3": "Minted",
  "b3d3b1f8f47f8e3e": "Burned",
  "a1d4b1f8f47f8e3e": "AccountFrozen",
  "c2e5c2f9f58f9f4f": "AccountThawed",
  "d3f6d3faf6afaf5f": "Paused",
  "e4f7e4fbf7bfbf6f": "Unpaused",
  "f5f8f5fcf8cfcf7f": "MinterUpdated",
  "a6f9a6fdf9dfdf8f": "RolesUpdated",
  "b7fab7fee0e0e09f": "AuthorityTransferProposed",
  "c8fbc8fff1f1f1af": "AuthorityTransferCompleted",
  "d9fcd9fff2f2f2bf": "Blacklisted",
  "eafdea00f3f3f3cf": "RemovedFromBlacklist",
  "fbfefb01f4f4f4df": "Seized",
};

// ─────────────────────────────────────────
// Subscription
// ─────────────────────────────────────────

let subscriptionId: number | null = null;

function startIndexer(): void {
  const connection = new Connection(CLUSTER, "confirmed");

  logger.info({ msg: "Starting event indexer", program: SSS_TOKEN_PROGRAM_ID.toBase58() });

  subscriptionId = connection.onLogs(
    SSS_TOKEN_PROGRAM_ID,
    (logInfo) => {
      const newEvents = parseEventFromLogs(
        logInfo.logs,
        0, // slot unavailable in onLogs callback
        logInfo.signature
      );

      if (newEvents.length > 0) {
        events.push(...newEvents);
        // Trim to max
        if (events.length > MAX_EVENTS) {
          events = events.slice(events.length - MAX_EVENTS);
        }
        persistEvents();
      }
    },
    "confirmed"
  );

  logger.info({ msg: "Indexer subscribed", subscriptionId });
}

// ─────────────────────────────────────────
// Express app
// ─────────────────────────────────────────

const app = express();
app.use(helmet());
app.use(express.json());

app.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    service: "indexer",
    events: events.length,
    subscriptionId,
    timestamp: new Date().toISOString(),
  });
});

/**
 * GET /events
 * Query params:
 *   - type: filter by event type (e.g. "Minted")
 *   - limit: max results (default 100)
 *   - offset: pagination offset (default 0)
 *   - since: ISO timestamp filter
 */
app.get("/events", (req: Request, res: Response) => {
  const { type, limit = "100", offset = "0", since } = req.query as Record<string, string>;

  let filtered = [...events].reverse(); // newest first

  if (type) {
    filtered = filtered.filter((e) => e.type === type);
  }
  if (since) {
    const sinceDate = new Date(since).getTime();
    filtered = filtered.filter((e) => new Date(e.timestamp).getTime() >= sinceDate);
  }

  const total = filtered.length;
  const page = filtered.slice(parseInt(offset), parseInt(offset) + parseInt(limit));

  res.json({
    total,
    offset: parseInt(offset),
    limit: parseInt(limit),
    events: page,
  });
});

// ─────────────────────────────────────────
// Start
// ─────────────────────────────────────────

loadPersistedEvents();
startIndexer();

app.listen(PORT, () => {
  logger.info({ msg: `Event indexer listening on port ${PORT}` });
});

export default app;
