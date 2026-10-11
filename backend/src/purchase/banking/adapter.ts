import { z } from 'zod';
import { AppError } from '../http/errors.js';

const providerId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const profileSchema = z.object({
  id: z.string().min(1), baseUrl: z.url(), capabilitiesVerified: z.literal(true),
  verificationReference: z.string().min(1), verifiedAt: z.iso.datetime(),
  createEnvelope: z.enum(['direct', 'objectCreated']), readEnvelope: z.enum(['direct', 'objectCreated']),
  historyEnvelope: z.enum(['array', 'data']), historyPagination: z.enum(['none', 'next', 'link']),
  successStatuses: z.array(z.string().min(1)).min(1), pendingStatuses: z.array(z.string().min(1)),
  rejectedStatuses: z.array(z.string().min(1)), definitiveNoEffectHttpStatuses: z.array(z.number().int().min(400).max(499)),
}).strict().superRefine((value, context) => {
  const url = new URL(value.baseUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    context.addIssue({ code: 'custom', message: 'Profile base URL must be a trusted HTTPS origin.' });
  }
  const statuses = [...value.successStatuses, ...value.pendingStatuses, ...value.rejectedStatuses];
  if (new Set(statuses).size !== statuses.length) context.addIssue({ code: 'custom', message: 'Provider status classes must not overlap.' });
});
export type NessieProfile = z.infer<typeof profileSchema>;

/**
 * Built-in Nessie wire profile; replaces the deprecated NESSIE_PROFILE / NESSIE_PROFILE_PATH files
 * (still accepted as an override). Every value is documented or observed, never guessed:
 * - create: `201 {objectCreated}` (NESSIE_PURCHASE_FLOW §3, provider SDK fixture);
 * - reads: the object itself, history: a bare array, no pagination (read-only check, 2026-10-10);
 * - `completed` is the current docs' transfer status, `pending` the SDK fixture's. Any other status
 *   is `unknown` and fails closed to operator review; no HTTP error is treated as proof of no effect.
 *
 * Observed 2026-10-11 against prod-api: Nessie's transfer endpoint no longer takes a payee and no
 * Nessie write changes an account balance. A funding transfer is therefore recorded as a
 * withdrawal from the payer, `completed` at creation, whose description carries the funding tag and
 * the payee account (WITHDRAWAL_PAYEE). Balances are derived by the funding ledger (store.spent).
 */
export const BUILT_IN_PROFILE_ID = 'nessie-built-in-2026-10-10';
export function builtInNessieProfile(baseUrl: string): NessieProfile {
  return profileSchema.parse({
    id: BUILT_IN_PROFILE_ID, baseUrl: `${new URL(baseUrl).origin}/`, capabilitiesVerified: true,
    verificationReference: 'built-in: Nessie docs + read-only account/history check; unknown statuses fail closed',
    verifiedAt: '2026-10-10T00:00:00.000Z', createEnvelope: 'objectCreated', readEnvelope: 'direct',
    historyEnvelope: 'array', historyPagination: 'none', successStatuses: ['completed'], pendingStatuses: ['pending'],
    rejectedStatuses: [], definitiveNoEffectHttpStatuses: [],
  });
}

/** The deprecated profile override if set (it must match NESSIE_BASE_URL), else the built-in profile. */
export function resolveNessieProfile(env: { NESSIE_BASE_URL?: string; NESSIE_PROFILE?: string }, profileFile?: string): NessieProfile | null {
  const raw = env.NESSIE_PROFILE || profileFile;
  if (raw) {
    const profile = profileSchema.parse(JSON.parse(raw));
    if (!env.NESSIE_BASE_URL || new URL(profile.baseUrl).origin !== new URL(env.NESSIE_BASE_URL).origin) {
      throw new Error('NESSIE_PROFILE host does not match NESSIE_BASE_URL.');
    }
    return profile;
  }
  return env.NESSIE_BASE_URL ? builtInNessieProfile(env.NESSIE_BASE_URL) : null;
}
export interface BankTransfer {
  id: string; payerId: string; payeeId: string; dollars: number; tag: string; providerStatus: string;
  state: 'pending' | 'success' | 'rejected' | 'unknown';
}
export interface BankAccount { id: string; customerId: string; nickname: string; dollars: number }
export interface Bank {
  account(id: string): Promise<BankAccount>;
  createTransfer(payerId: string, payeeId: string, dollars: number, tag: string): Promise<string>;
  transfer(id: string, payerId: string): Promise<BankTransfer>;
  history(accountId: string): Promise<BankTransfer[]>;
}
/** Account provisioning (NESSIE_PURCHASE_FLOW §3 table: POST /customers, POST /customers/{id}/accounts). */
export interface BankProvisioner {
  customersByLastName(lastName: string): Promise<string[]>;
  checkingAccounts(customerId: string): Promise<BankAccount[]>;
  createCustomer(lastName: string): Promise<string>;
  createChecking(customerId: string, nickname: string, dollars: number): Promise<string>;
}
export class BankError extends AppError {
  constructor(readonly outcome: 'uncertain' | 'no-effect' | 'invalid', code = 'BANK_UNAVAILABLE') {
    super(code, outcome === 'invalid' ? 'Bank response requires operator review.' : 'The bank is unavailable right now. Accepted transfers will be reconciled.', 503);
  }
}
/** Separates the funding tag from the payee account in a withdrawal description. */
const WITHDRAWAL_PAYEE = '>';
const accountSchema = z.object({ _id: providerId, customer_id: providerId, nickname: z.string().max(200), balance: z.number().int().safe().nonnegative() });
const transferSchema = z.object({
  _id: providerId, payer_id: providerId, amount: z.number().int().safe().nonnegative(), description: z.string().max(300), status: z.string().min(1),
});

export class NessieBank implements Bank, BankProvisioner {
  readonly profile: NessieProfile;
  constructor(profile: NessieProfile, private readonly apiKey: string, private readonly transport: typeof fetch = fetch) {
    this.profile = profileSchema.parse(profile);
  }
  private async request(path: string, method: 'GET' | 'POST' = 'GET', body?: unknown, emptyOn404 = false): Promise<{ body: unknown; headers: Headers }> {
    const origin = new URL(this.profile.baseUrl).origin;
    const url = new URL(path, origin);
    if (url.origin !== origin || url.username || url.password || url.hash) throw new BankError('invalid');
    url.searchParams.set('key', this.apiKey);
    try {
      const response = await this.transport(url, {
        method, redirect: 'error', signal: AbortSignal.timeout(10_000),
        ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
      });
      // Nessie answers 404 "No transfers found" for an account with no history (observed 2026-10-10).
      if (emptyOn404 && response.status === 404) return { body: [], headers: response.headers };
      if (!response.ok) {
        const conclusive = method === 'POST' && this.profile.definitiveNoEffectHttpStatuses.includes(response.status);
        throw new BankError(conclusive ? 'no-effect' : 'uncertain');
      }
      const reader = response.body?.getReader();
      if (!reader) throw new BankError('invalid');
      let length = 0; const chunks: Uint8Array[] = [];
      while (true) {
        const chunk = await reader.read(); if (chunk.done) break;
        length += chunk.value.length;
        if (length > 1_000_000) { await reader.cancel(); throw new BankError('invalid'); }
        chunks.push(chunk.value);
      }
      return { body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown, headers: response.headers };
    } catch (error) {
      if (error instanceof BankError) throw error;
      // Never attach fetch errors, response bodies, or authenticated URLs.
      throw new BankError('uncertain');
    }
  }
  private unwrap(value: unknown, envelope: 'direct' | 'objectCreated'): unknown {
    if (envelope === 'direct') return value;
    return z.object({ objectCreated: z.unknown() }).parse(value).objectCreated;
  }
  private parsedTransfer(value: unknown): BankTransfer {
    const result = transferSchema.safeParse(value);
    if (!result.success) throw new BankError('invalid');
    const row = result.data;
    const state = this.profile.successStatuses.includes(row.status) ? 'success'
      : this.profile.pendingStatuses.includes(row.status) ? 'pending'
      : this.profile.rejectedStatuses.includes(row.status) ? 'rejected' : 'unknown';
    // A description without a payee yields an empty payee, which fails party verification.
    const split = row.description.lastIndexOf(WITHDRAWAL_PAYEE);
    const tag = split < 0 ? row.description : row.description.slice(0, split);
    const payeeId = split < 0 ? '' : row.description.slice(split + 1);
    return { id: row._id, payerId: row.payer_id, payeeId, dollars: row.amount, tag, providerStatus: row.status, state };
  }
  async account(id: string): Promise<BankAccount> {
    providerId.parse(id);
    const { body } = await this.request(`/accounts/${id}`);
    const result = accountSchema.safeParse(body);
    if (!result.success || result.data._id !== id) throw new BankError('invalid');
    return { id, customerId: result.data.customer_id, nickname: result.data.nickname, dollars: result.data.balance };
  }
  async createTransfer(payerId: string, payeeId: string, dollars: number, tag: string): Promise<string> {
    providerId.parse(payerId); providerId.parse(payeeId);
    if (!Number.isSafeInteger(dollars) || dollars < 1 || dollars > 1000) throw new AppError('INVALID_INPUT', 'Invalid transfer amount.');
    if (tag.includes(WITHDRAWAL_PAYEE)) throw new AppError('INVALID_INPUT', 'Invalid transfer tag.');
    const { body } = await this.request(`/accounts/${payerId}/withdrawals`, 'POST', {
      medium: 'balance', amount: dollars, status: this.profile.successStatuses[0],
      transaction_date: new Date().toISOString().slice(0, 10), description: `${tag}${WITHDRAWAL_PAYEE}${payeeId}`,
    });
    try { return z.object({ _id: providerId }).parse(this.unwrap(body, this.profile.createEnvelope))._id; }
    catch { throw new BankError('uncertain'); }
  }
  /** Nessie has no withdrawal lookup by id, so read it from the payer's withdrawal history. */
  async transfer(id: string, payerId: string): Promise<BankTransfer> {
    providerId.parse(id);
    const transfer = (await this.history(payerId)).find(item => item.id === id);
    if (!transfer) throw new BankError('uncertain');
    return transfer;
  }
  async history(accountId: string): Promise<BankTransfer[]> {
    providerId.parse(accountId);
    let path: string | null = `/accounts/${accountId}/withdrawals`;
    const visited = new Set<string>(); const transfers = new Map<string, BankTransfer>();
    for (let page = 0; path && page < 20; page++) {
      if (visited.has(path)) throw new BankError('invalid'); visited.add(path);
      const { body, headers } = await this.request(path, 'GET', undefined, page === 0);
      let rows: unknown; let next: string | null = null;
      if (this.profile.historyEnvelope === 'array') rows = body;
      else {
        const envelope = z.object({ data: z.array(z.unknown()), next: z.string().nullable().optional() }).safeParse(body);
        if (!envelope.success) throw new BankError('invalid');
        rows = envelope.data.data;
        if (this.profile.historyPagination === 'next') next = envelope.data.next ?? null;
      }
      if (this.profile.historyPagination === 'link') {
        next = /<([^>]+)>;\s*rel="next"/.exec(headers.get('link') ?? '')?.[1] ?? null;
      }
      if (!Array.isArray(rows)) throw new BankError('invalid');
      for (const raw of rows) {
        const transfer = this.parsedTransfer(raw);
        const previous = transfers.get(transfer.id);
        if (previous && JSON.stringify(previous) !== JSON.stringify(transfer)) throw new BankError('invalid');
        transfers.set(transfer.id, transfer);
      }
      if (next) {
        const url = new URL(next, this.profile.baseUrl);
        if (url.origin !== new URL(this.profile.baseUrl).origin || url.pathname !== `/accounts/${accountId}/withdrawals`
          || url.username || url.password || url.hash) throw new BankError('invalid');
        url.searchParams.delete('key'); path = url.pathname + url.search;
      } else path = null;
    }
    if (path) throw new BankError('invalid');
    return [...transfers.values()];
  }
  async customersByLastName(lastName: string): Promise<string[]> {
    const { body } = await this.request('/customers');
    const rows = z.array(z.object({ _id: providerId, last_name: z.string() }).passthrough()).safeParse(body);
    if (!rows.success) throw new BankError('invalid');
    return rows.data.filter(row => row.last_name === lastName).map(row => row._id);
  }
  async checkingAccounts(customerId: string): Promise<BankAccount[]> {
    providerId.parse(customerId);
    const { body } = await this.request(`/customers/${customerId}/accounts`, 'GET', undefined, true);
    const rows = z.array(accountSchema.extend({ type: z.string() })).safeParse(body);
    if (!rows.success) throw new BankError('invalid');
    return rows.data.filter(row => row.type === 'Checking' && row.customer_id === customerId)
      .map(row => ({ id: row._id, customerId: row.customer_id, nickname: row.nickname, dollars: row.balance }));
  }
  async createCustomer(lastName: string): Promise<string> {
    // A fixed fictional address: Nessie requires one, and no user data is ever sent.
    const { body } = await this.request('/customers', 'POST', {
      first_name: 'Prospecto', last_name: lastName,
      address: { street_number: '100', street_name: 'Franklin St', city: 'Chapel Hill', state: 'NC', zip: '27514' },
    });
    try { return z.object({ _id: providerId }).parse(this.unwrap(body, this.profile.createEnvelope))._id; }
    catch { throw new BankError('uncertain'); }
  }
  async createChecking(customerId: string, nickname: string, dollars: number): Promise<string> {
    providerId.parse(customerId);
    const { body } = await this.request(`/customers/${customerId}/accounts`, 'POST', { type: 'Checking', nickname, rewards: 0, balance: dollars });
    try { return z.object({ _id: providerId }).parse(this.unwrap(body, this.profile.createEnvelope))._id; }
    catch { throw new BankError('uncertain'); }
  }
}
