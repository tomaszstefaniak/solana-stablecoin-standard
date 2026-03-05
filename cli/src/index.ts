#!/usr/bin/env node
/**
 * sss-token CLI — Admin tool for the Solana Stablecoin Standard
 *
 * Configuration (in order of precedence):
 *   1. Flags:   --cluster, --wallet, --mint
 *   2. Env:     SSS_CLUSTER, SSS_WALLET, SSS_MINT
 *   3. Config:  ~/.config/sss-token/config.toml
 *
 * @example
 * ```bash
 * sss-token init --preset sss-2 --name "MyUSD" --symbol "MUSD" --decimals 6
 * sss-token mint <recipient> <amount>
 * sss-token blacklist add <address> --reason "OFAC match"
 * sss-token status
 * ```
 */

import { Command } from "commander";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import chalk from "chalk";
import {
  SolanaStablecoin,
  Presets,
  PRESET_DESCRIPTIONS,
} from "@stbr/sss-token";
import BN from "bn.js";

// ─────────────────────────────────────────
// Config
// ─────────────────────────────────────────

interface CliConfig {
  cluster: string;
  wallet: string;
  mint?: string;
}

function loadConfig(overrides: Partial<CliConfig>): CliConfig {
  const configPath = join(homedir(), ".config", "sss-token", "config.toml");
  let fileConfig: Partial<CliConfig> = {};

  if (existsSync(configPath)) {
    try {
      const content = readFileSync(configPath, "utf-8");
      // Simple TOML key=value parsing
      for (const line of content.split("\n")) {
        const [key, ...rest] = line.split("=");
        if (key && rest.length) {
          const val = rest.join("=").trim().replace(/^["']|["']$/g, "");
          (fileConfig as any)[key.trim()] = val;
        }
      }
    } catch {
      // ignore malformed config
    }
  }

  return {
    cluster:
      overrides.cluster ??
      process.env.SSS_CLUSTER ??
      fileConfig.cluster ??
      "https://api.devnet.solana.com",
    wallet:
      overrides.wallet ??
      process.env.SSS_WALLET ??
      fileConfig.wallet ??
      join(homedir(), ".config", "solana", "id.json"),
    mint: overrides.mint ?? process.env.SSS_MINT ?? fileConfig.mint,
  };
}

function loadKeypair(walletPath: string): Keypair {
  const raw = JSON.parse(readFileSync(walletPath, "utf-8"));
  return Keypair.fromSecretKey(Buffer.from(raw));
}

function requireMint(config: CliConfig): PublicKey {
  if (!config.mint) {
    console.error(
      chalk.red(
        "Error: --mint is required (or set SSS_MINT / config.toml mint field)"
      )
    );
    process.exit(1);
  }
  return new PublicKey(config.mint);
}

function success(msg: string): void {
  console.log(chalk.green("✓"), msg);
}

function info(label: string, value: string): void {
  console.log(`  ${chalk.cyan(label.padEnd(24))} ${value}`);
}

// ─────────────────────────────────────────
// CLI definition
// ─────────────────────────────────────────

const program = new Command();

program
  .name("sss-token")
  .description("Admin CLI for the Solana Stablecoin Standard (SSS-1 / SSS-2)")
  .version("0.1.0")
  .option("--cluster <url>", "Solana cluster URL")
  .option("--wallet <path>", "Path to keypair JSON file")
  .option("--mint <address>", "Stablecoin mint address");

// ─── init ───────────────────────────────

program
  .command("init")
  .description("Initialize a new stablecoin mint")
  .option("--preset <preset>", "sss-1 or sss-2")
  .option("--name <name>", "Token name")
  .option("--symbol <symbol>", "Token symbol")
  .option("--decimals <n>", "Decimal places", "6")
  .option("--uri <uri>", "Metadata URI", "")
  .action(async (opts, cmd) => {
    const global = cmd.parent.opts();
    const config = loadConfig(global);
    const authority = loadKeypair(config.wallet);
    const connection = new Connection(config.cluster, "confirmed");

    const preset = opts.preset === "sss-2" ? Presets.SSS_2 : Presets.SSS_1;

    console.log(chalk.bold("\nInitializing stablecoin..."));
    if (opts.preset) {
      console.log(PRESET_DESCRIPTIONS[preset]);
      console.log();
    }

    const stable = await SolanaStablecoin.create(connection, {
      preset,
      name: opts.name,
      symbol: opts.symbol,
      uri: opts.uri,
      decimals: parseInt(opts.decimals, 10),
      authority,
    });

    success(`Mint: ${stable.mintPubkey.toBase58()}`);
    success(`Global state: ${stable.globalStatePda().toBase58()}`);

    // Save mint address to config
    const configDir = join(homedir(), ".config", "sss-token");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.toml"),
      `cluster = "${config.cluster}"\nwallet = "${config.wallet}"\nmint = "${stable.mintPubkey.toBase58()}"\n`
    );
    success("Saved mint address to ~/.config/sss-token/config.toml");
  });

// ─── status ─────────────────────────────

program
  .command("status")
  .description("Show stablecoin status (supply, roles, pause state)")
  .action(async (_opts, cmd) => {
    const global = cmd.parent.opts();
    const config = loadConfig(global);
    const authority = loadKeypair(config.wallet);
    const mintPubkey = requireMint(config);
    const connection = new Connection(config.cluster, "confirmed");

    const stable = await SolanaStablecoin.load(connection, mintPubkey, authority);
    const gs = await stable.getGlobalState();
    const roles = await stable.getRoles();
    const supply = await stable.getTotalSupply();

    console.log(chalk.bold("\n── Stablecoin Status ───────────────────────\n"));
    info("Mint", mintPubkey.toBase58());
    info("Name", gs.name);
    info("Symbol", gs.symbol);
    info("Decimals", gs.decimals.toString());
    info("Preset", gs.enableTransferHook ? "SSS-2 (Compliant)" : "SSS-1 (Minimal)");
    info("Total Supply", supply.toString());
    info("Paused", gs.isPaused ? chalk.red("YES") : chalk.green("no"));
    info("Master Authority", gs.masterAuthority.toBase58());
    info("Pauser", roles.pauser?.toBase58() ?? "(none)");
    info("Burner", roles.burner?.toBase58() ?? "(none)");
    if (gs.enableTransferHook) {
      info("Blacklister", roles.blacklister?.toBase58() ?? "(none)");
    }
    if (gs.enablePermanentDelegate) {
      info("Seizer", roles.seizer?.toBase58() ?? "(none)");
    }
    console.log();
  });

// ─── supply ─────────────────────────────

program
  .command("supply")
  .description("Show total token supply")
  .action(async (_opts, cmd) => {
    const global = cmd.parent.opts();
    const config = loadConfig(global);
    const authority = loadKeypair(config.wallet);
    const mintPubkey = requireMint(config);
    const connection = new Connection(config.cluster, "confirmed");

    const stable = await SolanaStablecoin.load(connection, mintPubkey, authority);
    const supply = await stable.getTotalSupply();
    console.log(supply.toString());
  });

// ─── mint ────────────────────────────────

program
  .command("mint <recipient> <amount>")
  .description("Mint tokens to a recipient")
  .action(async (recipient, amount, _opts, cmd) => {
    const global = cmd.parent.opts();
    const config = loadConfig(global);
    const minter = loadKeypair(config.wallet);
    const mintPubkey = requireMint(config);
    const connection = new Connection(config.cluster, "confirmed");

    const stable = await SolanaStablecoin.load(connection, mintPubkey, minter);
    const tx = await stable.mint({
      recipient: new PublicKey(recipient),
      amount: new BN(amount),
      minter,
    });

    success(`Minted ${amount} tokens to ${recipient}`);
    info("Transaction", tx);
  });

// ─── burn ────────────────────────────────

program
  .command("burn <amount>")
  .description("Burn tokens from wallet's token account")
  .action(async (amount, _opts, cmd) => {
    const global = cmd.parent.opts();
    const config = loadConfig(global);
    const burner = loadKeypair(config.wallet);
    const mintPubkey = requireMint(config);
    const connection = new Connection(config.cluster, "confirmed");

    const stable = await SolanaStablecoin.load(connection, mintPubkey, burner);
    const tx = await stable.burn({ amount: new BN(amount), burner });

    success(`Burned ${amount} tokens`);
    info("Transaction", tx);
  });

// ─── freeze / thaw ──────────────────────

program
  .command("freeze <address>")
  .description("Freeze a token account")
  .action(async (address, _opts, cmd) => {
    const global = cmd.parent.opts();
    const config = loadConfig(global);
    const authority = loadKeypair(config.wallet);
    const mintPubkey = requireMint(config);
    const connection = new Connection(config.cluster, "confirmed");

    const stable = await SolanaStablecoin.load(connection, mintPubkey, authority);
    const tx = await stable.freeze(new PublicKey(address), authority);

    success(`Frozen: ${address}`);
    info("Transaction", tx);
  });

program
  .command("thaw <address>")
  .description("Thaw a frozen token account")
  .action(async (address, _opts, cmd) => {
    const global = cmd.parent.opts();
    const config = loadConfig(global);
    const authority = loadKeypair(config.wallet);
    const mintPubkey = requireMint(config);
    const connection = new Connection(config.cluster, "confirmed");

    const stable = await SolanaStablecoin.load(connection, mintPubkey, authority);
    const tx = await stable.thaw(new PublicKey(address), authority);

    success(`Thawed: ${address}`);
    info("Transaction", tx);
  });

// ─── pause / unpause ────────────────────

program
  .command("pause")
  .description("Pause all minting and burning")
  .action(async (_opts, cmd) => {
    const global = cmd.parent.opts();
    const config = loadConfig(global);
    const authority = loadKeypair(config.wallet);
    const mintPubkey = requireMint(config);
    const connection = new Connection(config.cluster, "confirmed");

    const stable = await SolanaStablecoin.load(connection, mintPubkey, authority);
    const tx = await stable.pause(authority);

    success("Token paused");
    info("Transaction", tx);
  });

program
  .command("unpause")
  .description("Unpause minting and burning")
  .action(async (_opts, cmd) => {
    const global = cmd.parent.opts();
    const config = loadConfig(global);
    const authority = loadKeypair(config.wallet);
    const mintPubkey = requireMint(config);
    const connection = new Connection(config.cluster, "confirmed");

    const stable = await SolanaStablecoin.load(connection, mintPubkey, authority);
    const tx = await stable.unpause(authority);

    success("Token unpaused");
    info("Transaction", tx);
  });

// ─── minters ────────────────────────────

const mintersCmd = program.command("minters").description("Manage minters");

mintersCmd
  .command("add <address>")
  .description("Add/update a minter with quota")
  .option("--quota <amount>", "Max mint amount per epoch", "1000000000")
  .option("--epoch <seconds>", "Epoch duration in seconds", "86400")
  .action(async (address, opts, cmd) => {
    const global = cmd.parent.parent.opts();
    const config = loadConfig(global);
    const authority = loadKeypair(config.wallet);
    const mintPubkey = requireMint(config);
    const connection = new Connection(config.cluster, "confirmed");

    const stable = await SolanaStablecoin.load(connection, mintPubkey, authority);
    const tx = await stable.updateMinter({
      minter: new PublicKey(address),
      maxQuota: new BN(opts.quota),
      epochDuration: parseInt(opts.epoch, 10),
      authority,
    });

    success(`Minter added/updated: ${address}`);
    info("Quota", opts.quota);
    info("Transaction", tx);
  });

mintersCmd
  .command("list")
  .description("List all registered minters")
  .action(async (_opts, cmd) => {
    const global = cmd.parent.parent.opts();
    const config = loadConfig(global);
    const authority = loadKeypair(config.wallet);
    const mintPubkey = requireMint(config);
    const connection = new Connection(config.cluster, "confirmed");

    const stable = await SolanaStablecoin.load(connection, mintPubkey, authority);
    // Note: full enumeration requires gPA — shows a placeholder message
    console.log(chalk.yellow("Tip: use getProgramAccounts with memcmp filter for minter enumeration."));
    console.log(`Program ID: ${stable["program"].programId.toBase58()}`);
  });

// ─── blacklist ──────────────────────────

const blacklistCmd = program
  .command("blacklist")
  .description("Manage blacklist (SSS-2 only)");

blacklistCmd
  .command("add <address>")
  .description("Add address to blacklist")
  .option("--reason <reason>", "Reason for blacklisting", "Compliance action")
  .action(async (address, opts, cmd) => {
    const global = cmd.parent.parent.opts();
    const config = loadConfig(global);
    const blacklister = loadKeypair(config.wallet);
    const mintPubkey = requireMint(config);
    const connection = new Connection(config.cluster, "confirmed");

    const stable = await SolanaStablecoin.load(connection, mintPubkey, blacklister);
    const tx = await stable.compliance.blacklistAdd({
      address: new PublicKey(address),
      reason: opts.reason,
      blacklister,
    });

    success(`Blacklisted: ${address}`);
    info("Reason", opts.reason);
    info("Transaction", tx);
  });

blacklistCmd
  .command("remove <address>")
  .description("Remove address from blacklist")
  .action(async (address, _opts, cmd) => {
    const global = cmd.parent.parent.opts();
    const config = loadConfig(global);
    const blacklister = loadKeypair(config.wallet);
    const mintPubkey = requireMint(config);
    const connection = new Connection(config.cluster, "confirmed");

    const stable = await SolanaStablecoin.load(connection, mintPubkey, blacklister);
    const tx = await stable.compliance.blacklistRemove({
      address: new PublicKey(address),
      blacklister,
    });

    success(`Removed from blacklist: ${address}`);
    info("Transaction", tx);
  });

blacklistCmd
  .command("list")
  .description("List all blacklisted addresses")
  .action(async (_opts, cmd) => {
    const global = cmd.parent.parent.opts();
    const config = loadConfig(global);
    const authority = loadKeypair(config.wallet);
    const mintPubkey = requireMint(config);
    const connection = new Connection(config.cluster, "confirmed");

    const stable = await SolanaStablecoin.load(connection, mintPubkey, authority);
    const entries = await stable.compliance.getBlacklist();

    if (entries.length === 0) {
      console.log(chalk.green("No blacklisted addresses."));
    } else {
      console.log(chalk.bold(`\n── Blacklist (${entries.length} entries) ─────────\n`));
      for (const entry of entries) {
        info("Address", entry.address.toBase58());
        info("  Reason", entry.reason);
        info("  Added by", entry.by.toBase58());
        info("  Timestamp", new Date(entry.timestamp.toNumber() * 1000).toISOString());
        console.log();
      }
    }
  });

// ─── seize ──────────────────────────────

program
  .command("seize <source>")
  .description("Seize tokens from an account (SSS-2 only)")
  .requiredOption("--to <destination>", "Destination token account")
  .option("--amount <amount>", "Amount to seize (default: full balance)")
  .action(async (source, opts, cmd) => {
    const global = cmd.parent.opts();
    const config = loadConfig(global);
    const seizer = loadKeypair(config.wallet);
    const mintPubkey = requireMint(config);
    const connection = new Connection(config.cluster, "confirmed");

    const stable = await SolanaStablecoin.load(connection, mintPubkey, seizer);

    let amount: BN;
    if (opts.amount) {
      amount = new BN(opts.amount);
    } else {
      amount = await stable.getBalance(new PublicKey(source));
    }

    const tx = await stable.compliance.seize({
      source: new PublicKey(source),
      destination: new PublicKey(opts.to),
      amount,
      seizer,
    });

    success(`Seized ${amount.toString()} tokens from ${source}`);
    info("Destination", opts.to);
    info("Transaction", tx);
  });

// ─── roles ──────────────────────────────

const rolesCmd = program.command("roles").description("Manage roles");

rolesCmd
  .command("set <role> <address>")
  .description("Set a role (pauser, burner, blacklister, seizer)")
  .action(async (role, address, _opts, cmd) => {
    const global = cmd.parent.parent.opts();
    const config = loadConfig(global);
    const authority = loadKeypair(config.wallet);
    const mintPubkey = requireMint(config);
    const connection = new Connection(config.cluster, "confirmed");

    const stable = await SolanaStablecoin.load(connection, mintPubkey, authority);
    const tx = await stable.updateRoles({
      roleType: role as any,
      newKey: new PublicKey(address),
      authority,
    });

    success(`Role '${role}' assigned to ${address}`);
    info("Transaction", tx);
  });

rolesCmd
  .command("revoke <role>")
  .description("Revoke a role")
  .action(async (role, _opts, cmd) => {
    const global = cmd.parent.parent.opts();
    const config = loadConfig(global);
    const authority = loadKeypair(config.wallet);
    const mintPubkey = requireMint(config);
    const connection = new Connection(config.cluster, "confirmed");

    const stable = await SolanaStablecoin.load(connection, mintPubkey, authority);
    const tx = await stable.updateRoles({
      roleType: role as any,
      newKey: null,
      authority,
    });

    success(`Role '${role}' revoked`);
    info("Transaction", tx);
  });

// ─── authority transfer ─────────────────

program
  .command("transfer-authority <new-authority>")
  .description("Propose authority transfer (two-step)")
  .action(async (newAuthority, _opts, cmd) => {
    const global = cmd.parent.opts();
    const config = loadConfig(global);
    const authority = loadKeypair(config.wallet);
    const mintPubkey = requireMint(config);
    const connection = new Connection(config.cluster, "confirmed");

    const stable = await SolanaStablecoin.load(connection, mintPubkey, authority);
    const tx = await stable.proposeAuthorityTransfer({
      newAuthority: new PublicKey(newAuthority),
      currentAuthority: authority,
    });

    success(`Authority transfer proposed to ${newAuthority}`);
    info("Transaction", tx);
    console.log(chalk.yellow("\nStep 2: new authority must run:"));
    console.log(`  sss-token accept-authority --mint ${mintPubkey.toBase58()}`);
  });

program
  .command("accept-authority")
  .description("Accept a pending authority transfer")
  .action(async (_opts, cmd) => {
    const global = cmd.parent.opts();
    const config = loadConfig(global);
    const newAuthority = loadKeypair(config.wallet);
    const mintPubkey = requireMint(config);
    const connection = new Connection(config.cluster, "confirmed");

    const stable = await SolanaStablecoin.load(connection, mintPubkey, newAuthority);
    const tx = await stable.acceptAuthorityTransfer({ newAuthority });

    success("Authority transfer accepted");
    info("New authority", newAuthority.publicKey.toBase58());
    info("Transaction", tx);
  });

// ─────────────────────────────────────────
// Main
// ─────────────────────────────────────────

program.parseAsync(process.argv).catch((err) => {
  console.error(chalk.red("Error:"), err.message);
  process.exit(1);
});
