/**
 * @stbr/sss-token — Solana Stablecoin Standard SDK
 *
 * @example
 * ```typescript
 * import { SolanaStablecoin, Presets } from "@stbr/sss-token";
 *
 * const stable = await SolanaStablecoin.create(connection, {
 *   preset: Presets.SSS_2,
 *   name: "MyUSD",
 *   symbol: "MUSD",
 *   decimals: 6,
 *   authority: adminKeypair,
 * });
 *
 * await stable.mint({ recipient, amount: 1_000_000, minter: minterKp });
 * await stable.compliance.blacklistAdd({ address, reason: "OFAC match", blacklister });
 * ```
 */

export { SolanaStablecoin } from "./stablecoin";
export { ComplianceModule } from "./compliance";
export { Presets } from "./types";
export { PRESET_CONFIGS, PRESET_DESCRIPTIONS, resolveExtensions } from "./presets";
export { SSS_TOKEN_PROGRAM_ID, TRANSFER_HOOK_PROGRAM_ID, SSS_TOKEN_IDL } from "./idl";
export * from "./types";
