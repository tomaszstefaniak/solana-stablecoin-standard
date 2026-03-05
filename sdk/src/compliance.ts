/**
 * SSS-2 Compliance Module
 *
 * Provides blacklist management and seizure capabilities via:
 *   - On-chain blacklist PDAs (["blacklist", mint, address])
 *   - Permanent delegate for seizure without owner signature
 *
 * All compliance operations are SSS-2 only. They will throw if
 * the stablecoin was initialized without transfer hook / permanent delegate.
 */

import {
  Connection,
  PublicKey,
} from "@solana/web3.js";
import { Program, BN } from "@coral-xyz/anchor";
import {
  BlacklistAddParams,
  BlacklistRemoveParams,
  BlacklistEntry,
  SeizeParams,
  GlobalState,
} from "./types";

export class ComplianceModule {
  constructor(
    private readonly program: Program,
    private readonly connection: Connection,
    private readonly mintPubkey: PublicKey,
    private readonly globalState: GlobalState
  ) {}

  // ─────────────────────────────────────────
  // PDA helpers
  // ─────────────────────────────────────────

  /** Derives the blacklist entry PDA for a given address. */
  blacklistEntryPda(address: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("blacklist"), this.mintPubkey.toBuffer(), address.toBuffer()],
      this.program.programId
    );
  }

  // ─────────────────────────────────────────
  // Blacklist operations
  // ─────────────────────────────────────────

  /**
   * Adds an address to the on-chain blacklist.
   *
   * Creates a BlacklistEntry PDA. The transfer hook program will reject any
   * transfer involving this address.
   *
   * SSS-2 only. Requires: blacklister role or master authority.
   */
  async blacklistAdd(params: BlacklistAddParams): Promise<string> {
    this.requireSss2("blacklistAdd");
    const { address, reason, blacklister } = params;
    const [blacklistEntry] = this.blacklistEntryPda(address);
    const [globalState] = this.globalStatePda();
    const [roleRegistry] = this.roleRegistryPda();

    const tx = await this.program.methods
      .addToBlacklist(address, reason)
      .accounts({
        blacklister: blacklister.publicKey,
        payer: blacklister.publicKey,
        globalState,
        roleRegistry,
        blacklistEntry,
        mint: this.mintPubkey,
        systemProgram: PublicKey.default,
      } as any)
      .signers([blacklister])
      .rpc();

    return tx;
  }

  /**
   * Removes an address from the blacklist.
   * Closes the BlacklistEntry PDA and refunds rent to the payer.
   *
   * SSS-2 only. Requires: blacklister role or master authority.
   */
  async blacklistRemove(params: BlacklistRemoveParams): Promise<string> {
    this.requireSss2("blacklistRemove");
    const { address, blacklister } = params;
    const [blacklistEntry] = this.blacklistEntryPda(address);
    const [globalState] = this.globalStatePda();
    const [roleRegistry] = this.roleRegistryPda();

    const tx = await this.program.methods
      .removeFromBlacklist(address)
      .accounts({
        blacklister: blacklister.publicKey,
        payer: blacklister.publicKey,
        globalState,
        roleRegistry,
        blacklistEntry,
        mint: this.mintPubkey,
      } as any)
      .signers([blacklister])
      .rpc();

    return tx;
  }

  /**
   * Returns true if the given address is on the blacklist.
   */
  async isBlacklisted(address: PublicKey): Promise<boolean> {
    const [blacklistEntry] = this.blacklistEntryPda(address);
    const info = await this.connection.getAccountInfo(blacklistEntry);
    return info !== null && info.data.length > 8;
  }

  /**
   * Fetches all blacklist entries for this mint.
   * Returns entries sorted by timestamp (newest first).
   */
  async getBlacklist(): Promise<BlacklistEntry[]> {
    const accounts = await (this.program.account as any)["blacklistEntry"].all([
      {
        memcmp: {
          offset: 8, // after discriminator
          bytes: this.mintPubkey.toBase58(),
        },
      },
    ]);
    return accounts
      .map((a: { account: unknown }) => a.account as unknown as BlacklistEntry)
      .sort((a: BlacklistEntry, b: BlacklistEntry) => b.timestamp.cmp(a.timestamp));
  }

  // ─────────────────────────────────────────
  // Seizure
  // ─────────────────────────────────────────

  /**
   * Seizes tokens from a source account to a destination account.
   *
   * Uses the permanent delegate extension — no signature from the source
   * account owner is required. The global_state PDA acts as the delegate.
   *
   * SSS-2 only. Requires: seizer role or master authority.
   */
  async seize(params: SeizeParams): Promise<string> {
    this.requireSss2("seize");
    const { source, destination, amount, seizer } = params;
    const [globalState] = this.globalStatePda();
    const [roleRegistry] = this.roleRegistryPda();

    const amountBn =
      typeof amount === "bigint"
        ? new BN(amount.toString())
        : new BN(amount.toString());

    const tx = await this.program.methods
      .seize(amountBn)
      .accounts({
        seizer: seizer.publicKey,
        globalState,
        roleRegistry,
        mint: this.mintPubkey,
        sourceTokenAccount: source,
        destinationTokenAccount: destination,
        tokenProgram: new PublicKey(
          "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        ),
      } as any)
      .signers([seizer])
      .rpc();

    return tx;
  }

  // ─────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────

  private globalStatePda(): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("sss"), this.mintPubkey.toBuffer()],
      this.program.programId
    );
  }

  private roleRegistryPda(): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("roles"), this.mintPubkey.toBuffer()],
      this.program.programId
    );
  }

  private requireSss2(operation: string): void {
    if (
      !this.globalState.enableTransferHook &&
      !this.globalState.enablePermanentDelegate
    ) {
      throw new Error(
        `${operation} requires SSS-2 features (transfer hook / permanent delegate). ` +
          `This stablecoin was initialized as SSS-1.`
      );
    }
  }
}
