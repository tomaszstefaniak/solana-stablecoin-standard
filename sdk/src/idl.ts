import { PublicKey } from "@solana/web3.js";
import SSS_TOKEN_IDL_JSON from "../idl/sss_token.json";

/** SSS-Token program ID — update after devnet deploy */
export const SSS_TOKEN_PROGRAM_ID = new PublicKey(
  SSS_TOKEN_IDL_JSON.address
);

/** Transfer-Hook program ID — update after devnet deploy */
export const TRANSFER_HOOK_PROGRAM_ID = new PublicKey(
  "9chamxxgkipFSo3VV53sNnLFRk14oJTrKFzRaHRgowfN"
);

/** Full IDL for sss-token program */
export const SSS_TOKEN_IDL = SSS_TOKEN_IDL_JSON as any;
