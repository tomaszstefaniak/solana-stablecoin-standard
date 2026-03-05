/**
 * SolanaStablecoin — main SDK class.
 *
 * Wraps the sss-token Anchor program and provides a high-level API for
 * all stablecoin operations (SSS-1 and SSS-2).
 *
 * @example
 * ```typescript
 * const stable = await SolanaStablecoin.create(connection, {
 *   preset: Presets.SSS_2,
 *   name: "MyUSD",
 *   symbol: "MUSD",
 *   decimals: 6,
 *   authority: adminKeypair,
 * });
 * await stable.mint({ recipient, amount: 1_000_000, minter: minterKp });
 * await stable.compliance.blacklistAdd({ address, reason: "OFAC match", blacklister });
 * ```
 */

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  AnchorProvider,
  Program,
  BN,
  Wallet,
  type Idl,
} from "@coral-xyz/anchor";
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  TOKEN_2022_PROGRAM_ID,
  getMint,
  getAccount,
} from "@solana/spl-token";
import {
  CreateParams,
  GlobalState,
  RoleRegistry,
  MinterState,
  MintParams,
  BurnParams,
  FreezeParams,
  UpdateMinterParams,
  UpdateRolesParams,
  ProposeTransferParams,
  AcceptTransferParams,
} from "./types";
import { resolveExtensions } from "./presets";
import { ComplianceModule } from "./compliance";
import { TRANSFER_HOOK_PROGRAM_ID, SSS_TOKEN_IDL } from "./idl";

export class SolanaStablecoin {
  /** The Token-2022 mint public key. */
  public readonly mintPubkey: PublicKey;
  /** SSS-2 compliance module (only valid when SSS-2 features are enabled). */
  public readonly compliance: ComplianceModule;

  private constructor(
    private readonly program: Program,
    private readonly connection: Connection,
    mintPubkey: PublicKey,
    private _globalState: GlobalState
  ) {
    this.mintPubkey = mintPubkey;
    this.compliance = new ComplianceModule(
      program,
      connection,
      mintPubkey,
      _globalState
    );
  }

  // ─────────────────────────────────────────
  // Factory
  // ─────────────────────────────────────────

  /**
   * Creates a new stablecoin mint and initializes the SSS program accounts.
   *
   * @param connection - Solana RPC connection
   * @param params - Configuration (preset or custom, name, symbol, authority, etc.)
   * @returns Configured SolanaStablecoin instance
   */
  static async create(
    connection: Connection,
    params: CreateParams
  ): Promise<SolanaStablecoin> {
    const {
      preset,
      name,
      symbol,
      uri = "",
      decimals = 6,
      authority,
      mint: mintKp = Keypair.generate(),
      extensions: customExtensions,
    } = params;

    const extensions = resolveExtensions(preset, customExtensions);
    const provider = new AnchorProvider(
      connection,
      new Wallet(authority),
      { commitment: "confirmed" }
    );
    const program = new Program(SSS_TOKEN_IDL as unknown as Idl, provider);

    const mintPubkey = mintKp.publicKey;
    const [globalState] = PublicKey.findProgramAddressSync(
      [Buffer.from("sss"), mintPubkey.toBuffer()],
      program.programId
    );
    const [roleRegistry] = PublicKey.findProgramAddressSync(
      [Buffer.from("roles"), mintPubkey.toBuffer()],
      program.programId
    );

    const initParams = {
      name,
      symbol,
      uri,
      decimals,
      enablePermanentDelegate: extensions.permanentDelegate ?? false,
      enableTransferHook: extensions.transferHook ?? false,
      defaultAccountFrozen: extensions.defaultAccountFrozen ?? false,
      transferHookProgramId: extensions.transferHook
        ? TRANSFER_HOOK_PROGRAM_ID
        : null,
    };

    await program.methods
      .initialize(initParams)
      .accounts({
        payer: authority.publicKey,
        masterAuthority: authority.publicKey,
        mint: mintPubkey,
        globalState,
        roleRegistry,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: new PublicKey("SysvarRent111111111111111111111111111111111"),
      } as any)
      .signers([authority, mintKp])
      .rpc();

    const gs = await fetchGlobalState(program, mintPubkey);

    return new SolanaStablecoin(program, connection, mintPubkey, gs);
  }

  /**
   * Loads an existing stablecoin by mint address.
   */
  static async load(
    connection: Connection,
    mintPubkey: PublicKey,
    signer: Keypair
  ): Promise<SolanaStablecoin> {
    const provider = new AnchorProvider(
      connection,
      new Wallet(signer),
      { commitment: "confirmed" }
    );
    const program = new Program(SSS_TOKEN_IDL as unknown as Idl, provider);
    const gs = await fetchGlobalState(program, mintPubkey);
    return new SolanaStablecoin(program, connection, mintPubkey, gs);
  }

  // ─────────────────────────────────────────
  // PDA helpers
  // ─────────────────────────────────────────

  globalStatePda(): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("sss"), this.mintPubkey.toBuffer()],
      this.program.programId
    );
    return pda;
  }

  roleRegistryPda(): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("roles"), this.mintPubkey.toBuffer()],
      this.program.programId
    );
    return pda;
  }

  minterStatePda(minter: PublicKey): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("minter"), this.mintPubkey.toBuffer(), minter.toBuffer()],
      this.program.programId
    );
    return pda;
  }

  // ─────────────────────────────────────────
  // Core operations
  // ─────────────────────────────────────────

  /**
   * Mints tokens to a recipient.
   *
   * Requires: minter role with sufficient quota + not paused.
   * Creates recipient ATA if createAta is true (default).
   */
  async mint(params: MintParams): Promise<string> {
    const { recipient, amount, minter, createAta = true } = params;

    const recipientAta = getAssociatedTokenAddressSync(
      this.mintPubkey,
      recipient,
      false,
      TOKEN_2022_PROGRAM_ID
    );

    // Create ATA if needed
    if (createAta) {
      const ataInfo = await this.connection.getAccountInfo(recipientAta);
      if (!ataInfo) {
        const createAtaIx = createAssociatedTokenAccountInstruction(
          minter.publicKey,
          recipientAta,
          recipient,
          this.mintPubkey,
          TOKEN_2022_PROGRAM_ID
        );
        const tx = new Transaction().add(createAtaIx);
        await sendAndConfirmTransaction(this.connection, tx, [minter]);
      }
    }

    const amountBn = new BN(amount.toString());
    const minterState = this.minterStatePda(minter.publicKey);

    return this.program.methods
      .mint(amountBn)
      .accounts({
        minter: minter.publicKey,
        globalState: this.globalStatePda(),
        minterState,
        mint: this.mintPubkey,
        recipientTokenAccount: recipientAta,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      } as any)
      .signers([minter])
      .rpc();
  }

  /**
   * Burns tokens from the burner's token account.
   *
   * Requires: burner role (or master authority) + not paused.
   */
  async burn(params: BurnParams): Promise<string> {
    const { amount, burner, tokenAccount } = params;

    const burnAccount =
      tokenAccount ??
      getAssociatedTokenAddressSync(
        this.mintPubkey,
        burner.publicKey,
        false,
        TOKEN_2022_PROGRAM_ID
      );

    const amountBn = new BN(amount.toString());

    return this.program.methods
      .burn(amountBn)
      .accounts({
        burner: burner.publicKey,
        globalState: this.globalStatePda(),
        roleRegistry: this.roleRegistryPda(),
        mint: this.mintPubkey,
        burnerTokenAccount: burnAccount,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      } as any)
      .signers([burner])
      .rpc();
  }

  /**
   * Freezes a token account.
   * Requires: master authority or pauser role.
   */
  async freeze(targetTokenAccount: PublicKey, authority: Keypair): Promise<string> {
    return this.program.methods
      .freezeAccount()
      .accounts({
        authority: authority.publicKey,
        globalState: this.globalStatePda(),
        roleRegistry: this.roleRegistryPda(),
        mint: this.mintPubkey,
        targetTokenAccount,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      } as any)
      .signers([authority])
      .rpc();
  }

  /**
   * Thaws a frozen token account.
   * Requires: master authority or pauser role.
   */
  async thaw(targetTokenAccount: PublicKey, authority: Keypair): Promise<string> {
    return this.program.methods
      .thawAccount()
      .accounts({
        authority: authority.publicKey,
        globalState: this.globalStatePda(),
        roleRegistry: this.roleRegistryPda(),
        mint: this.mintPubkey,
        targetTokenAccount,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      } as any)
      .signers([authority])
      .rpc();
  }

  /**
   * Pauses all minting and burning.
   * Requires: pauser role or master authority.
   */
  async pause(authority: Keypair): Promise<string> {
    return this.program.methods
      .pause()
      .accounts({
        authority: authority.publicKey,
        globalState: this.globalStatePda(),
        roleRegistry: this.roleRegistryPda(),
        mint: this.mintPubkey,
      } as any)
      .signers([authority])
      .rpc();
  }

  /**
   * Unpauses minting and burning.
   * Requires: pauser role or master authority.
   */
  async unpause(authority: Keypair): Promise<string> {
    return this.program.methods
      .unpause()
      .accounts({
        authority: authority.publicKey,
        globalState: this.globalStatePda(),
        roleRegistry: this.roleRegistryPda(),
        mint: this.mintPubkey,
      } as any)
      .signers([authority])
      .rpc();
  }

  // ─────────────────────────────────────────
  // Role management
  // ─────────────────────────────────────────

  /**
   * Creates or updates a minter's quota.
   * Requires: master authority.
   */
  async updateMinter(params: UpdateMinterParams): Promise<string> {
    const { minter, maxQuota, epochDuration, authority } = params;
    const quotaBn = new BN(maxQuota.toString());
    const epochDurationBn = epochDuration ? new BN(epochDuration) : null;

    return this.program.methods
      .updateMinter(quotaBn, epochDurationBn)
      .accounts({
        masterAuthority: authority.publicKey,
        globalState: this.globalStatePda(),
        minter,
        minterState: this.minterStatePda(minter),
        payer: authority.publicKey,
        mint: this.mintPubkey,
        systemProgram: SystemProgram.programId,
      } as any)
      .signers([authority])
      .rpc();
  }

  /**
   * Updates a role (pauser, burner, blacklister, seizer).
   * Requires: master authority.
   */
  async updateRoles(params: UpdateRolesParams): Promise<string> {
    const { roleType, newKey, authority } = params;

    return this.program.methods
      .updateRoles(roleType, newKey)
      .accounts({
        masterAuthority: authority.publicKey,
        globalState: this.globalStatePda(),
        roleRegistry: this.roleRegistryPda(),
        mint: this.mintPubkey,
      } as any)
      .signers([authority])
      .rpc();
  }

  /**
   * Step 1 of authority transfer: propose a new master authority.
   * Requires: current master authority.
   */
  async proposeAuthorityTransfer(params: ProposeTransferParams): Promise<string> {
    const { newAuthority, currentAuthority } = params;

    return this.program.methods
      .proposeAuthorityTransfer(newAuthority)
      .accounts({
        masterAuthority: currentAuthority.publicKey,
        globalState: this.globalStatePda(),
        mint: this.mintPubkey,
      } as any)
      .signers([currentAuthority])
      .rpc();
  }

  /**
   * Step 2 of authority transfer: new authority accepts.
   * Must be signed by the proposed new authority.
   */
  async acceptAuthorityTransfer(params: AcceptTransferParams): Promise<string> {
    const { newAuthority } = params;

    return this.program.methods
      .acceptAuthorityTransfer()
      .accounts({
        newAuthority: newAuthority.publicKey,
        globalState: this.globalStatePda(),
        mint: this.mintPubkey,
      } as any)
      .signers([newAuthority])
      .rpc();
  }

  // ─────────────────────────────────────────
  // Queries
  // ─────────────────────────────────────────

  /** Returns the current global state. */
  async getGlobalState(): Promise<GlobalState> {
    this._globalState = await fetchGlobalState(this.program, this.mintPubkey);
    return this._globalState;
  }

  /** Returns the role registry. */
  async getRoles(): Promise<RoleRegistry> {
    const pda = this.roleRegistryPda();
    return (this.program.account as any)["roleRegistry"].fetch(pda) as unknown as RoleRegistry;
  }

  /** Returns minter state for a given minter pubkey. */
  async getMinterState(minter: PublicKey): Promise<MinterState | null> {
    try {
      return (this.program.account as any)["minterState"].fetch(
        this.minterStatePda(minter)
      ) as unknown as MinterState;
    } catch {
      return null;
    }
  }

  /** Returns the total token supply. */
  async getTotalSupply(): Promise<BN> {
    const mint = await getMint(
      this.connection,
      this.mintPubkey,
      "confirmed",
      TOKEN_2022_PROGRAM_ID
    );
    return new BN(mint.supply.toString());
  }

  /** Returns the token balance of a given token account. */
  async getBalance(tokenAccount: PublicKey): Promise<BN> {
    const account = await getAccount(
      this.connection,
      tokenAccount,
      "confirmed",
      TOKEN_2022_PROGRAM_ID
    );
    return new BN(account.amount.toString());
  }

  /** Returns the ATA address for a given owner. */
  ata(owner: PublicKey): PublicKey {
    return getAssociatedTokenAddressSync(
      this.mintPubkey,
      owner,
      false,
      TOKEN_2022_PROGRAM_ID
    );
  }
}

// ─────────────────────────────────────────
// Helper
// ─────────────────────────────────────────

async function fetchGlobalState(
  program: Program,
  mintPubkey: PublicKey
): Promise<GlobalState> {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("sss"), mintPubkey.toBuffer()],
    program.programId
  );
  return (program.account as any)["globalState"].fetch(pda) as unknown as GlobalState;
}
