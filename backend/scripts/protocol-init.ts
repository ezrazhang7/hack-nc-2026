// One-time Devnet protocol setup (PURCHASE_SETUP.md step 4): initialize_protocol signed by the program's
// upgrade authority (admin) and the relayer. Idempotent: exits if Config already exists. Simulates first.
//   npx tsx scripts/protocol-init.ts <admin-keypair.json> <relayer-keypair.json> <payment-mint>
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

import { BorshInstructionCoder, type Idl } from "@coral-xyz/anchor";
import { TOKEN_2022_PROGRAM_ID, getMint } from "@solana/spl-token";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";

const [adminPath, relayerPath, mintArg] = process.argv.slice(2);
if (!adminPath || !relayerPath || !mintArg) throw new Error("usage: protocol-init.ts <admin-keypair.json> <relayer-keypair.json> <payment-mint>");
const rpc = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
if (!rpc.includes("devnet")) throw new Error(`Refusing to run against a non-Devnet RPC: ${rpc}`);

const load = (path: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path.replace(/^~/, homedir()), "utf8"))));
const admin = load(adminPath);
const relayer = load(relayerPath);
const paymentMint = new PublicKey(mintArg);
const idl = JSON.parse(readFileSync(new URL("../idl/prospecto.json", import.meta.url), "utf8")) as Idl;
const programId = new PublicKey(idl.address);
const connection = new Connection(rpc, "confirmed");
const pda = (seed: string, program = programId) => PublicKey.findProgramAddressSync([Buffer.from(seed)], program)[0];

const config = pda("config");
const programData = PublicKey.findProgramAddressSync([programId.toBuffer()], new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"))[0];
console.log(`program ${programId.toBase58()}\nadmin   ${admin.publicKey.toBase58()}\nrelayer ${relayer.publicKey.toBase58()}\nmint    ${paymentMint.toBase58()}`);

if (await connection.getAccountInfo(config)) {
  console.log(`config ${config.toBase58()} already exists; nothing to do.`);
  process.exit(0);
}
const mint = await getMint(connection, paymentMint, "confirmed", TOKEN_2022_PROGRAM_ID);
if (mint.decimals !== 6 || mint.freezeAuthority || !mint.mintAuthority?.equals(relayer.publicKey) || mint.tlvData.length > 0) {
  throw new Error("Payment mint must be Token-2022, 6 decimals, no extensions or freeze authority, with the relayer as mint authority.");
}

const keys = [
  { pubkey: config, isSigner: false, isWritable: true },
  { pubkey: admin.publicKey, isSigner: true, isWritable: true },
  { pubkey: relayer.publicKey, isSigner: true, isWritable: false },
  { pubkey: programId, isSigner: false, isWritable: false },
  { pubkey: programData, isSigner: false, isWritable: false },
  { pubkey: paymentMint, isSigner: false, isWritable: false },
  { pubkey: pda("protocol_fee_vault"), isSigner: false, isWritable: true },
  { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
  { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
];
// Account order checked against the IDL so a reordered program fails here, not on-chain.
const expected = (idl.instructions.find((i) => i.name === "initialize_protocol")?.accounts ?? []).map((a) => a.name);
const names = ["config", "admin", "relayer", "program", "program_data", "payment_mint", "protocol_fee_vault", "token_program", "system_program"];
if (JSON.stringify(expected) !== JSON.stringify(names)) throw new Error(`IDL account order changed: ${expected.join(", ")}`);

const data = new BorshInstructionCoder(idl).encode("initialize_protocol", {});
const tx = new Transaction().add(new TransactionInstruction({ programId, keys, data }));
tx.feePayer = admin.publicKey;
tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
tx.sign(admin, relayer);

const sim = await connection.simulateTransaction(tx);
if (sim.value.err) throw new Error(`Simulation failed: ${JSON.stringify(sim.value.err)}\n${sim.value.logs?.join("\n")}`);
const signature = await connection.sendRawTransaction(tx.serialize());
await connection.confirmTransaction(signature, "confirmed");
console.log(`initialized config ${config.toBase58()}\nsignature ${signature}`);
