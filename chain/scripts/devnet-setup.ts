// One-time Devnet setup for the deployed prospecto program (BACKEND_STACK §13 step 6). Idempotent:
// re-running skips finished steps. Writes public addresses only to chain/devnet.json.
//
//   admin   = ~/.config/solana/id.json (the program's upgrade authority; pays for setup)
//   relayer = chain/.keys/relayer.json (fee payer, eligibility co-signer, mock USDC mint authority)
//
// DEMO: mock USDC is a Devnet-only Token-2022 mint whose authority is the relayer
// (NESSIE_PURCHASE_FLOW §6 step D). It has no value and no redemption.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AccountRole,
  address,
  createClient,
  fetchEncodedAccount,
  generateKeyPairSigner,
  getAddressEncoder,
  getI64Encoder,
  getProgramDerivedAddress,
  getU16Encoder,
  getU64Encoder,
  lamports,
  type Address,
  type Instruction,
} from "@solana/kit";
import { solanaRpc } from "@solana/kit-plugin-rpc";
import { signerFromFile } from "@solana/kit-plugin-signer";
import { getCreateAccountInstruction, getTransferSolInstruction, SYSTEM_PROGRAM_ADDRESS } from "@solana-program/system";
import { getInitializeMint2Instruction, getMintSize, TOKEN_2022_PROGRAM_ADDRESS } from "@solana-program/token-2022";

const CHAIN_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_FILE = join(CHAIN_DIR, "devnet.json");
const RELAYER_FILE = join(CHAIN_DIR, ".keys", "relayer.json");
const ADMIN_FILE = process.env.ANCHOR_WALLET ?? join(homedir(), ".config", "solana", "id.json");
const RPC_URL = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const PROGRAM_ID = address("DnofuRV6ipCbSsuH4nJx8AABfqziwfuihckoMLDNRJdY");
const BPF_UPGRADEABLE_LOADER = address("BPFLoaderUpgradeab1e11111111111111111111111");

// Must mirror backend/src/rounds/policy.ts (round-policy-v0.1).
const POLICY = {
  protocolFeeBps: 100,
  founderShareBps: 4000,
  maxUnitsPerRound: 200_000n,
  minRoundSeconds: 86_400n,
  maxRoundSeconds: 30n * 86_400n,
};
const RELAYER_MIN_LAMPORTS = 500_000_000n;
const RELAYER_TOP_UP = lamports(1_000_000_000n);

if (!RPC_URL.includes("devnet")) throw new Error(`Refusing to run against a non-Devnet RPC: ${RPC_URL}`);
for (const [name, file] of [["admin", ADMIN_FILE], ["relayer", RELAYER_FILE]]) {
  if (!existsSync(file)) {
    throw new Error(`Missing ${name} keypair at ${file}. Create it with: solana-keygen new -o ${file}`);
  }
}

const client = await createClient().use(signerFromFile(ADMIN_FILE)).use(solanaRpc({ rpcUrl: RPC_URL }));
const relayer = (await createClient().use(signerFromFile(RELAYER_FILE))).payer;
const admin = client.payer;
const state: Record<string, string> = existsSync(OUT_FILE) ? JSON.parse(readFileSync(OUT_FILE, "utf8")) : {};
const save = () => writeFileSync(OUT_FILE, `${JSON.stringify(state, null, 2)}\n`);

const enc = getAddressEncoder();
const pda = async (seeds: (string | Uint8Array)[], program: Address = PROGRAM_ID) =>
  (await getProgramDerivedAddress({ programAddress: program, seeds })) [0];

const program = await fetchEncodedAccount(client.rpc, PROGRAM_ID);
if (!program.exists || !program.executable) throw new Error(`Program ${PROGRAM_ID} is not deployed on ${RPC_URL}.`);
console.log(`admin   ${admin.address}`);
console.log(`relayer ${relayer.address}`);

// 1. The relayer pays fees and rent for every user-facing transaction.
const { value: relayerBalance } = await client.rpc.getBalance(relayer.address).send();
if (relayerBalance < RELAYER_MIN_LAMPORTS) {
  await client.sendTransaction([
    getTransferSolInstruction({ source: admin, destination: relayer.address, amount: RELAYER_TOP_UP }),
  ]);
  console.log("funded relayer with 1 SOL");
}

// 2. Mock USDC: Token-2022, 6 decimals (1 base unit = 1 micro-USD), relayer as mint authority.
if (!state.paymentMint) {
  const mint = await generateKeyPairSigner();
  const space = getMintSize();
  const rent = await client.rpc.getMinimumBalanceForRentExemption(BigInt(space)).send();
  await client.sendTransaction([
    getCreateAccountInstruction({
      payer: admin,
      newAccount: mint,
      lamports: rent,
      space,
      programAddress: TOKEN_2022_PROGRAM_ADDRESS,
    }),
    getInitializeMint2Instruction({ mint: mint.address, decimals: 6, mintAuthority: relayer.address }),
  ]);
  state.paymentMint = mint.address;
  save();
  console.log(`created mock USDC mint ${mint.address}`);
}
const paymentMint = address(state.paymentMint);

// 3. initialize_protocol (admin must be the program's upgrade authority).
const config = await pda(["config"]);
const protocolFeeVault = await pda(["protocol_fee_vault"]);
if (!(await fetchEncodedAccount(client.rpc, config)).exists) {
  const discriminator = createHash("sha256").update("global:initialize_protocol").digest().subarray(0, 8);
  const data = new Uint8Array([
    ...discriminator,
    ...enc.encode(relayer.address),
    ...getU16Encoder().encode(POLICY.protocolFeeBps),
    ...getU16Encoder().encode(POLICY.founderShareBps),
    ...getU64Encoder().encode(POLICY.maxUnitsPerRound),
    ...getI64Encoder().encode(POLICY.minRoundSeconds),
    ...getI64Encoder().encode(POLICY.maxRoundSeconds),
  ]);
  const ix: Instruction = {
    programAddress: PROGRAM_ID,
    accounts: [
      { address: admin.address, role: AccountRole.WRITABLE_SIGNER, signer: admin } as never,
      { address: config, role: AccountRole.WRITABLE },
      { address: paymentMint, role: AccountRole.READONLY },
      { address: protocolFeeVault, role: AccountRole.WRITABLE },
      { address: PROGRAM_ID, role: AccountRole.READONLY },
      { address: await pda([enc.encode(PROGRAM_ID)], BPF_UPGRADEABLE_LOADER), role: AccountRole.READONLY },
      { address: TOKEN_2022_PROGRAM_ADDRESS, role: AccountRole.READONLY },
      { address: SYSTEM_PROGRAM_ADDRESS, role: AccountRole.READONLY },
    ],
    data,
  };
  await client.sendTransaction([ix]);
  console.log("initialized protocol config");
}

Object.assign(state, {
  cluster: "devnet",
  programId: PROGRAM_ID,
  relayer: relayer.address,
  admin: admin.address,
  config,
  protocolFeeVault,
});
save();
console.log(`\nwrote ${OUT_FILE}\n`);
console.log(`SOLANA_RPC_URL=${RPC_URL}`);
console.log(`SOLANA_WS_URL=${RPC_URL.replace(/^http/, "ws")}`);
console.log(`PROGRAM_ID=${PROGRAM_ID}`);
console.log(`PAYMENT_MINT=${paymentMint}`);
console.log(`explorer: https://explorer.solana.com/address/${PROGRAM_ID}?cluster=devnet`);
