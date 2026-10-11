// PURE: the prospecto program's wire contract (chain/programs/prospecto; BACKEND_STACK §6). PDA
// seeds, instruction builders in the exact account order of the Rust `Accounts` structs, and event
// decoders. Discriminators are Anchor's: sha256("global:<ix>")[0..8] and sha256("event:<Name>")[0..8].
// Tested against the compiled program in LiteSVM (tests/chain/program.test.ts).
import { createHash } from "node:crypto";

import {
  AccountRole,
  address,
  fixDecoderSize,
  getAddressDecoder,
  getAddressEncoder,
  getBooleanDecoder,
  getBytesDecoder,
  getI64Decoder,
  getI64Encoder,
  getProgramDerivedAddress,
  getStructDecoder,
  getU16Decoder,
  getU16Encoder,
  getU64Decoder,
  getU64Encoder,
  type AccountMeta,
  type AccountSignerMeta,
  type Address,
  type Decoder,
  type Instruction,
  type TransactionSigner,
} from "@solana/kit";

export const TOKEN_2022_PROGRAM = address("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
export const ASSOCIATED_TOKEN_PROGRAM = address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
export const SYSTEM_PROGRAM = address("11111111111111111111111111111111");

const anchorDiscriminator = (namespace: "global" | "event", name: string) =>
  createHash("sha256").update(`${namespace}:${name}`).digest().subarray(0, 8);

const addressEncoder = getAddressEncoder();
const u16 = getU16Encoder();
const u64 = getU64Encoder();
const i64 = getI64Encoder();

/** Hex string of exactly `bytes` bytes, as stored in Tiger (uuid without dashes, sha256 hashes). */
export function hexBytes(hex: string, bytes: number): Uint8Array {
  const clean = hex.replace(/-/g, "").toLowerCase();
  if (!new RegExp(`^[0-9a-f]{${bytes * 2}}$`).test(clean)) throw new Error(`expected ${bytes} hex bytes`);
  return Uint8Array.from(Buffer.from(clean, "hex"));
}

export interface ProgramAddresses {
  programId: Address;
  paymentMint: Address;
}

async function pda(programId: Address, seeds: (string | Uint8Array)[]): Promise<Address> {
  return (await getProgramDerivedAddress({ programAddress: programId, seeds }))[0];
}

/** Token-2022 associated token account of `owner` for `mint`. */
export async function associatedTokenAddress(owner: Address, mint: Address): Promise<Address> {
  return pda(ASSOCIATED_TOKEN_PROGRAM, [addressEncoder.encode(owner), addressEncoder.encode(TOKEN_2022_PROGRAM), addressEncoder.encode(mint)]);
}

/** Every PDA a round touches (BACKEND_STACK §6.1 seeds). */
export async function roundAccounts(programId: Address, projectUuid: string, roundNumber: number) {
  const project = await pda(programId, ["project", hexBytes(projectUuid, 16)]);
  const p = addressEncoder.encode(project);
  const round = await pda(programId, ["round", p, u16.encode(roundNumber)]);
  return {
    config: await pda(programId, ["config"]),
    protocolFeeVault: await pda(programId, ["protocol_fee_vault"]),
    project,
    receiptMint: await pda(programId, ["receipt_mint", p]),
    projectVault: await pda(programId, ["project_vault", p]),
    founderRewardVault: await pda(programId, ["founder_reward_vault", p]),
    round,
    roundVault: await pda(programId, ["round_vault", addressEncoder.encode(round)]),
  };
}

export const subscriptionAddress = async (programId: Address, round: Address, buyer: Address) =>
  pda(programId, ["subscription", addressEncoder.encode(round), addressEncoder.encode(buyer)]);

type Meta = AccountMeta | AccountSignerMeta;
const w = (a: Address): Meta => ({ address: a, role: AccountRole.WRITABLE });
const r = (a: Address): Meta => ({ address: a, role: AccountRole.READONLY });
/** A signer whose key the server holds (the relayer); Kit signs with it. */
const ws = (signer: TransactionSigner): Meta => ({ address: signer.address, role: AccountRole.WRITABLE_SIGNER, signer });
/** A signer the user's wallet supplies later; the server only leaves a slot for it. */
const userSigner = (a: Address): Meta => ({ address: a, role: AccountRole.READONLY_SIGNER });

const ix = (programId: Address, name: string, accounts: Meta[], args: Uint8Array = new Uint8Array()): Instruction => ({
  programAddress: programId,
  accounts,
  data: new Uint8Array([...anchorDiscriminator("global", name), ...args]),
});

export async function createProjectInstruction(p: ProgramAddresses, relayer: TransactionSigner, founder: Address, projectUuid: string) {
  const a = await roundAccounts(p.programId, projectUuid, 1);
  return ix(
    p.programId,
    "create_project",
    [ws(relayer), userSigner(founder), r(a.config), w(a.project), w(a.receiptMint), w(a.projectVault), w(a.founderRewardVault), r(p.paymentMint), r(TOKEN_2022_PROGRAM), r(SYSTEM_PROGRAM)],
    hexBytes(projectUuid, 16),
  );
}

/** Args exactly as rounds/service.ts `chainInstructions` emits them (decimal strings, hex hashes). */
export interface OpenRoundArgs {
  round_number: string;
  opens_at: string;
  closes_at: string;
  unit_price_micro_usd: string;
  max_units: string;
  target_amount: string;
  max_subscription_amount: string;
  model_hash: string;
  evidence_root: string;
}

export async function openRoundInstruction(p: ProgramAddresses, relayer: TransactionSigner, founder: Address, projectUuid: string, args: OpenRoundArgs) {
  const roundNumber = Number(args.round_number);
  const a = await roundAccounts(p.programId, projectUuid, roundNumber);
  const data = new Uint8Array([
    ...u16.encode(roundNumber),
    ...i64.encode(BigInt(args.opens_at)),
    ...i64.encode(BigInt(args.closes_at)),
    ...u64.encode(BigInt(args.unit_price_micro_usd)),
    ...u64.encode(BigInt(args.max_units)),
    ...u64.encode(BigInt(args.target_amount)),
    ...u64.encode(BigInt(args.max_subscription_amount)),
    ...hexBytes(args.model_hash, 32),
    ...hexBytes(args.evidence_root, 32),
  ]);
  return ix(
    p.programId,
    "open_round",
    [ws(relayer), userSigner(founder), r(a.config), r(a.project), w(a.round), w(a.roundVault), r(p.paymentMint), r(TOKEN_2022_PROGRAM), r(SYSTEM_PROGRAM)],
    data,
  );
}

export async function subscribeInstruction(
  p: ProgramAddresses,
  relayer: TransactionSigner,
  buyer: Address,
  projectUuid: string,
  roundNumber: number,
  grossMicroUsd: bigint,
) {
  const a = await roundAccounts(p.programId, projectUuid, roundNumber);
  return ix(
    p.programId,
    "subscribe",
    [
      ws(relayer),
      userSigner(buyer),
      r(a.config),
      r(a.project),
      w(a.round),
      w(await subscriptionAddress(p.programId, a.round, buyer)),
      w(await associatedTokenAddress(buyer, p.paymentMint)),
      w(a.roundVault),
      r(p.paymentMint),
      r(TOKEN_2022_PROGRAM),
      r(SYSTEM_PROGRAM),
    ],
    u64.encode(grossMicroUsd) as Uint8Array,
  );
}

// Events -------------------------------------------------------------------------------------

const pubkey = getAddressDecoder();
const hash32 = fixDecoderSize(getBytesDecoder(), 32);
const id16 = fixDecoderSize(getBytesDecoder(), 16);
const u64d = getU64Decoder();
const i64d = getI64Decoder();

const EVENT_DECODERS: Record<string, Decoder<object>> = {
  ProjectCreated: getStructDecoder([
    ["project", pubkey],
    ["projectId", id16],
    ["founderWallet", pubkey],
    ["receiptMint", pubkey],
    ["projectVault", pubkey],
    ["founderRewardVault", pubkey],
  ]),
  RoundOpened: getStructDecoder([
    ["round", pubkey],
    ["project", pubkey],
    ["receiptMint", pubkey],
    ["roundNumber", getU16Decoder()],
    ["opensAt", i64d],
    ["closesAt", i64d],
    ["unitPriceMicroUsd", u64d],
    ["maxUnits", u64d],
    ["targetAmount", u64d],
    ["maxSubscriptionAmount", u64d],
    ["modelHash", hash32],
    ["evidenceRoot", hash32],
  ]),
  SubscriptionAccepted: getStructDecoder([
    ["round", pubkey],
    ["subscription", pubkey],
    ["buyer", pubkey],
    ["grossAmount", u64d],
    ["totalCommitted", u64d],
  ]),
  RoundFinalized: getStructDecoder([
    ["round", pubkey],
    ["totalCommitted", u64d],
    ["filled", getBooleanDecoder()],
    ["expired", getBooleanDecoder()],
  ]),
  AllocationMinted: getStructDecoder([
    ["round", pubkey],
    ["subscription", pubkey],
    ["buyer", pubkey],
    ["acceptedAmount", u64d],
    ["fee", u64d],
    ["founderReward", u64d],
    ["projectProceeds", u64d],
    ["units", u64d],
  ]),
  ExcessRefunded: getStructDecoder([["round", pubkey], ["subscription", pubkey], ["buyer", pubkey], ["amount", u64d]]),
  RoundCancelled: getStructDecoder([["round", pubkey], ["cancelledBy", pubkey]]),
  MockWalletFunded: getStructDecoder([["intentId", id16], ["wallet", pubkey], ["amount", u64d], ["bankProofHash", hash32]]),
  ProceedsWithdrawn: getStructDecoder([["project", pubkey], ["amount", u64d]]),
  FounderRewardsWithdrawn: getStructDecoder([["project", pubkey], ["amount", u64d]]),
};
const BY_DISCRIMINATOR = new Map(
  Object.keys(EVENT_DECODERS).map((name) => [Buffer.from(anchorDiscriminator("event", name)).toString("hex"), name]),
);

export interface ProgramEvent {
  name: string;
  /** Position among this program's events in the transaction; part of the chain_events key. */
  index: number;
  /** JSON-safe: bigints become decimal strings, byte arrays become lowercase hex. */
  data: Record<string, string | number | boolean>;
}

const jsonSafe = (value: unknown): string | number | boolean =>
  typeof value === "bigint" ? value.toString() : value instanceof Uint8Array ? Buffer.from(value).toString("hex") : (value as string | number | boolean);

/**
 * Anchor `emit!` writes "Program data: <base64>" while our program is the innermost invocation.
 * Only lines logged inside `programId`'s own frames are decoded, so a CPI'd program cannot spoof
 * an event; unknown discriminators are skipped.
 */
export function parseProgramEvents(logs: readonly string[], programId: Address): ProgramEvent[] {
  const stack: string[] = [];
  const events: ProgramEvent[] = [];
  for (const line of logs) {
    const invoke = /^Program (\w+) invoke \[\d+\]$/.exec(line);
    if (invoke) {
      stack.push(invoke[1]);
      continue;
    }
    if (/^Program \w+ (success|failed)/.test(line)) {
      stack.pop();
      continue;
    }
    if (stack.at(-1) !== programId || !line.startsWith("Program data: ")) continue;
    const bytes = Buffer.from(line.slice("Program data: ".length), "base64");
    const name = BY_DISCRIMINATOR.get(bytes.subarray(0, 8).toString("hex"));
    if (!name) continue;
    const decoded = EVENT_DECODERS[name].decode(bytes.subarray(8)) as Record<string, unknown>;
    events.push({ name, index: events.length, data: Object.fromEntries(Object.entries(decoded).map(([k, v]) => [k, jsonSafe(v)])) });
  }
  return events;
}
