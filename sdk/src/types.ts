/**
 * Core types for the Solana Stablecoin Standard SDK.
 */

import { PublicKey, Keypair, Connection } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";

// ─────────────────────────────────────────
// Presets
// ─────────────────────────────────────────

/** Available preset configurations for stablecoin initialization. */
export enum Presets {
  /** SSS-1: Minimal stablecoin — mint authority + freeze authority + metadata only. */
  SSS_1 = "sss-1",
  /** SSS-2: Compliant stablecoin — SSS-1 + permanent delegate + transfer hook + blacklist. */
  SSS_2 = "sss-2",
}

// ─────────────────────────────────────────
// Config
// ─────────────────────────────────────────

/** Extension flags for custom stablecoin configuration. */
export interface ExtensionConfig {
  /** Enable permanent delegate (required for seize). */
  permanentDelegate?: boolean;
  /** Enable transfer hook (required for blacklist enforcement). */
  transferHook?: boolean;
  /** Freeze all new token accounts by default. */
  defaultAccountFrozen?: boolean;
}

/** Parameters passed to SolanaStablecoin.create(). */
export interface CreateParams {
  /** Preset (SSS-1 or SSS-2). If provided, extension flags are set automatically. */
  preset?: Presets;
  /** Token name (max 64 chars). */
  name: string;
  /** Token symbol (max 16 chars). */
  symbol: string;
  /** Metadata URI (max 256 chars). */
  uri?: string;
  /** Decimal places (default: 6). */
  decimals?: number;
  /** Master authority keypair. */
  authority: Keypair;
  /** Optional: pre-generated mint keypair. A new one is created if omitted. */
  mint?: Keypair;
  /** Custom extension flags (ignored if preset is set). */
  extensions?: ExtensionConfig;
}

// ─────────────────────────────────────────
// On-chain state (mirrors Rust structs)
// ─────────────────────────────────────────

/** Mirrors programs/sss-token/src/lib.rs::GlobalState */
export interface GlobalState {
  masterAuthority: PublicKey;
  mint: PublicKey;
  name: string;
  symbol: string;
  uri: string;
  decimals: number;
  enablePermanentDelegate: boolean;
  enableTransferHook: boolean;
  defaultAccountFrozen: boolean;
  isPaused: boolean;
  pendingAuthority: PublicKey | null;
  bump: number;
}

/** Mirrors programs/sss-token/src/lib.rs::RoleRegistry */
export interface RoleRegistry {
  mint: PublicKey;
  pauser: PublicKey | null;
  burner: PublicKey | null;
  blacklister: PublicKey | null;
  seizer: PublicKey | null;
  bump: number;
}

/** Mirrors programs/sss-token/src/lib.rs::MinterState */
export interface MinterState {
  mint: PublicKey;
  minter: PublicKey;
  maxQuota: BN;
  mintedThisEpoch: BN;
  epochStart: BN;
  epochDuration: BN;
  bump: number;
}

/** Mirrors programs/sss-token/src/lib.rs::BlacklistEntry */
export interface BlacklistEntry {
  mint: PublicKey;
  address: PublicKey;
  reason: string;
  timestamp: BN;
  by: PublicKey;
  bump: number;
}

// ─────────────────────────────────────────
// Operation params
// ─────────────────────────────────────────

export interface MintParams {
  recipient: PublicKey;
  amount: BN | bigint | number;
  minter: Keypair;
  /** Automatically create recipient's ATA if it doesn't exist. Default: true. */
  createAta?: boolean;
}

export interface BurnParams {
  amount: BN | bigint | number;
  burner: Keypair;
  /** Token account to burn from. Defaults to burner's ATA. */
  tokenAccount?: PublicKey;
}

export interface FreezeParams {
  target: PublicKey;
  authority: Keypair;
}

export interface UpdateMinterParams {
  minter: PublicKey;
  maxQuota: BN | bigint | number;
  epochDuration?: number;
  authority: Keypair;
}

export interface UpdateRolesParams {
  roleType: "pauser" | "burner" | "blacklister" | "seizer";
  newKey: PublicKey | null;
  authority: Keypair;
}

export interface ProposeTransferParams {
  newAuthority: PublicKey;
  currentAuthority: Keypair;
}

export interface AcceptTransferParams {
  newAuthority: Keypair;
}

// ─────────────────────────────────────────
// SSS-2 compliance params
// ─────────────────────────────────────────

export interface BlacklistAddParams {
  address: PublicKey;
  reason: string;
  blacklister: Keypair;
}

export interface BlacklistRemoveParams {
  address: PublicKey;
  blacklister: Keypair;
}

export interface SeizeParams {
  source: PublicKey;
  destination: PublicKey;
  amount: BN | bigint | number;
  seizer: Keypair;
}
