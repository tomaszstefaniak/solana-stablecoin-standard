//! SSS-Token Program — Solana Stablecoin Standard
//!
//! Implements two preset stablecoin configurations:
//!
//!   SSS-1 (Minimal):   Token-2022 mint + metadata + freeze authority + roles
//!   SSS-2 (Compliant): SSS-1 + permanent delegate + transfer hook + blacklist
//!
//! ## Account Seeds
//! - Global state: `["sss", mint]`
//! - Role registry: `["roles", mint]`
//! - Blacklist entry: `["blacklist", mint, address]`
//! - Minter state: `["minter", mint, minter_pubkey]`
//!
//! ## Security
//! - All instructions verify the caller holds the required role.
//! - SSS-2-only instructions fail with `FeatureNotEnabled` if the feature
//!   was not activated at mint creation time.
//! - Checked arithmetic throughout (overflow-checks = true in Cargo.toml).
//! - Events are emitted for every state-changing instruction.

use anchor_lang::prelude::*;
use anchor_spl::{
    token_2022::{
        self as token_2022_crate, Token2022,
        freeze_account, mint_to, thaw_account,
        burn as token_burn, transfer_checked,
        FreezeAccount, MintTo, ThawAccount,
        Burn as TokenBurn, TransferChecked,
    },
    token_interface::{Mint, TokenAccount},
};
use spl_token_2022::{
    extension::{
        ExtensionType,
        metadata_pointer::instruction as metadata_pointer_ix,
        transfer_hook::instruction as transfer_hook_ix,
        default_account_state::instruction as default_account_state_ix,
    },
    instruction as token_ix,
    state::AccountState,
};
use spl_token_metadata_interface::state::TokenMetadata;

declare_id!("Gx4YCpm4DhBwDaqZya9QY2ydTP6hVa3ffPSdViPJ45x8");

// ─────────────────────────────────────────
// Constants
// ─────────────────────────────────────────

/// Maximum length for name/symbol/uri strings.
pub const MAX_NAME_LEN: usize = 64;
pub const MAX_SYMBOL_LEN: usize = 16;
pub const MAX_URI_LEN: usize = 256;
pub const MAX_REASON_LEN: usize = 200;

/// Default epoch duration for minter quota resets: 24 hours in seconds.
pub const DEFAULT_EPOCH_DURATION: i64 = 86_400;

// ─────────────────────────────────────────
// Errors
// ─────────────────────────────────────────

#[error_code]
pub enum SssError {
    #[msg("Caller does not hold the required role")]
    Unauthorized,
    #[msg("Token is currently paused")]
    Paused,
    #[msg("Minter quota exceeded for this epoch")]
    QuotaExceeded,
    #[msg("This feature was not enabled at mint creation")]
    FeatureNotEnabled,
    #[msg("String exceeds maximum allowed length")]
    StringTooLong,
    #[msg("Address is already blacklisted")]
    AlreadyBlacklisted,
    #[msg("Address is not on the blacklist")]
    NotBlacklisted,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Pending authority transfer already in progress")]
    PendingTransfer,
    #[msg("No pending authority transfer")]
    NoPendingTransfer,
    #[msg("Caller is not the pending new authority")]
    WrongPendingAuthority,
}

// ─────────────────────────────────────────
// Events
// ─────────────────────────────────────────

#[event]
pub struct StablecoinInitialized {
    pub mint: Pubkey,
    pub master_authority: Pubkey,
    pub preset: u8, // 1 = SSS-1, 2 = SSS-2
    pub name: String,
    pub symbol: String,
    pub decimals: u8,
}

#[event]
pub struct Minted {
    pub mint: Pubkey,
    pub minter: Pubkey,
    pub recipient: Pubkey,
    pub amount: u64,
}

#[event]
pub struct Burned {
    pub mint: Pubkey,
    pub burner: Pubkey,
    pub amount: u64,
}

#[event]
pub struct AccountFrozen {
    pub mint: Pubkey,
    pub target: Pubkey,
}

#[event]
pub struct AccountThawed {
    pub mint: Pubkey,
    pub target: Pubkey,
}

#[event]
pub struct Paused {
    pub mint: Pubkey,
    pub by: Pubkey,
}

#[event]
pub struct Unpaused {
    pub mint: Pubkey,
    pub by: Pubkey,
}

#[event]
pub struct MinterUpdated {
    pub mint: Pubkey,
    pub minter: Pubkey,
    pub new_quota: u64,
    pub epoch_duration: i64,
}

#[event]
pub struct RolesUpdated {
    pub mint: Pubkey,
    pub role_type: String,
    pub new_key: Pubkey,
}

#[event]
pub struct AuthorityTransferProposed {
    pub mint: Pubkey,
    pub proposed_by: Pubkey,
    pub new_authority: Pubkey,
}

#[event]
pub struct AuthorityTransferCompleted {
    pub mint: Pubkey,
    pub old_authority: Pubkey,
    pub new_authority: Pubkey,
}

#[event]
pub struct Blacklisted {
    pub mint: Pubkey,
    pub address: Pubkey,
    pub reason: String,
    pub by: Pubkey,
}

#[event]
pub struct RemovedFromBlacklist {
    pub mint: Pubkey,
    pub address: Pubkey,
    pub by: Pubkey,
}

#[event]
pub struct Seized {
    pub mint: Pubkey,
    pub source: Pubkey,
    pub destination: Pubkey,
    pub amount: u64,
    pub by: Pubkey,
}

// ─────────────────────────────────────────
// State Accounts
// ─────────────────────────────────────────

/// Global stablecoin state — PDA seeds: ["sss", mint].
#[account]
#[derive(Default)]
pub struct GlobalState {
    /// The controlling authority (can do everything).
    pub master_authority: Pubkey,        // 32
    /// The mint address.
    pub mint: Pubkey,                    // 32
    /// Token name.
    pub name: String,                    // 4 + MAX_NAME_LEN
    /// Token symbol.
    pub symbol: String,                  // 4 + MAX_SYMBOL_LEN
    /// Metadata URI.
    pub uri: String,                     // 4 + MAX_URI_LEN
    /// Decimal places.
    pub decimals: u8,                    // 1
    /// SSS-2: permanent delegate extension was enabled at init.
    pub enable_permanent_delegate: bool, // 1
    /// SSS-2: transfer hook extension was enabled at init.
    pub enable_transfer_hook: bool,      // 1
    /// SSS-2: default account state is frozen.
    pub default_account_frozen: bool,    // 1
    /// Whether minting/burning is paused.
    pub is_paused: bool,                 // 1
    /// Pending new master authority (two-step transfer).
    pub pending_authority: Option<Pubkey>, // 1 + 32
    /// PDA bump.
    pub bump: u8,                        // 1
}

impl GlobalState {
    pub const LEN: usize = 8   // discriminator
        + 32                   // master_authority
        + 32                   // mint
        + 4 + MAX_NAME_LEN     // name
        + 4 + MAX_SYMBOL_LEN   // symbol
        + 4 + MAX_URI_LEN      // uri
        + 1                    // decimals
        + 1                    // enable_permanent_delegate
        + 1                    // enable_transfer_hook
        + 1                    // default_account_frozen
        + 1                    // is_paused
        + 1 + 32               // pending_authority (Option<Pubkey>)
        + 1;                   // bump
}

/// Role registry — PDA seeds: ["roles", mint].
#[account]
#[derive(Default)]
pub struct RoleRegistry {
    pub mint: Pubkey,
    /// Can freeze/thaw accounts, pause/unpause.
    pub pauser: Option<Pubkey>,
    /// Can burn tokens.
    pub burner: Option<Pubkey>,
    /// SSS-2: can add/remove blacklist entries.
    pub blacklister: Option<Pubkey>,
    /// SSS-2: can seize tokens via permanent delegate.
    pub seizer: Option<Pubkey>,
    pub bump: u8,
}

impl RoleRegistry {
    pub const LEN: usize = 8
        + 32       // mint
        + 1 + 32   // pauser
        + 1 + 32   // burner
        + 1 + 32   // blacklister
        + 1 + 32   // seizer
        + 1;       // bump
}

/// Per-minter state — PDA seeds: ["minter", mint, minter_pubkey].
#[account]
pub struct MinterState {
    pub mint: Pubkey,
    pub minter: Pubkey,
    /// Maximum amount this minter can mint per epoch.
    pub max_quota: u64,
    /// Amount minted in the current epoch.
    pub minted_this_epoch: u64,
    /// Epoch start timestamp (Unix seconds).
    pub epoch_start: i64,
    /// Epoch duration in seconds.
    pub epoch_duration: i64,
    pub bump: u8,
}

impl MinterState {
    pub const LEN: usize = 8
        + 32  // mint
        + 32  // minter
        + 8   // max_quota
        + 8   // minted_this_epoch
        + 8   // epoch_start
        + 8   // epoch_duration
        + 1;  // bump

    /// Returns remaining quota for this epoch, resetting if a new epoch has started.
    pub fn check_and_update_quota(&mut self, amount: u64, now: i64) -> Result<()> {
        // Reset epoch if expired
        if now >= self.epoch_start.checked_add(self.epoch_duration).ok_or(SssError::Overflow)? {
            self.minted_this_epoch = 0;
            self.epoch_start = now;
        }
        let new_total = self
            .minted_this_epoch
            .checked_add(amount)
            .ok_or(SssError::Overflow)?;
        require!(new_total <= self.max_quota, SssError::QuotaExceeded);
        self.minted_this_epoch = new_total;
        Ok(())
    }
}

/// Blacklist entry — PDA seeds: ["blacklist", mint, address].
/// Its mere existence means the address is blacklisted.
#[account]
pub struct BlacklistEntry {
    pub mint: Pubkey,
    pub address: Pubkey,
    pub reason: String, // up to MAX_REASON_LEN
    pub timestamp: i64,
    pub by: Pubkey,
    pub bump: u8,
}

impl BlacklistEntry {
    pub const LEN: usize = 8
        + 32              // mint
        + 32              // address
        + 4 + MAX_REASON_LEN // reason
        + 8               // timestamp
        + 32              // by
        + 1;              // bump
}

// ─────────────────────────────────────────
// Instruction Contexts
// ─────────────────────────────────────────

/// Parameters for the `initialize` instruction.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InitializeParams {
    pub name: String,
    pub symbol: String,
    pub uri: String,
    pub decimals: u8,
    pub enable_permanent_delegate: bool,
    pub enable_transfer_hook: bool,
    pub default_account_frozen: bool,
    /// Address of the transfer-hook program (required when enable_transfer_hook = true).
    pub transfer_hook_program_id: Option<Pubkey>,
}

#[derive(Accounts)]
#[instruction(params: InitializeParams)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// The master authority — controls all admin operations.
    pub master_authority: Signer<'info>,

    /// The Token-2022 mint (must be a fresh keypair supplied by the caller).
    /// We create it via raw CPI so we can set Token-2022 extensions before init.
    /// CHECK: Created by this instruction.
    #[account(mut)]
    pub mint: Signer<'info>,

    /// Global state PDA.
    #[account(
        init,
        payer = payer,
        space = GlobalState::LEN,
        seeds = [b"sss", mint.key().as_ref()],
        bump,
    )]
    pub global_state: Account<'info, GlobalState>,

    /// Role registry PDA.
    #[account(
        init,
        payer = payer,
        space = RoleRegistry::LEN,
        seeds = [b"roles", mint.key().as_ref()],
        bump,
    )]
    pub role_registry: Account<'info, RoleRegistry>,

    pub token_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct MintTokens<'info> {
    pub minter: Signer<'info>,

    #[account(
        mut,
        seeds = [b"sss", mint.key().as_ref()],
        bump = global_state.bump,
    )]
    pub global_state: Account<'info, GlobalState>,

    #[account(
        mut,
        seeds = [b"minter", mint.key().as_ref(), minter.key().as_ref()],
        bump = minter_state.bump,
    )]
    pub minter_state: Account<'info, MinterState>,

    #[account(mut)]
    pub mint: InterfaceAccount<'info, Mint>,

    /// Recipient's token account (must already exist).
    #[account(mut)]
    pub recipient_token_account: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Program<'info, Token2022>,
}

#[derive(Accounts)]
pub struct BurnTokens<'info> {
    pub burner: Signer<'info>,

    #[account(
        seeds = [b"sss", mint.key().as_ref()],
        bump = global_state.bump,
    )]
    pub global_state: Account<'info, GlobalState>,

    #[account(
        seeds = [b"roles", mint.key().as_ref()],
        bump = role_registry.bump,
    )]
    pub role_registry: Account<'info, RoleRegistry>,

    #[account(mut)]
    pub mint: InterfaceAccount<'info, Mint>,

    /// Burner's token account.
    #[account(mut)]
    pub burner_token_account: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Program<'info, Token2022>,
}

#[derive(Accounts)]
pub struct FreezeThaw<'info> {
    pub authority: Signer<'info>,

    #[account(
        seeds = [b"sss", mint.key().as_ref()],
        bump = global_state.bump,
    )]
    pub global_state: Account<'info, GlobalState>,

    #[account(
        seeds = [b"roles", mint.key().as_ref()],
        bump = role_registry.bump,
    )]
    pub role_registry: Account<'info, RoleRegistry>,

    pub mint: InterfaceAccount<'info, Mint>,

    #[account(mut)]
    pub target_token_account: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Program<'info, Token2022>,
}

#[derive(Accounts)]
pub struct PauseUnpause<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [b"sss", mint.key().as_ref()],
        bump = global_state.bump,
    )]
    pub global_state: Account<'info, GlobalState>,

    #[account(
        seeds = [b"roles", mint.key().as_ref()],
        bump = role_registry.bump,
    )]
    pub role_registry: Account<'info, RoleRegistry>,

    pub mint: InterfaceAccount<'info, Mint>,
}

#[derive(Accounts)]
pub struct UpdateMinter<'info> {
    pub master_authority: Signer<'info>,

    #[account(
        seeds = [b"sss", mint.key().as_ref()],
        bump = global_state.bump,
    )]
    pub global_state: Account<'info, GlobalState>,

    /// The minter's address.
    /// CHECK: Only used as a seed / stored in MinterState.
    pub minter: UncheckedAccount<'info>,

    #[account(
        init_if_needed,
        payer = payer,
        space = MinterState::LEN,
        seeds = [b"minter", mint.key().as_ref(), minter.key().as_ref()],
        bump,
    )]
    pub minter_state: Account<'info, MinterState>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub mint: InterfaceAccount<'info, Mint>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateRoles<'info> {
    pub master_authority: Signer<'info>,

    #[account(
        seeds = [b"sss", mint.key().as_ref()],
        bump = global_state.bump,
    )]
    pub global_state: Account<'info, GlobalState>,

    #[account(
        mut,
        seeds = [b"roles", mint.key().as_ref()],
        bump = role_registry.bump,
    )]
    pub role_registry: Account<'info, RoleRegistry>,

    pub mint: InterfaceAccount<'info, Mint>,
}

#[derive(Accounts)]
pub struct ProposeAuthorityTransfer<'info> {
    pub master_authority: Signer<'info>,

    #[account(
        mut,
        seeds = [b"sss", mint.key().as_ref()],
        bump = global_state.bump,
    )]
    pub global_state: Account<'info, GlobalState>,

    pub mint: InterfaceAccount<'info, Mint>,
}

#[derive(Accounts)]
pub struct AcceptAuthorityTransfer<'info> {
    /// Must match global_state.pending_authority.
    pub new_authority: Signer<'info>,

    #[account(
        mut,
        seeds = [b"sss", mint.key().as_ref()],
        bump = global_state.bump,
    )]
    pub global_state: Account<'info, GlobalState>,

    pub mint: InterfaceAccount<'info, Mint>,
}

// SSS-2 contexts ──────────────────────────

#[derive(Accounts)]
#[instruction(address: Pubkey, reason: String)]
pub struct AddToBlacklist<'info> {
    pub blacklister: Signer<'info>,

    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        seeds = [b"sss", mint.key().as_ref()],
        bump = global_state.bump,
    )]
    pub global_state: Account<'info, GlobalState>,

    #[account(
        seeds = [b"roles", mint.key().as_ref()],
        bump = role_registry.bump,
    )]
    pub role_registry: Account<'info, RoleRegistry>,

    #[account(
        init,
        payer = payer,
        space = BlacklistEntry::LEN,
        seeds = [b"blacklist", mint.key().as_ref(), address.as_ref()],
        bump,
    )]
    pub blacklist_entry: Account<'info, BlacklistEntry>,

    pub mint: InterfaceAccount<'info, Mint>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(address: Pubkey)]
pub struct RemoveFromBlacklist<'info> {
    pub blacklister: Signer<'info>,

    /// Rent refund destination.
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        seeds = [b"sss", mint.key().as_ref()],
        bump = global_state.bump,
    )]
    pub global_state: Account<'info, GlobalState>,

    #[account(
        seeds = [b"roles", mint.key().as_ref()],
        bump = role_registry.bump,
    )]
    pub role_registry: Account<'info, RoleRegistry>,

    #[account(
        mut,
        close = payer,
        seeds = [b"blacklist", mint.key().as_ref(), address.as_ref()],
        bump = blacklist_entry.bump,
    )]
    pub blacklist_entry: Account<'info, BlacklistEntry>,

    pub mint: InterfaceAccount<'info, Mint>,
}

#[derive(Accounts)]
pub struct Seize<'info> {
    pub seizer: Signer<'info>,

    #[account(
        seeds = [b"sss", mint.key().as_ref()],
        bump = global_state.bump,
    )]
    pub global_state: Account<'info, GlobalState>,

    #[account(
        seeds = [b"roles", mint.key().as_ref()],
        bump = role_registry.bump,
    )]
    pub role_registry: Account<'info, RoleRegistry>,

    #[account(mut)]
    pub mint: InterfaceAccount<'info, Mint>,

    /// The token account to seize from.
    #[account(mut)]
    pub source_token_account: InterfaceAccount<'info, TokenAccount>,

    /// Destination for the seized tokens.
    #[account(mut)]
    pub destination_token_account: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Program<'info, Token2022>,
}

// ─────────────────────────────────────────
// Helper: role checks
// ─────────────────────────────────────────

fn is_master(global_state: &GlobalState, key: &Pubkey) -> bool {
    global_state.master_authority == *key
}

fn can_pause(global_state: &GlobalState, roles: &RoleRegistry, key: &Pubkey) -> bool {
    is_master(global_state, key) || roles.pauser.map_or(false, |p| p == *key)
}

fn can_burn(global_state: &GlobalState, roles: &RoleRegistry, key: &Pubkey) -> bool {
    is_master(global_state, key) || roles.burner.map_or(false, |b| b == *key)
}

fn can_blacklist(global_state: &GlobalState, roles: &RoleRegistry, key: &Pubkey) -> bool {
    is_master(global_state, key) || roles.blacklister.map_or(false, |b| b == *key)
}

fn can_seize(global_state: &GlobalState, roles: &RoleRegistry, key: &Pubkey) -> bool {
    is_master(global_state, key) || roles.seizer.map_or(false, |s| s == *key)
}

// ─────────────────────────────────────────
// Program
// ─────────────────────────────────────────

#[program]
pub mod sss_token {
    use super::*;

    /// Creates a new stablecoin mint with the requested Token-2022 extensions.
    ///
    /// Extension selection:
    ///   - Always: MetadataPointer, TokenMetadata
    ///   - SSS-2: PermanentDelegate, TransferHook, DefaultAccountState (frozen)
    pub fn initialize(ctx: Context<Initialize>, params: InitializeParams) -> Result<()> {
        // Validate string lengths
        require!(params.name.len() <= MAX_NAME_LEN, SssError::StringTooLong);
        require!(params.symbol.len() <= MAX_SYMBOL_LEN, SssError::StringTooLong);
        require!(params.uri.len() <= MAX_URI_LEN, SssError::StringTooLong);

        if params.enable_transfer_hook {
            require!(params.transfer_hook_program_id.is_some(), SssError::FeatureNotEnabled);
        }

        let mint_key = ctx.accounts.mint.key();
        let master_key = ctx.accounts.master_authority.key();

        // ── Determine required extensions ─────────────────────────────────────
        let mut extensions = vec![
            ExtensionType::MetadataPointer,
        ];
        if params.enable_permanent_delegate {
            extensions.push(ExtensionType::PermanentDelegate);
        }
        if params.enable_transfer_hook {
            extensions.push(ExtensionType::TransferHook);
        }
        if params.default_account_frozen {
            extensions.push(ExtensionType::DefaultAccountState);
        }
        // MetadataPointer + inline metadata
        extensions.push(ExtensionType::MintCloseAuthority);

        // ── Allocate mint account ──────────────────────────────────────────────
        let mint_size = ExtensionType::try_calculate_account_len::<spl_token_2022::state::Mint>(
            &extensions,
        )
        .map_err(|_| error!(SssError::Overflow))?;

        let name = params.name.clone();
        let symbol = params.symbol.clone();
        let uri = params.uri.clone();

        // Extra space for inline token metadata
        let metadata_size = TokenMetadata {
            name: name.clone(),
            symbol: symbol.clone(),
            uri: uri.clone(),
            ..Default::default()
        }
        .tlv_size_of()
        .map_err(|_| error!(SssError::Overflow))? as usize;

        let total_size = mint_size + metadata_size;
        let lamports = ctx.accounts.rent.minimum_balance(total_size);

        anchor_lang::system_program::create_account(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::CreateAccount {
                    from: ctx.accounts.payer.to_account_info(),
                    to: ctx.accounts.mint.to_account_info(),
                },
            ),
            lamports,
            total_size as u64,
            &spl_token_2022::ID,
        )?;

        // ── Initialize extensions via CPI ─────────────────────────────────────

        // MetadataPointer — point to the mint itself (inline metadata)
        let mp_ix = metadata_pointer_ix::initialize(
            &spl_token_2022::ID,
            &mint_key,
            Some(master_key),
            Some(mint_key),
        )
        .map_err(|_| error!(SssError::Overflow))?;
        anchor_lang::solana_program::program::invoke(
            &mp_ix,
            &[ctx.accounts.mint.to_account_info()],
        )?;

        // PermanentDelegate
        if params.enable_permanent_delegate {
            let global_state_key = ctx.accounts.global_state.key();
            let pd_ix = token_ix::initialize_permanent_delegate(
                &spl_token_2022::ID,
                &mint_key,
                &global_state_key,
            )
            .map_err(|_| error!(SssError::Overflow))?;
            anchor_lang::solana_program::program::invoke(
                &pd_ix,
                &[ctx.accounts.mint.to_account_info()],
            )?;
        }

        // TransferHook
        if params.enable_transfer_hook {
            let hook_program_id = params.transfer_hook_program_id.unwrap();
            let th_ix = transfer_hook_ix::initialize(
                &spl_token_2022::ID,
                &mint_key,
                Some(master_key),
                Some(hook_program_id),
            )
            .map_err(|_| error!(SssError::Overflow))?;
            anchor_lang::solana_program::program::invoke(
                &th_ix,
                &[ctx.accounts.mint.to_account_info()],
            )?;
        }

        // DefaultAccountState (frozen)
        if params.default_account_frozen {
            let das_ix = default_account_state_ix::initialize_default_account_state(
                &spl_token_2022::ID,
                &mint_key,
                &AccountState::Frozen,
            )
            .map_err(|_| error!(SssError::Overflow))?;
            anchor_lang::solana_program::program::invoke(
                &das_ix,
                &[ctx.accounts.mint.to_account_info()],
            )?;
        }

        // ── Initialize mint ───────────────────────────────────────────────────
        // freeze_authority = global_state PDA (so freeze/thaw can be done via CPI)
        let global_state_key = ctx.accounts.global_state.key();
        let init_mint_ix = token_ix::initialize_mint2(
            &spl_token_2022::ID,
            &mint_key,
            &global_state_key, // mint authority = global_state PDA
            Some(&global_state_key), // freeze authority = global_state PDA
            params.decimals,
        )
        .map_err(|_| error!(SssError::Overflow))?;
        anchor_lang::solana_program::program::invoke(
            &init_mint_ix,
            &[ctx.accounts.mint.to_account_info()],
        )?;

        // ── Initialize inline token metadata ──────────────────────────────────
        let init_meta_ix = spl_token_metadata_interface::instruction::initialize(
            &spl_token_2022::ID,
            &mint_key,
            &global_state_key, // update authority
            &mint_key,
            &global_state_key, // mint authority
            name.clone(),
            symbol.clone(),
            uri.clone(),
        );
        // Sign as global_state PDA
        let sss_seeds: &[&[u8]] = &[b"sss", mint_key.as_ref(), &[ctx.bumps.global_state]];
        anchor_lang::solana_program::program::invoke_signed(
            &init_meta_ix,
            &[
                ctx.accounts.mint.to_account_info(),
                ctx.accounts.global_state.to_account_info(),
                ctx.accounts.mint.to_account_info(), // metadata account = mint
                ctx.accounts.global_state.to_account_info(), // mint auth signer
            ],
            &[sss_seeds],
        )?;

        // ── Persist global state ──────────────────────────────────────────────
        let gs = &mut ctx.accounts.global_state;
        gs.master_authority = master_key;
        gs.mint = mint_key;
        gs.name = name;
        gs.symbol = symbol;
        gs.uri = uri;
        gs.decimals = params.decimals;
        gs.enable_permanent_delegate = params.enable_permanent_delegate;
        gs.enable_transfer_hook = params.enable_transfer_hook;
        gs.default_account_frozen = params.default_account_frozen;
        gs.is_paused = false;
        gs.pending_authority = None;
        gs.bump = ctx.bumps.global_state;

        let rr = &mut ctx.accounts.role_registry;
        rr.mint = mint_key;
        rr.bump = ctx.bumps.role_registry;

        let preset = if params.enable_permanent_delegate || params.enable_transfer_hook { 2 } else { 1 };
        emit!(StablecoinInitialized {
            mint: mint_key,
            master_authority: master_key,
            preset,
            name: gs.name.clone(),
            symbol: gs.symbol.clone(),
            decimals: gs.decimals,
        });

        Ok(())
    }

    /// Mints tokens to a recipient token account.
    /// Requires: minter role + valid quota + not paused.
    pub fn mint(ctx: Context<MintTokens>, amount: u64) -> Result<()> {
        let gs = &ctx.accounts.global_state;
        require!(!gs.is_paused, SssError::Paused);

        let minter_key = ctx.accounts.minter.key();
        // master_authority can also mint (acts as its own minter)
        require!(
            gs.master_authority == minter_key
                || ctx.accounts.minter_state.minter == minter_key,
            SssError::Unauthorized
        );

        // Quota enforcement
        let now = Clock::get()?.unix_timestamp;
        ctx.accounts.minter_state.check_and_update_quota(amount, now)?;

        let mint_key = ctx.accounts.mint.key();
        let sss_seeds: &[&[u8]] = &[b"sss", mint_key.as_ref(), &[gs.bump]];

        mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.recipient_token_account.to_account_info(),
                    authority: ctx.accounts.global_state.to_account_info(),
                },
                &[sss_seeds],
            ),
            amount,
        )?;

        emit!(Minted {
            mint: mint_key,
            minter: minter_key,
            recipient: ctx.accounts.recipient_token_account.key(),
            amount,
        });
        Ok(())
    }

    /// Burns tokens from the burner's token account.
    /// Requires: burner role (or master) + not paused.
    pub fn burn(ctx: Context<BurnTokens>, amount: u64) -> Result<()> {
        let gs = &ctx.accounts.global_state;
        require!(!gs.is_paused, SssError::Paused);
        require!(
            can_burn(gs, &ctx.accounts.role_registry, &ctx.accounts.burner.key()),
            SssError::Unauthorized
        );

        let mint_key = ctx.accounts.mint.key();
        let sss_seeds: &[&[u8]] = &[b"sss", mint_key.as_ref(), &[gs.bump]];

        token_burn(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TokenBurn {
                    mint: ctx.accounts.mint.to_account_info(),
                    from: ctx.accounts.burner_token_account.to_account_info(),
                    authority: ctx.accounts.global_state.to_account_info(),
                },
                &[sss_seeds],
            ),
            amount,
        )?;

        emit!(Burned {
            mint: mint_key,
            burner: ctx.accounts.burner.key(),
            amount,
        });
        Ok(())
    }

    /// Freezes a token account. Requires: master or pauser role.
    pub fn freeze_account(ctx: Context<FreezeThaw>) -> Result<()> {
        let gs = &ctx.accounts.global_state;
        require!(
            can_pause(gs, &ctx.accounts.role_registry, &ctx.accounts.authority.key()),
            SssError::Unauthorized
        );

        let mint_key = ctx.accounts.mint.key();
        let sss_seeds: &[&[u8]] = &[b"sss", mint_key.as_ref(), &[gs.bump]];

        token_2022_crate::freeze_account(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                FreezeAccount {
                    account: ctx.accounts.target_token_account.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    authority: ctx.accounts.global_state.to_account_info(),
                },
                &[sss_seeds],
            ),
        )?;

        emit!(AccountFrozen {
            mint: mint_key,
            target: ctx.accounts.target_token_account.key(),
        });
        Ok(())
    }

    /// Thaws a frozen token account. Requires: master or pauser role.
    pub fn thaw_account(ctx: Context<FreezeThaw>) -> Result<()> {
        let gs = &ctx.accounts.global_state;
        require!(
            can_pause(gs, &ctx.accounts.role_registry, &ctx.accounts.authority.key()),
            SssError::Unauthorized
        );

        let mint_key = ctx.accounts.mint.key();
        let sss_seeds: &[&[u8]] = &[b"sss", mint_key.as_ref(), &[gs.bump]];

        token_2022_crate::thaw_account(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                ThawAccount {
                    account: ctx.accounts.target_token_account.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    authority: ctx.accounts.global_state.to_account_info(),
                },
                &[sss_seeds],
            ),
        )?;

        emit!(AccountThawed {
            mint: mint_key,
            target: ctx.accounts.target_token_account.key(),
        });
        Ok(())
    }

    /// Pauses all minting/burning. Requires: pauser role.
    pub fn pause(ctx: Context<PauseUnpause>) -> Result<()> {
        let authority_key = ctx.accounts.authority.key();
        let gs = &mut ctx.accounts.global_state;
        require!(
            can_pause(gs, &ctx.accounts.role_registry, &authority_key),
            SssError::Unauthorized
        );
        gs.is_paused = true;
        emit!(Paused { mint: gs.mint, by: authority_key });
        Ok(())
    }

    /// Unpauses minting/burning. Requires: pauser role.
    pub fn unpause(ctx: Context<PauseUnpause>) -> Result<()> {
        let authority_key = ctx.accounts.authority.key();
        let gs = &mut ctx.accounts.global_state;
        require!(
            can_pause(gs, &ctx.accounts.role_registry, &authority_key),
            SssError::Unauthorized
        );
        gs.is_paused = false;
        emit!(Unpaused { mint: gs.mint, by: authority_key });
        Ok(())
    }

    /// Creates or updates a minter's quota. Requires: master authority.
    pub fn update_minter(
        ctx: Context<UpdateMinter>,
        new_quota: u64,
        epoch_duration: Option<i64>,
    ) -> Result<()> {
        let gs = &ctx.accounts.global_state;
        require!(is_master(gs, &ctx.accounts.master_authority.key()), SssError::Unauthorized);

        let ms = &mut ctx.accounts.minter_state;
        ms.mint = ctx.accounts.mint.key();
        ms.minter = ctx.accounts.minter.key();
        ms.max_quota = new_quota;
        ms.minted_this_epoch = 0; // reset on update
        ms.epoch_start = Clock::get()?.unix_timestamp;
        ms.epoch_duration = epoch_duration.unwrap_or(DEFAULT_EPOCH_DURATION);
        if ms.bump == 0 {
            ms.bump = ctx.bumps.minter_state;
        }

        emit!(MinterUpdated {
            mint: gs.mint,
            minter: ctx.accounts.minter.key(),
            new_quota,
            epoch_duration: ms.epoch_duration,
        });
        Ok(())
    }

    /// Updates a role. Requires: master authority.
    /// role_type: "pauser" | "burner" | "blacklister" | "seizer"
    pub fn update_roles(
        ctx: Context<UpdateRoles>,
        role_type: String,
        new_key: Option<Pubkey>,
    ) -> Result<()> {
        let gs = &ctx.accounts.global_state;
        require!(is_master(gs, &ctx.accounts.master_authority.key()), SssError::Unauthorized);

        let rr = &mut ctx.accounts.role_registry;
        match role_type.as_str() {
            "pauser" => rr.pauser = new_key,
            "burner" => rr.burner = new_key,
            "blacklister" => {
                require!(gs.enable_transfer_hook || gs.enable_permanent_delegate, SssError::FeatureNotEnabled);
                rr.blacklister = new_key;
            }
            "seizer" => {
                require!(gs.enable_permanent_delegate, SssError::FeatureNotEnabled);
                rr.seizer = new_key;
            }
            _ => return err!(SssError::Unauthorized),
        }

        emit!(RolesUpdated {
            mint: gs.mint,
            role_type,
            new_key: new_key.unwrap_or_default(),
        });
        Ok(())
    }

    /// Step 1 of authority transfer: proposes a new master authority.
    /// Requires: current master authority.
    pub fn propose_authority_transfer(
        ctx: Context<ProposeAuthorityTransfer>,
        new_authority: Pubkey,
    ) -> Result<()> {
        let gs = &mut ctx.accounts.global_state;
        require!(is_master(gs, &ctx.accounts.master_authority.key()), SssError::Unauthorized);
        require!(gs.pending_authority.is_none(), SssError::PendingTransfer);
        gs.pending_authority = Some(new_authority);
        emit!(AuthorityTransferProposed {
            mint: gs.mint,
            proposed_by: ctx.accounts.master_authority.key(),
            new_authority,
        });
        Ok(())
    }

    /// Step 2: new authority accepts the transfer.
    pub fn accept_authority_transfer(ctx: Context<AcceptAuthorityTransfer>) -> Result<()> {
        let gs = &mut ctx.accounts.global_state;
        let pending = gs.pending_authority.ok_or(SssError::NoPendingTransfer)?;
        require!(pending == ctx.accounts.new_authority.key(), SssError::WrongPendingAuthority);
        let old = gs.master_authority;
        gs.master_authority = pending;
        gs.pending_authority = None;
        emit!(AuthorityTransferCompleted {
            mint: gs.mint,
            old_authority: old,
            new_authority: pending,
        });
        Ok(())
    }

    // ── SSS-2 instructions ────────────────────────────────────────────────────

    /// Adds an address to the blacklist. SSS-2 only.
    pub fn add_to_blacklist(
        ctx: Context<AddToBlacklist>,
        address: Pubkey,
        reason: String,
    ) -> Result<()> {
        let gs = &ctx.accounts.global_state;
        require!(gs.enable_transfer_hook, SssError::FeatureNotEnabled);
        require!(reason.len() <= MAX_REASON_LEN, SssError::StringTooLong);
        require!(
            can_blacklist(gs, &ctx.accounts.role_registry, &ctx.accounts.blacklister.key()),
            SssError::Unauthorized
        );

        let entry = &mut ctx.accounts.blacklist_entry;
        entry.mint = gs.mint;
        entry.address = address;
        entry.reason = reason.clone();
        entry.timestamp = Clock::get()?.unix_timestamp;
        entry.by = ctx.accounts.blacklister.key();
        entry.bump = ctx.bumps.blacklist_entry;

        emit!(Blacklisted {
            mint: gs.mint,
            address,
            reason,
            by: ctx.accounts.blacklister.key(),
        });
        Ok(())
    }

    /// Removes an address from the blacklist. SSS-2 only.
    pub fn remove_from_blacklist(
        ctx: Context<RemoveFromBlacklist>,
        address: Pubkey,
    ) -> Result<()> {
        let gs = &ctx.accounts.global_state;
        require!(gs.enable_transfer_hook, SssError::FeatureNotEnabled);
        require!(
            can_blacklist(gs, &ctx.accounts.role_registry, &ctx.accounts.blacklister.key()),
            SssError::Unauthorized
        );

        emit!(RemovedFromBlacklist {
            mint: gs.mint,
            address,
            by: ctx.accounts.blacklister.key(),
        });
        // Account is closed by anchor constraint `close = payer`
        Ok(())
    }

    /// Seizes tokens from a source account to a destination account.
    /// Uses the permanent delegate extension. SSS-2 only.
    pub fn seize(ctx: Context<Seize>, amount: u64) -> Result<()> {
        let gs = &ctx.accounts.global_state;
        require!(gs.enable_permanent_delegate, SssError::FeatureNotEnabled);
        require!(
            can_seize(gs, &ctx.accounts.role_registry, &ctx.accounts.seizer.key()),
            SssError::Unauthorized
        );

        let mint_key = ctx.accounts.mint.key();
        let sss_seeds: &[&[u8]] = &[b"sss", mint_key.as_ref(), &[gs.bump]];

        // The permanent delegate (global_state PDA) transfers on behalf of source.
        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.source_token_account.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.destination_token_account.to_account_info(),
                    authority: ctx.accounts.global_state.to_account_info(),
                },
                &[sss_seeds],
            ),
            amount,
            gs.decimals,
        )?;

        emit!(Seized {
            mint: mint_key,
            source: ctx.accounts.source_token_account.key(),
            destination: ctx.accounts.destination_token_account.key(),
            amount,
            by: ctx.accounts.seizer.key(),
        });
        Ok(())
    }
}
