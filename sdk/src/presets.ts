/**
 * Preset configurations for the Solana Stablecoin Standard.
 *
 * SSS-1: Minimal stablecoin — suitable for most use cases.
 * SSS-2: Compliant stablecoin — required for regulated environments (OFAC, GENIUS Act).
 */

import { Presets, ExtensionConfig } from "./types";

/** Full extension configuration for each preset. */
export const PRESET_CONFIGS: Record<Presets, ExtensionConfig> = {
  [Presets.SSS_1]: {
    permanentDelegate: false,
    transferHook: false,
    defaultAccountFrozen: false,
  },
  [Presets.SSS_2]: {
    permanentDelegate: true,
    transferHook: true,
    defaultAccountFrozen: true,
  },
};

/** Human-readable descriptions for each preset. */
export const PRESET_DESCRIPTIONS: Record<Presets, string> = {
  [Presets.SSS_1]: [
    "SSS-1: Minimal Stablecoin Standard",
    "  ✓ Token-2022 mint with inline metadata",
    "  ✓ Freeze authority for account freezing",
    "  ✓ Role-based access control (minter, burner, pauser)",
    "  ✓ Per-minter quotas with epoch-based resets",
    "  ✓ Pause / unpause",
    "  ✓ Two-step authority transfer",
    "  ✗ No blacklist enforcement",
    "  ✗ No seizure capability",
  ].join("\n"),
  [Presets.SSS_2]: [
    "SSS-2: Compliant Stablecoin Standard",
    "  ✓ Everything in SSS-1",
    "  ✓ Transfer hook (every transfer checked against blacklist)",
    "  ✓ Permanent delegate (enables seizure without account owner signature)",
    "  ✓ Default account state frozen (all new accounts frozen until thawed)",
    "  ✓ Blacklist with on-chain audit trail",
    "  ✓ Seizure via permanent delegate",
    "  ✓ Compliance roles (blacklister, seizer)",
  ].join("\n"),
};

/**
 * Resolves extension config from preset or custom config.
 */
export function resolveExtensions(
  preset?: Presets,
  custom?: ExtensionConfig
): ExtensionConfig {
  if (preset) {
    return PRESET_CONFIGS[preset];
  }
  return {
    permanentDelegate: custom?.permanentDelegate ?? false,
    transferHook: custom?.transferHook ?? false,
    defaultAccountFrozen: custom?.defaultAccountFrozen ?? false,
  };
}
