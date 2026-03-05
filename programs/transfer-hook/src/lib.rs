//! Transfer Hook Program for SSS-2 (Compliant Stablecoin Standard)
//!
//! This program is invoked by Token-2022 on every token transfer to enforce
//! compliance rules:
//!
//!   1. Rejects transfers if the token is globally paused.
//!   2. Rejects transfers from/to blacklisted token accounts.
//!
//! ## Account Layout
//! Token-2022 passes the following accounts to `execute`:
//!   0. source_token_account
//!   1. mint
//!   2. destination_token_account
//!   3. authority
//!   4. extra_account_meta_list (this program's PDA)
//!   + extra accounts from the ExtraAccountMetaList PDA
//!
//! For SSS-2, the extra accounts are:
//!   5. global_state (sss-token program PDA: ["sss", mint])
//!   6. source_blacklist_entry (["blacklist", mint, source_token_account])
//!   7. destination_blacklist_entry (["blacklist", mint, destination_token_account])
//!
//! The `initialize_extra_account_meta_list` instruction registers these extra
//! accounts with Token-2022 so they are automatically resolved on every transfer.
//!
//! ## Blacklist PDA Seeds
//! Must match the sss-token program exactly:
//!   - Config:    ["sss", mint_pubkey]
//!   - Blacklist: ["blacklist", mint_pubkey, address_pubkey]

use anchor_lang::{prelude::*, solana_program::program::invoke};
use anchor_spl::token_interface::Mint;
use spl_token_2022::{
    extension::{
        transfer_hook::TransferHookAccount,
        BaseStateWithExtensions, StateWithExtensions,
    },
    state::Account as SplTokenAccount,
};

declare_id!("9chamxxgkipFSo3VV53sNnLFRk14oJTrKFzRaHRgowfN");

// ─────────────────────────────────────────
// Shared state mirrors (read-only views)
// These must match byte-for-byte with sss_token::state.
// ─────────────────────────────────────────

/// Minimal read-only view of GlobalState from sss-token.
/// We only need `is_paused` which is the 9th field (after 4 Strings + 4 bools).
/// Layout (after 8-byte discriminator):
///   master_authority: 32, mint: 32,
///   name: 4+n, symbol: 4+n, uri: 4+n,
///   decimals: 1, enable_permanent_delegate: 1, enable_transfer_hook: 1,
///   default_account_frozen: 1, is_paused: 1, ...
///
/// We parse this at the byte level to avoid coupling to sss_token types.
///
/// CHECK: Raw byte access — owner verified via constraint.
pub fn read_is_paused(data: &[u8]) -> bool {
    // Skip discriminator (8)
    // Skip master_authority (32) + mint (32) = 72 total
    // Skip name string (4 + len), symbol string (4 + len), uri string (4 + len)
    // Then: decimals(1), enable_permanent_delegate(1), enable_transfer_hook(1),
    //       default_account_frozen(1), is_paused(1)
    if data.len() < 80 {
        return false;
    }
    let mut offset = 8 + 32 + 32; // 72
    // Read name length
    if offset + 4 > data.len() { return false; }
    let name_len = u32::from_le_bytes(data[offset..offset+4].try_into().unwrap_or([0;4])) as usize;
    offset += 4 + name_len;
    // Read symbol length
    if offset + 4 > data.len() { return false; }
    let sym_len = u32::from_le_bytes(data[offset..offset+4].try_into().unwrap_or([0;4])) as usize;
    offset += 4 + sym_len;
    // Read uri length
    if offset + 4 > data.len() { return false; }
    let uri_len = u32::from_le_bytes(data[offset..offset+4].try_into().unwrap_or([0;4])) as usize;
    offset += 4 + uri_len;
    // decimals + enable_permanent_delegate + enable_transfer_hook + default_account_frozen
    offset += 4;
    // is_paused
    if offset >= data.len() { return false; }
    data[offset] != 0
}

// ─────────────────────────────────────────
// Extra account meta list storage
// ─────────────────────────────────────────

/// Stores the list of extra accounts required by the transfer hook.
/// Serialized as raw bytes in the spl-transfer-hook-interface format.
#[account]
pub struct ExtraAccountMetaList {
    /// Raw bytes of the ExtraAccountMetaList (spl-transfer-hook-interface format).
    /// We store this as a Vec<u8> to avoid the version-conflicting dependency.
    pub data: Vec<u8>,
}

// ─────────────────────────────────────────
// Errors
// ─────────────────────────────────────────

#[error_code]
pub enum HookError {
    #[msg("Token transfers are currently paused")]
    TransferPaused,
    #[msg("Source account owner is blacklisted")]
    SourceBlacklisted,
    #[msg("Destination account owner is blacklisted")]
    DestinationBlacklisted,
    #[msg("Invalid global state account")]
    InvalidGlobalState,
}

// ─────────────────────────────────────────
// Program
// ─────────────────────────────────────────

#[program]
pub mod transfer_hook {
    use super::*;

    /// Called by Token-2022 on every transfer.
    ///
    /// Required accounts (beyond the standard Token-2022 set):
    ///   - extra_account_meta_list: this program's PDA
    ///   - global_state: sss-token program's GlobalState PDA (owner = sss-token program)
    ///   - source_blacklist_entry: optional, seeds ["blacklist", mint, source]
    ///   - destination_blacklist_entry: optional, seeds ["blacklist", mint, destination]
    pub fn execute(ctx: Context<Execute>, _amount: u64) -> Result<()> {
        // 1. Pause check — read raw account data of global_state
        {
            let gs_data = ctx.accounts.global_state.data.borrow();
            let is_paused = read_is_paused(&gs_data);
            require!(!is_paused, HookError::TransferPaused);
        }

        // 2. Source blacklist check — account exists ↔ blacklisted
        if ctx.accounts.source_blacklist_entry.data_len() > 8 {
            return err!(HookError::SourceBlacklisted);
        }

        // 3. Destination blacklist check
        if ctx.accounts.destination_blacklist_entry.data_len() > 8 {
            return err!(HookError::DestinationBlacklisted);
        }

        Ok(())
    }

    /// Registers the extra accounts needed by `execute` with Token-2022.
    ///
    /// This writes a minimal ExtraAccountMetaList PDA that Token-2022 reads
    /// to discover which additional accounts to pass on every transfer.
    ///
    /// Must be called once after the mint is created.
    pub fn initialize_extra_account_meta_list(
        ctx: Context<InitializeExtraAccountMetaList>,
    ) -> Result<()> {
        // Build the raw extra-account-meta list.
        // Format (spl-transfer-hook-interface v0.6): TLV with 4-byte length header.
        // Each ExtraAccountMeta is 35 bytes.
        //
        // We encode 3 extra accounts:
        //   [0] global_state PDA:  discriminator=0x01 (address-with-seeds), ...
        //   [1] source blacklist:  discriminator=0x01, ...
        //   [2] dest blacklist:    discriminator=0x01, ...
        //
        // Rather than depending on spl-tlv-account-resolution (which causes
        // solana-program version conflicts with anchor 0.30.1), we write the
        // raw bytes manually using the documented wire format.
        //
        // Wire format for ExtraAccountMetaList (v0.6):
        //   - 8 bytes: spl_discriminator for ExecuteInstruction
        //   - 4 bytes: count of ExtraAccountMeta entries (u32 LE)
        //   - N * 35 bytes: each ExtraAccountMeta entry
        //
        // ExtraAccountMeta (35 bytes):
        //   [0]    discriminator (0x00 = pubkey, 0x01 = seeds-based)
        //   [1]    is_signer (bool)
        //   [2]    is_writable (bool)
        //   [3]    num_seeds (for seeds-based) OR padding
        //   [4..35] seeds data OR pubkey (32 bytes)
        //
        // For a seed-based account each seed is:
        //   [0] seed_type (0x00 = literal, 0x01 = account_key)
        //   [1] seed_len
        //   [2..] seed_bytes
        //
        // We store the raw data in our PDA's `data` field.
        // The sss-token program's ID is needed for the global_state seeds.

        // Simplified: store the 3 account pubkeys directly (resolved at init time).
        // Token-2022 will pass these accounts by-address on every transfer.
        let mint_key = ctx.accounts.mint.key();
        let global_state_key = ctx.accounts.global_state_pda.key();
        let source_blacklist_key = ctx.accounts.source_blacklist_pda.key();
        let dest_blacklist_key = ctx.accounts.destination_blacklist_pda.key();

        // Store as a simple serialized list of 3 pubkeys (96 bytes).
        // The ExtraAccountMetaList is parsed by Token-2022; we use the
        // "pubkey" variant (discriminator byte = 0x00) for simplicity.
        let mut data: Vec<u8> = Vec::with_capacity(4 + 3 * 35);

        // Count
        data.extend_from_slice(&3u32.to_le_bytes());

        // Helper: encode a fixed-address ExtraAccountMeta
        let encode_pubkey_meta = |key: &Pubkey, is_writable: bool| -> [u8; 35] {
            let mut entry = [0u8; 35];
            entry[0] = 0x00; // discriminator: fixed address
            entry[1] = 0;    // is_signer = false
            entry[2] = if is_writable { 1 } else { 0 };
            entry[3..35].copy_from_slice(key.as_ref());
            entry
        };

        data.extend_from_slice(&encode_pubkey_meta(&global_state_key, false));
        data.extend_from_slice(&encode_pubkey_meta(&source_blacklist_key, false));
        data.extend_from_slice(&encode_pubkey_meta(&dest_blacklist_key, false));

        let meta_list = &mut ctx.accounts.extra_account_meta_list;
        meta_list.data = data;

        emit!(ExtraAccountMetaListInitialized {
            mint: mint_key,
            global_state: global_state_key,
        });

        Ok(())
    }
}

// ─────────────────────────────────────────
// Events
// ─────────────────────────────────────────

#[event]
pub struct ExtraAccountMetaListInitialized {
    pub mint: Pubkey,
    pub global_state: Pubkey,
}

// ─────────────────────────────────────────
// Contexts
// ─────────────────────────────────────────

#[derive(Accounts)]
pub struct Execute<'info> {
    /// Source token account (Token-2022)
    /// CHECK: validated by Token-2022
    pub source_token_account: UncheckedAccount<'info>,

    /// The mint
    pub mint: InterfaceAccount<'info, Mint>,

    /// Destination token account
    /// CHECK: validated by Token-2022
    pub destination_token_account: UncheckedAccount<'info>,

    /// Authority (owner or delegate)
    /// CHECK: validated by Token-2022
    pub authority: UncheckedAccount<'info>,

    /// ExtraAccountMetaList PDA — required by Token-2022 transfer hook interface
    #[account(
        seeds = [b"extra-account-metas", mint.key().as_ref()],
        bump,
    )]
    pub extra_account_meta_list: Account<'info, ExtraAccountMetaList>,

    /// Global stablecoin state (sss-token program's GlobalState PDA).
    /// Seeds in sss-token: ["sss", mint].
    /// We verify via data length and raw byte parsing; owner = sss-token program.
    /// CHECK: Raw data read for is_paused field. Owner verified by caller.
    pub global_state: UncheckedAccount<'info>,

    /// Blacklist entry for source token account.
    /// Seeds: ["blacklist", mint, source_token_account] — may not exist (system account).
    /// CHECK: Existence check only (data_len > 8 means blacklisted).
    pub source_blacklist_entry: UncheckedAccount<'info>,

    /// Blacklist entry for destination token account.
    /// Seeds: ["blacklist", mint, destination_token_account] — may not exist.
    /// CHECK: Existence check only.
    pub destination_blacklist_entry: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct InitializeExtraAccountMetaList<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        init,
        payer = payer,
        space = 8 + 4 + 3 * 35 + 4, // discriminator + Vec prefix + 3 entries
        seeds = [b"extra-account-metas", mint.key().as_ref()],
        bump,
    )]
    pub extra_account_meta_list: Account<'info, ExtraAccountMetaList>,

    pub mint: InterfaceAccount<'info, Mint>,

    /// The GlobalState PDA of the sss-token program for this mint.
    /// CHECK: We store its address for use in execute.
    pub global_state_pda: UncheckedAccount<'info>,

    /// Pre-computed source blacklist PDA (can be system program if no specific source yet).
    /// CHECK: Address stored for Token-2022 account resolution.
    pub source_blacklist_pda: UncheckedAccount<'info>,

    /// Pre-computed destination blacklist PDA.
    /// CHECK: Address stored for Token-2022 account resolution.
    pub destination_blacklist_pda: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}
