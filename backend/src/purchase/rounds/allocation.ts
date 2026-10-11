import { AppError } from '../http/errors.js';

export const U64_MAX = (1n << 64n) - 1n;
export function u64(value: string): bigint {
  if (!/^(0|[1-9][0-9]{0,19})$/.test(value)) throw new AppError('INVALID_INPUT', 'Amounts must be unsigned decimal strings.');
  const amount = BigInt(value);
  if (amount > U64_MAX) throw new AppError('INVALID_INPUT', 'Amount exceeds the on-chain u64 range.');
  return amount;
}

export interface AllocationInput {
  grossAmountMicroUsd: string;
  totalCommittedMicroUsd: string;
  unitPriceMicroUsd: string;
  maxUnits: string;
  cancelled?: boolean;
}

// A preview only: final amounts are computed and enforced by the program.
export function allocation(input: AllocationInput) {
  const gross = u64(input.grossAmountMicroUsd);
  const total = u64(input.totalCommittedMicroUsd);
  const price = u64(input.unitPriceMicroUsd);
  const maxUnits = u64(input.maxUnits);
  const target = price * maxUnits;
  if (price === 0n || maxUnits === 0n || target > U64_MAX || gross > total) {
    throw new AppError('INVALID_INPUT', 'Invalid round price, capacity, or commitment total.');
  }
  const accepted = input.cancelled ? 0n : total <= target ? gross : gross * target / total;
  const fee = accepted * 100n / 10_000n;
  const reward = fee * 4000n / 10_000n;
  const net = accepted - fee;
  const units = net / price;
  return {
    acceptedMicroUsd: accepted.toString(), feeMicroUsd: fee.toString(),
    founderRewardMicroUsd: reward.toString(), platformRevenueMicroUsd: (fee - reward).toString(),
    projectProceedsMicroUsd: net.toString(), units: units.toString(),
    refundMicroUsd: (gross - accepted).toString(), dustMicroUsd: (net % price).toString(),
  };
}
