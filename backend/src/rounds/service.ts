// Round drafting and the chain boundary (M§7.2–7.3). The backend freezes a valuation snapshot and
// derives the terms; the program's open_round stores them on-chain, and the indexer confirms that
// the on-chain terms equal the Tiger row (recordRoundOpened) before the round becomes visible.
import type { Pool, PoolClient } from "pg";

import { SettlementError, quote, validateTerms, type RoundTerms } from "../settlement/math.js";
import type { ValuationPreview } from "../valuation/service.js";
import { ROUND_POLICY } from "./policy.js";

export class RoundError extends Error {
  constructor(
    readonly code: string,
    readonly httpStatus: 400 | 403 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

export interface DraftRequest {
  max_units?: string;
  duration_days?: number;
  opens_at?: string;
  max_subscription_micro_usd?: string;
}

export interface RoundRow {
  id: string;
  project_id: string;
  round_number: number;
  status: string;
  opens_at: Date;
  closes_at: Date;
  unit_price_micro_usd: string;
  max_units: string;
  target_amount_micro_usd: string;
  max_subscription_micro_usd: string;
  protocol_fee_bps: number;
  founder_fee_share_bps: number;
  model_version_id: string;
  valuation_snapshot_id: string;
  model_hash: string;
  evidence_root: string;
  total_committed_micro_usd: string;
  solana_round_pda: string | null;
}

const ROUND_COLUMNS = `id, project_id, round_number, status::text as status, opens_at, closes_at,
  unit_price_micro_usd::text as unit_price_micro_usd, max_units::text as max_units,
  target_amount_micro_usd::text as target_amount_micro_usd, max_subscription_micro_usd::text as max_subscription_micro_usd,
  protocol_fee_bps, founder_fee_share_bps, model_version_id, valuation_snapshot_id, model_hash, evidence_root,
  total_committed_micro_usd::text as total_committed_micro_usd, solana_round_pda`;

export const termsOf = (round: RoundRow): RoundTerms => ({
  unitPriceMicroUsd: BigInt(round.unit_price_micro_usd),
  maxUnits: BigInt(round.max_units),
  targetMicroUsd: BigInt(round.target_amount_micro_usd),
  protocolFeeBps: BigInt(round.protocol_fee_bps),
  founderFeeShareBps: BigInt(round.founder_fee_share_bps),
});

const unixSeconds = (date: Date) => String(Math.floor(date.getTime() / 1000));
const uuidHex = (uuid: string) => uuid.replace(/-/g, "");
const u16le = (n: number) => Buffer.from([n & 0xff, n >> 8]).toString("hex");

/**
 * What the program must be called with (BACKEND_STACK §6.1–6.2). Integers are decimal strings
 * (u64/i64), hashes are 32-byte hex, PDA seeds are listed so the client can derive addresses once
 * PROGRAM_ID exists. The backend does not sign or submit anything here.
 */
export function chainInstructions(round: RoundRow, project: { id: string; solana_project_pda: string | null }, founderWallet: string, programId: string | null) {
  const instructions: { name: string; signers: string[]; args: Record<string, string> }[] = [];
  if (!project.solana_project_pda) {
    instructions.push({ name: "create_project", signers: ["founder_wallet", "relayer"], args: { project_id: uuidHex(project.id) } });
  }
  instructions.push({
    name: "open_round",
    signers: ["founder_wallet", "relayer"],
    args: {
      round_number: String(round.round_number),
      opens_at: unixSeconds(round.opens_at),
      closes_at: unixSeconds(round.closes_at),
      unit_price_micro_usd: round.unit_price_micro_usd,
      max_units: round.max_units,
      target_amount: round.target_amount_micro_usd,
      max_subscription_amount: round.max_subscription_micro_usd,
      model_hash: round.model_hash,
      evidence_root: round.evidence_root,
    },
  });
  return {
    programId,
    status: programId ? "AWAITING_SIGNATURE" : "AWAITING_PROGRAM",
    founderWallet,
    instructions,
    seeds: {
      project: ["project", `0x${uuidHex(project.id)}`],
      receipt_mint: ["receipt_mint", "<project PDA>"],
      project_vault: ["project_vault", "<project PDA>"],
      founder_reward_vault: ["founder_reward_vault", "<project PDA>"],
      round: ["round", "<project PDA>", `0x${u16le(round.round_number)}`],
      round_vault: ["round_vault", "<round PDA>"],
    },
  };
}

async function inTransaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await work(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function parseUnits(value: string | undefined, fallback: bigint, name: string): bigint {
  if (value === undefined) return fallback;
  if (!/^\d{1,19}$/.test(value)) throw new RoundError("INVALID_INPUT", 400, `${name} must be a whole number.`);
  return BigInt(value);
}

/**
 * M§7.3 steps 1–4: freeze (or reuse) the valuation snapshot, derive terms from it, and write a
 * DRAFT round. Runs inside the caller's transaction (idempotency). Only the founder may open rounds;
 * the open_round signer is the founder's bound wallet.
 */
export async function createRoundDraft(
  client: PoolClient,
  params: {
    projectId: string;
    identityId: string;
    request: DraftRequest;
    /** The frozen snapshot (previewValuation), recorded on its own connection before this transaction. */
    valuation: ValuationPreview;
    allowDraftModel: boolean;
    programId: string | null;
  },
) {
  const project = await client.query<{ id: string; status: string; founder_identity_id: string; founder_wallet: string | null; solana_project_pda: string | null }>(
    `select id, status::text as status, founder_identity_id, founder_wallet, solana_project_pda from projects where id = $1 for update`,
    [params.projectId],
  );
  const p = project.rows[0];
  if (!p) throw new RoundError("NOT_FOUND", 404, "Project not found.");
  if (p.founder_identity_id !== params.identityId) throw new RoundError("FORBIDDEN", 403, "Only the founder can open a round.");
  if (p.status !== "PUBLISHED") throw new RoundError("PROJECT_NOT_PUBLISHED", 409, "Publish the project before opening a round.");
  const open = await client.query(`select 1 from rounds where project_id = $1 and status not in ('FINALIZED', 'CANCELLED')`, [p.id]);
  if (open.rowCount) throw new RoundError("ROUND_EXISTS", 409, "This project already has a draft or active round.");

  let founderWallet = p.founder_wallet;
  if (!founderWallet) {
    const wallet = await client.query<{ address: string }>(
      `select address from wallets where identity_id = $1 and is_primary and revoked_at is null`,
      [params.identityId],
    );
    founderWallet = wallet.rows[0]?.address ?? null;
    if (!founderWallet) throw new RoundError("WALLET_NOT_VERIFIED", 409, "Bind a Solana wallet first (POST /api/wallets/challenge, then /verify).");
    await client.query(`update projects set founder_wallet = $2, updated_at = now() where id = $1`, [p.id, founderWallet]);
  }

  const valuation = params.valuation;
  if (valuation.modelVersion.status !== "ACTIVE" && !params.allowDraftModel) {
    throw new RoundError("MODEL_NOT_ACTIVE", 409, "Rounds need an ACTIVE valuation model; the current one is still a draft.");
  }

  const policy = ROUND_POLICY;
  const price = BigInt(valuation.values.unitPriceMicroUsd);
  const maxUnits = parseUnits(params.request.max_units, policy.defaultMaxUnits, "max_units");
  if (maxUnits < 1n || maxUnits > policy.maxUnitsPerRound) {
    throw new RoundError("INVALID_INPUT", 400, `max_units must be between 1 and ${policy.maxUnitsPerRound}.`);
  }
  const target = maxUnits * price;
  const defaultCap = (target * policy.defaultMaxSubscriptionBps) / 10_000n;
  const maxSubscription = parseUnits(params.request.max_subscription_micro_usd, defaultCap < price ? price : defaultCap, "max_subscription_micro_usd");
  if (maxSubscription < price || maxSubscription > target) {
    throw new RoundError("INVALID_INPUT", 400, "max_subscription_micro_usd must be between one unit's price and the round target.");
  }
  const days = params.request.duration_days ?? policy.defaultDurationDays;
  if (!Number.isInteger(days) || days < policy.minDurationDays || days > policy.maxDurationDays) {
    throw new RoundError("INVALID_INPUT", 400, `duration_days must be ${policy.minDurationDays}–${policy.maxDurationDays}.`);
  }
  const now = Math.floor(Date.now() / 1000) * 1000;
  const opensAt = params.request.opens_at ? Math.floor(Date.parse(params.request.opens_at) / 1000) * 1000 : now;
  if (!Number.isFinite(opensAt) || opensAt < now - 60_000 || opensAt > now + 30 * 86_400_000) {
    throw new RoundError("INVALID_INPUT", 400, "opens_at must be now or within the next 30 days.");
  }
  const closesAt = opensAt + days * 86_400_000;
  try {
    validateTerms({ unitPriceMicroUsd: price, maxUnits, targetMicroUsd: target, protocolFeeBps: policy.protocolFeeBps, founderFeeShareBps: policy.founderFeeShareBps });
  } catch (error) {
    if (error instanceof SettlementError) throw new RoundError("INVALID_INPUT", 400, error.message);
    throw error;
  }

  const next = await client.query<{ n: number }>(`select coalesce(max(round_number), 0) + 1 as n from rounds where project_id = $1`, [p.id]);
  const roundNumber = Number(next.rows[0].n);
  if (roundNumber > policy.maxRoundNumber) throw new RoundError("ROUND_LIMIT", 409, "Round number exceeds the on-chain u16 seed.");

  // Terms are copied from the snapshot row itself, so the rounds_guard_terms trigger always matches.
  const inserted = await client.query<RoundRow>(
    `insert into rounds
       (project_id, round_number, opens_at, closes_at, unit_price_micro_usd, max_units, target_amount_micro_usd,
        max_subscription_micro_usd, protocol_fee_bps, founder_fee_share_bps, model_version_id,
        valuation_snapshot_id, valuation_calculated_at, model_hash, evidence_root)
     select $1, $2, to_timestamp($3::bigint / 1000.0), to_timestamp($4::bigint / 1000.0), v.unit_price_micro_usd, $5, $6, $7, $8, $9,
            v.model_version_id, v.id, v.calculated_at, v.model_hash, v.evidence_root
       from valuation_snapshots v where v.id = $10
     returning ${ROUND_COLUMNS}`,
    [p.id, roundNumber, opensAt, closesAt, String(maxUnits), String(target), String(maxSubscription), Number(policy.protocolFeeBps), Number(policy.founderFeeShareBps), valuation.snapshot.id],
  );
  const round = inserted.rows[0];
  if (round.unit_price_micro_usd !== String(price)) throw new Error("snapshot price changed between preview and round insert");
  return {
    round: publicRound(round),
    valuation: { snapshotId: valuation.snapshot.id, modelVersion: valuation.modelVersion, stage: valuation.stage, values: valuation.values },
    policy: { version: policy.version },
    chain: chainInstructions(round, p, founderWallet, params.programId),
  };
}

const microToUsd = (micro: string) => {
  const padded = micro.padStart(7, "0");
  return `${padded.slice(0, -6)}.${padded.slice(-6)}`;
};

/** Derived lifecycle for display; the stored status only changes on chain-confirmed events. */
export function roundPhase(round: Pick<RoundRow, "status" | "opens_at" | "closes_at">, now = new Date()): string {
  if (round.status === "SCHEDULED" || round.status === "OPEN") {
    if (now < round.opens_at) return "SCHEDULED";
    if (now < round.closes_at) return "OPEN";
    return "AWAITING_SETTLEMENT";
  }
  return round.status;
}

export function publicRound(round: RoundRow) {
  const committed = BigInt(round.total_committed_micro_usd);
  const target = BigInt(round.target_amount_micro_usd);
  return {
    id: round.id,
    roundNumber: round.round_number,
    status: round.status,
    phase: roundPhase(round),
    opensAt: round.opens_at.toISOString(),
    closesAt: round.closes_at.toISOString(),
    unitPriceMicroUsd: round.unit_price_micro_usd,
    unitPrice: microToUsd(round.unit_price_micro_usd),
    maxUnits: round.max_units,
    targetMicroUsd: round.target_amount_micro_usd,
    maxSubscriptionMicroUsd: round.max_subscription_micro_usd,
    protocolFeeBps: round.protocol_fee_bps,
    founderFeeShareBps: round.founder_fee_share_bps,
    totalCommittedMicroUsd: round.total_committed_micro_usd,
    // Basis points of target committed; can exceed 10000 when oversubscribed (pro rata at close).
    committedBps: String((committed * 10_000n) / target),
    // "Why is this the price?": the snapshot, model, and evidence the terms are frozen to.
    valuationSnapshotId: round.valuation_snapshot_id,
    modelVersionId: round.model_version_id,
    modelHash: round.model_hash,
    evidenceRoot: round.evidence_root,
    solanaRoundPda: round.solana_round_pda,
    simulation: true,
  };
}

export async function loadRound(db: Pool | PoolClient, roundId: string): Promise<RoundRow | null> {
  const { rows } = await db.query<RoundRow>(`select ${ROUND_COLUMNS} from rounds where id = $1`, [roundId]);
  return rows[0] ?? null;
}

/** Price explanation for a round: the frozen snapshot's values, stages, and scores. */
export async function loadRoundValuation(pool: Pool, round: RoundRow) {
  const { rows } = await pool.query(
    `select v.declared_stage::text as declared_stage, v.effective_stage::text as effective_stage,
            v.current_operating_value::text as current_operating_value, v.scenario_value::text as scenario_value,
            v.model_reference_value::text as model_reference_value, v.demand_multiplier::text as demand_multiplier,
            v.round_implied_value::text as round_implied_value, v.scenario_details,
            (select json_build_object('execution', s.execution_score, 'market', s.market_score, 'product', s.product_score,
                                      'traction', s.traction_score, 'economics', s.economics_score, 'composite', s.composite_score)
               from score_snapshots s where s.valuation_run_id = v.valuation_run_id limit 1) as scores
       from valuation_snapshots v where v.id = $1`,
    [round.valuation_snapshot_id],
  );
  return rows[0] ?? null;
}

/** Off-chain quote with the round's current commitments (NESSIE_PURCHASE_FLOW §8 disclosure). */
export function quoteRound(round: RoundRow, grossMicroUsd: bigint) {
  if (grossMicroUsd < BigInt(round.unit_price_micro_usd) || grossMicroUsd > BigInt(round.max_subscription_micro_usd)) {
    throw new RoundError("INVALID_INPUT", 400, "Amount must be between one unit's price and the per-person cap.");
  }
  const q = quote(termsOf(round), grossMicroUsd, BigInt(round.total_committed_micro_usd));
  return {
    grossMicroUsd: String(q.grossMicroUsd),
    acceptedMicroUsd: String(q.acceptedMicroUsd),
    feeMicroUsd: String(q.feeMicroUsd),
    founderRewardMicroUsd: String(q.founderRewardMicroUsd),
    platformRevenueMicroUsd: String(q.platformRevenueMicroUsd),
    projectProceedsMicroUsd: String(q.projectProceedsMicroUsd),
    units: String(q.units),
    refundMicroUsd: String(q.refundMicroUsd),
    dustMicroUsd: String(q.dustMicroUsd),
    proRataReduced: q.proRataReduced,
    // Final allocation is computed at close; later commitments can reduce it pro rata.
    estimate: true,
    simulation: true,
  };
}

/** Only a DRAFT (not yet on-chain) round can be withdrawn; the terms trigger enforces this too. */
export async function deleteDraftRound(pool: Pool, roundId: string, identityId: string): Promise<void> {
  const result = await pool.query(
    `delete from rounds r using projects p
      where r.id = $1 and r.project_id = p.id and p.founder_identity_id = $2 and r.status = 'DRAFT'`,
    [roundId, identityId],
  );
  if (!result.rowCount) throw new RoundError("NOT_FOUND", 404, "No draft round to withdraw.");
}

export interface RoundOpenedEvent {
  roundPda: string;
  projectPda: string;
  receiptMint: string;
  roundNumber: number;
  opensAt: string;
  closesAt: string;
  unitPriceMicroUsd: string;
  maxUnits: string;
  targetAmount: string;
  maxSubscriptionAmount: string;
  modelHash: string;
  evidenceRoot: string;
}

/**
 * Indexer hook for the program's RoundOpened event (M§7.3 step 7). The round leaves DRAFT only if
 * every on-chain term equals the Tiger row; a mismatch is refused (and should alert), never adopted.
 */
export async function recordRoundOpened(pool: Pool, roundId: string, event: RoundOpenedEvent): Promise<string> {
  return inTransaction(pool,client=>recordRoundOpenedWithClient(client,roundId,event));
}
export async function recordRoundOpenedWithClient(client:PoolClient,roundId:string,event:RoundOpenedEvent):Promise<string> {
    const round = await client.query<RoundRow & { project_pda: string | null; receipt_mint: string | null }>(
      `select r.*, p.solana_project_pda as project_pda, p.receipt_mint
         from (select ${ROUND_COLUMNS} from rounds where id = $1 for update) r
         join projects p on p.id = r.project_id`,
      [roundId],
    );
    const row = round.rows[0];
    if (!row) throw new RoundError("NOT_FOUND", 404, "Round not found.");
    const expected = chainInstructions(row, { id: row.project_id, solana_project_pda: "known" }, "", null).instructions[0].args;
    const actual = {
      round_number: String(event.roundNumber),
      opens_at: event.opensAt,
      closes_at: event.closesAt,
      unit_price_micro_usd: event.unitPriceMicroUsd,
      max_units: event.maxUnits,
      target_amount: event.targetAmount,
      max_subscription_amount: event.maxSubscriptionAmount,
      model_hash: event.modelHash.toLowerCase(),
      evidence_root: event.evidenceRoot.toLowerCase(),
    };
    const mismatched = Object.keys(expected).filter((k) => expected[k] !== actual[k as keyof typeof actual]);
    if (mismatched.length) throw new RoundError("CHAIN_TERMS_MISMATCH", 409, `On-chain round terms differ from Tiger: ${mismatched.join(", ")}`);
    if ((row.project_pda && row.project_pda !== event.projectPda) || (row.receipt_mint && row.receipt_mint !== event.receiptMint)) {
      throw new RoundError("CHAIN_TERMS_MISMATCH", 409, "On-chain project accounts differ from Tiger.");
    }
    if (row.status !== "DRAFT") {
      if (row.solana_round_pda === event.roundPda) return row.status; // Replayed event.
      throw new RoundError("ROUND_NOT_DRAFT", 409, "Round already left DRAFT.");
    }
    await client.query(
      `update projects set solana_project_pda = $2, receipt_mint = $3, updated_at = now()
        where id = $1 and solana_project_pda is null`,
      [row.project_id, event.projectPda, event.receiptMint],
    );
    const status = Date.now() < row.opens_at.getTime() ? "SCHEDULED" : "OPEN";
    await client.query(
      `update rounds set status = $2::round_status, solana_round_pda = $3, updated_at = now() where id = $1`,
      [roundId, status, event.roundPda],
    );
    return status;
}
