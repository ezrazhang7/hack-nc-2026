import { createHash } from 'node:crypto';
import { AppError } from '../http/errors.js';
import { u64 } from '../rounds/allocation.js';

export function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value) return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  throw new Error('Unsupported canonical value.');
}
export const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
export function fundingDollars(amount: string): number {
  const micro = u64(amount);
  if (micro < 1_000_000n || micro % 1_000_000n !== 0n) throw new AppError('INVALID_INPUT', 'Funding requires positive whole simulated dollars.');
  if (micro > 1_000_000_000n) throw new AppError('FUNDING_LIMIT', 'Demo funding is limited to $1,000 per identity.', 409);
  return Number(micro / 1_000_000n);
}
