"use client";
import { useConnection, useWallet, useAnchorWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { AnchorProvider, Program, BN, web3 } from "@coral-xyz/anchor";
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { useState, useEffect, useCallback } from "react";
import SSS_IDL from "../idl/sss_token.json";

// Program IDs — from IDL (update address field in idl/sss_token.json after devnet deploy)
const SSS_TOKEN_PROGRAM_ID = new web3.PublicKey(SSS_IDL.address);

// Full IDL loaded from file
const IDL: any = SSS_IDL;



function shortKey(k: string) { return `${k.slice(0,4)}...${k.slice(-4)}`; }

function getProgram(connection: web3.Connection, wallet: any) {
  const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });
  return new Program(IDL, provider);
}

function getStablecoinPDA(mint: web3.PublicKey): [web3.PublicKey, number] {
  return web3.PublicKey.findProgramAddressSync(
    [Buffer.from("sss"), mint.toBuffer()], SSS_TOKEN_PROGRAM_ID
  );
}

function getRolesPDA(mint: web3.PublicKey): [web3.PublicKey, number] {
  return web3.PublicKey.findProgramAddressSync(
    [Buffer.from("roles"), mint.toBuffer()], SSS_TOKEN_PROGRAM_ID
  );
}

function getBlacklistPDA(mint: web3.PublicKey, addr: web3.PublicKey): [web3.PublicKey, number] {
  return web3.PublicKey.findProgramAddressSync(
    [Buffer.from("blacklist"), mint.toBuffer(), addr.toBuffer()], SSS_TOKEN_PROGRAM_ID
  );
}

interface StablecoinInfo {
  mint: string;
  name: string;
  symbol: string;
  decimals: number;
  paused: boolean;
  preset: string;
  supply: number;
}

export default function Home() {
  const { connection } = useConnection();
  const wallet = useWallet();
  const anchorWallet = useAnchorWallet();
  const [mounted, setMounted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [statusMsg, setStatusMsg] = useState("");
  const [txLog, setTxLog] = useState<string[]>([]);

  // Init form
  const [name, setName] = useState("MyUSD");
  const [symbol, setSymbol] = useState("MUSD");
  const [decimals, setDecimals] = useState("6");
  const [preset, setPreset] = useState<"sss1" | "sss2">("sss1");
  const [mintKeypair] = useState(() => web3.Keypair.generate());

  // Operations
  const [mintAddr, setMintAddr] = useState("");
  const [stablecoin, setStablecoin] = useState<StablecoinInfo | null>(null);
  const [recipientAddr, setRecipientAddr] = useState("");
  const [mintAmount, setMintAmount] = useState("");
  const [burnAmount, setBurnAmount] = useState("");
  const [freezeAddr, setFreezeAddr] = useState("");
  const [blacklistAddr, setBlacklistAddr] = useState("");
  const [blacklistReason, setBlacklistReason] = useState("");
  const [seizeAddr, setSeizeAddr] = useState("");
  const [seizeAmount, setSeizeAmount] = useState("");
  const [balance, setBalance] = useState<number | null>(null);

  useEffect(() => { setMounted(true); }, []);

  const log = (msg: string) => setStatusMsg(msg);
  const addTx = (sig: string) => setTxLog(p => [sig, ...p].slice(0, 5));

  const fetchBalance = useCallback(async () => {
    if (!anchorWallet) return;
    const b = await connection.getBalance(anchorWallet.publicKey);
    setBalance(b / web3.LAMPORTS_PER_SOL);
  }, [connection, anchorWallet]);

  const fetchStablecoin = useCallback(async () => {
    if (!anchorWallet || !mintAddr) return;
    try {
      const mint = new web3.PublicKey(mintAddr);
      const prog = getProgram(connection, anchorWallet);
      const [sdPDA] = getStablecoinPDA(mint);
      const data = await (prog.account as any).stablecoin.fetch(sdPDA);
      const mintInfo = await connection.getTokenSupply(mint);
      setStablecoin({
        mint: mintAddr,
        name: data.name,
        symbol: data.symbol,
        decimals: data.decimals,
        paused: data.paused,
        preset: data.enableTransferHook ? "SSS-2" : "SSS-1",
        supply: mintInfo.value.uiAmount ?? 0,
      });
      log("Loaded ✓");
    } catch (e: any) { log(`Error: ${e.message}`); }
  }, [connection, anchorWallet, mintAddr]);

  useEffect(() => { fetchBalance(); }, [fetchBalance]);

  async function initStablecoin() {
    if (!anchorWallet) return;
    setLoading(true);
    try {
      const prog = getProgram(connection, anchorWallet);
      const mint = mintKeypair;
      const [sdPDA] = getStablecoinPDA(mint.publicKey);
      const [rolesPDA] = getRolesPDA(mint.publicKey);
      const config = {
        name, symbol, uri: "", decimals: parseInt(decimals),
        enablePermanentDelegate: preset === "sss2",
        enableTransferHook: preset === "sss2",
        defaultAccountFrozen: false,
      };
      const tx = await (prog.methods as any).initialize(config)
        .accounts({
          stablecoin: sdPDA, mint: mint.publicKey,
          authority: anchorWallet.publicKey, roles: rolesPDA,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          systemProgram: web3.SystemProgram.programId,
          rent: web3.SYSVAR_RENT_PUBKEY,
        })
        .signers([mint])
        .rpc();
      addTx(tx);
      setMintAddr(mint.publicKey.toBase58());
      log(`${preset.toUpperCase()} stablecoin initialized ✓ Mint: ${mint.publicKey.toBase58()}`);
      await fetchBalance();
    } catch (e: any) { log(`Error: ${e.message}`); }
    setLoading(false);
  }

  async function mintTokens() {
    if (!anchorWallet || !mintAddr) return;
    setLoading(true);
    try {
      const prog = getProgram(connection, anchorWallet);
      const mint = new web3.PublicKey(mintAddr);
      const recipient = new web3.PublicKey(recipientAddr || anchorWallet.publicKey.toBase58());
      const [sdPDA] = getStablecoinPDA(mint);
      const [rolesPDA] = getRolesPDA(mint);
      const recipientATA = getAssociatedTokenAddressSync(mint, recipient, false, TOKEN_2022_PROGRAM_ID);
      const minterPDA = web3.PublicKey.findProgramAddressSync(
        [Buffer.from("minter"), mint.toBuffer(), anchorWallet.publicKey.toBuffer()], SSS_TOKEN_PROGRAM_ID
      )[0];
      const amount = new BN(parseFloat(mintAmount) * Math.pow(10, stablecoin?.decimals ?? 6));
      const tx = await (prog.methods as any).mint(amount)
        .accounts({
          stablecoin: sdPDA, mint, recipient: recipientATA,
          minterState: minterPDA, minter: anchorWallet.publicKey,
          roles: rolesPDA, token2022Program: TOKEN_2022_PROGRAM_ID,
          systemProgram: web3.SystemProgram.programId,
        })
        .rpc();
      addTx(tx);
      log(`Minted ${mintAmount} ${stablecoin?.symbol ?? "tokens"} ✓`);
      await fetchStablecoin();
    } catch (e: any) { log(`Error: ${e.message}`); }
    setLoading(false);
  }

  async function pauseUnpause(pause: boolean) {
    if (!anchorWallet || !mintAddr || !stablecoin) return;
    setLoading(true);
    try {
      const prog = getProgram(connection, anchorWallet);
      const mint = new web3.PublicKey(mintAddr);
      const [sdPDA] = getStablecoinPDA(mint);
      const [rolesPDA] = getRolesPDA(mint);
      const method = pause ? (prog.methods as any).pause() : (prog.methods as any).unpause();
      const tx = await method.accounts({
        stablecoin: sdPDA, pauser: anchorWallet.publicKey, roles: rolesPDA,
      }).rpc();
      addTx(tx);
      log(`${pause ? "Paused" : "Unpaused"} ✓`);
      await fetchStablecoin();
    } catch (e: any) { log(`Error: ${e.message}`); }
    setLoading(false);
  }

  async function doBlacklist(add: boolean) {
    if (!anchorWallet || !mintAddr || !blacklistAddr) return;
    setLoading(true);
    try {
      const prog = getProgram(connection, anchorWallet);
      const mint = new web3.PublicKey(mintAddr);
      const target = new web3.PublicKey(blacklistAddr);
      const [sdPDA] = getStablecoinPDA(mint);
      const [rolesPDA] = getRolesPDA(mint);
      const [blPDA] = getBlacklistPDA(mint, target);
      let tx: string;
      if (add) {
        tx = await (prog.methods as any).addToBlacklist(target, blacklistReason || "No reason given")
          .accounts({ stablecoin: sdPDA, blacklistEntry: blPDA, blacklister: anchorWallet.publicKey,
            roles: rolesPDA, systemProgram: web3.SystemProgram.programId }).rpc();
      } else {
        tx = await (prog.methods as any).removeFromBlacklist(target)
          .accounts({ stablecoin: sdPDA, blacklistEntry: blPDA, blacklister: anchorWallet.publicKey,
            roles: rolesPDA, owner: anchorWallet.publicKey }).rpc();
      }
      addTx(tx);
      log(`${add ? "Blacklisted" : "Removed from blacklist"}: ${shortKey(blacklistAddr)} ✓`);
      setBlacklistAddr(""); setBlacklistReason("");
    } catch (e: any) { log(`Error: ${e.message}`); }
    setLoading(false);
  }

  if (!mounted) return null;

  return (
    <main className="max-w-5xl mx-auto px-4 py-8 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Solana Stablecoin Standard</h1>
          <div className="flex items-center gap-2 mt-1">
            <span className="text-xs bg-purple-800 text-purple-200 px-2 py-0.5 rounded">Devnet</span>
            <span className="text-xs bg-gray-800 text-gray-400 px-2 py-0.5 rounded">SSS-1 · SSS-2</span>
            {balance !== null && <span className="text-xs text-gray-500">{balance.toFixed(3)} SOL</span>}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <a href="https://github.com/tomaszstefaniak/solana-stablecoin-standard" target="_blank" className="text-gray-500 hover:text-white text-sm">GitHub ↗</a>
          {mounted && <WalletMultiButton style={{}} />}
        </div>
      </div>

      {!wallet.connected && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-8 text-center text-gray-500">
          Connect Phantom or Solflare wallet to interact with the stablecoin programs.
        </div>
      )}

      {wallet.connected && (
        <>
          {statusMsg && (
            <div className="bg-gray-900 border border-gray-700 rounded-lg px-4 py-2 text-sm text-gray-300">
              {statusMsg}
            </div>
          )}

          {/* Initialize */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-4">
            <h2 className="font-semibold text-gray-200">Initialize Stablecoin</h2>
            <div className="flex gap-2">
              {(["sss1", "sss2"] as const).map(p => (
                <button key={p} onClick={() => setPreset(p)}
                  className={`px-4 py-1.5 rounded text-sm font-medium ${preset === p ? "bg-purple-600 text-white" : "bg-gray-800 text-gray-400 hover:bg-gray-700"}`}>
                  {p === "sss1" ? "SSS-1 Minimal" : "SSS-2 Compliant"}
                </button>
              ))}
            </div>
            <div className="text-xs text-gray-500">
              {preset === "sss1" ? "Mint authority + freeze + metadata. Simple, auditable." : "SSS-1 + permanent delegate + transfer hook + blacklist enforcement. Regulatory-grade."}
            </div>
            <div className="flex gap-2 flex-wrap">
              <input value={name} onChange={e => setName(e.target.value)} placeholder="Name" className="bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-white w-32" />
              <input value={symbol} onChange={e => setSymbol(e.target.value)} placeholder="Symbol" className="bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-white w-24" />
              <input value={decimals} onChange={e => setDecimals(e.target.value)} placeholder="Decimals" className="bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-white w-20" />
              <button onClick={initStablecoin} disabled={loading}
                className="bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white text-sm px-4 py-1.5 rounded">
                Initialize
              </button>
            </div>
            {mintAddr && <p className="text-xs text-gray-500 font-mono">Mint: {mintAddr}</p>}
          </div>

          {/* Load existing */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-3">
            <h2 className="font-semibold text-gray-200">Load Stablecoin</h2>
            <div className="flex gap-2">
              <input value={mintAddr} onChange={e => setMintAddr(e.target.value)} placeholder="Mint address" className="bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-white flex-1 font-mono text-xs" />
              <button onClick={fetchStablecoin} disabled={loading || !mintAddr}
                className="bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-white text-sm px-4 py-1.5 rounded">
                Load
              </button>
            </div>
            {stablecoin && (
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div className="text-gray-500">Name</div><div className="text-gray-300">{stablecoin.name} ({stablecoin.symbol})</div>
                <div className="text-gray-500">Preset</div><div className="text-gray-300">{stablecoin.preset}</div>
                <div className="text-gray-500">Supply</div><div className="text-gray-300">{stablecoin.supply.toLocaleString()} {stablecoin.symbol}</div>
                <div className="text-gray-500">Status</div>
                <div className={stablecoin.paused ? "text-red-400" : "text-green-400"}>
                  {stablecoin.paused ? "⏸ Paused" : "▶ Active"}
                </div>
              </div>
            )}
          </div>

          {stablecoin && (
            <>
              {/* Mint */}
              <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-3">
                <h2 className="font-semibold text-gray-200">Mint Tokens</h2>
                <div className="flex gap-2 flex-wrap">
                  <input value={recipientAddr} onChange={e => setRecipientAddr(e.target.value)} placeholder="Recipient (empty = self)" className="bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-white flex-1 min-w-40 font-mono text-xs" />
                  <input value={mintAmount} onChange={e => setMintAmount(e.target.value)} placeholder="Amount" className="bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-white w-32" />
                  <button onClick={mintTokens} disabled={loading || !mintAmount}
                    className="bg-green-600 hover:bg-green-500 disabled:opacity-50 text-white text-sm px-4 py-1.5 rounded">
                    Mint
                  </button>
                </div>
              </div>

              {/* Pause / Unpause */}
              <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-3">
                <h2 className="font-semibold text-gray-200">Emergency Controls</h2>
                <div className="flex gap-2">
                  <button onClick={() => pauseUnpause(true)} disabled={loading || stablecoin.paused}
                    className="bg-orange-600 hover:bg-orange-500 disabled:opacity-40 text-white text-sm px-4 py-1.5 rounded">
                    Pause
                  </button>
                  <button onClick={() => pauseUnpause(false)} disabled={loading || !stablecoin.paused}
                    className="bg-green-700 hover:bg-green-600 disabled:opacity-40 text-white text-sm px-4 py-1.5 rounded">
                    Unpause
                  </button>
                  <button onClick={fetchStablecoin} className="text-xs text-gray-500 hover:text-gray-300 ml-2">↻ Refresh</button>
                </div>
              </div>

              {/* SSS-2: Blacklist */}
              {stablecoin.preset === "SSS-2" && (
                <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-3">
                  <h2 className="font-semibold text-gray-200">Compliance — Blacklist <span className="text-xs text-purple-400 ml-1">SSS-2</span></h2>
                  <div className="flex gap-2 flex-wrap">
                    <input value={blacklistAddr} onChange={e => setBlacklistAddr(e.target.value)} placeholder="Address" className="bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-white flex-1 min-w-40 font-mono text-xs" />
                    <input value={blacklistReason} onChange={e => setBlacklistReason(e.target.value)} placeholder="Reason (e.g. OFAC match)" className="bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-white flex-1 min-w-40" />
                  </div>
                  <div className="flex gap-2">
                    <button onClick={() => doBlacklist(true)} disabled={loading || !blacklistAddr}
                      className="bg-red-700 hover:bg-red-600 disabled:opacity-50 text-white text-sm px-4 py-1.5 rounded">
                      Add to Blacklist
                    </button>
                    <button onClick={() => doBlacklist(false)} disabled={loading || !blacklistAddr}
                      className="bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-white text-sm px-4 py-1.5 rounded">
                      Remove
                    </button>
                  </div>
                </div>
              )}

              {/* SSS-2: Seize */}
              {stablecoin.preset === "SSS-2" && (
                <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-3">
                  <h2 className="font-semibold text-gray-200">Seize Funds <span className="text-xs text-red-400 ml-1">SSS-2</span></h2>
                  <div className="flex gap-2 flex-wrap">
                    <input value={seizeAddr} onChange={e => setSeizeAddr(e.target.value)} placeholder="Source account (frozen)" className="bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-white flex-1 font-mono text-xs" />
                    <input value={seizeAmount} onChange={e => setSeizeAmount(e.target.value)} placeholder="Amount" className="bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-white w-32" />
                    <button disabled={loading || !seizeAddr || !seizeAmount}
                      className="bg-red-900 hover:bg-red-800 disabled:opacity-50 text-white text-sm px-4 py-1.5 rounded">
                      Seize
                    </button>
                  </div>
                </div>
              )}
            </>
          )}

          {/* TX log */}
          {txLog.length > 0 && (
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-2">
              <h2 className="text-sm font-semibold text-gray-200">Recent Transactions</h2>
              {txLog.map(sig => (
                <a key={sig} href={`https://explorer.solana.com/tx/${sig}?cluster=devnet`} target="_blank"
                  className="block font-mono text-xs text-purple-400 hover:text-purple-300 truncate">
                  {sig}
                </a>
              ))}
            </div>
          )}
        </>
      )}
    </main>
  );
}
