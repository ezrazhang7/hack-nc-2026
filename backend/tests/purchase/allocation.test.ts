import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { allocation, U64_MAX, u64 } from '../../src/purchase/rounds/allocation.js';

interface Fixture {
  name: string; targetMicroUsd: string; maxUnits: string; unitPriceMicroUsd: string;
  grossAmountsMicroUsd: string[]; cancelled?: boolean;
  expected: ReturnType<typeof allocation>[];
}
const fixtures = JSON.parse(readFileSync(new URL('../../../docs/fixtures/nessie-purchase-cases.json', import.meta.url), 'utf8')) as { cases: Fixture[] };
describe('documented allocation fixtures', () => {
  for (const fixture of fixtures.cases) test(fixture.name, () => {
    const total = fixture.grossAmountsMicroUsd.reduce((sum, value) => sum + BigInt(value), 0n);
    const results = fixture.grossAmountsMicroUsd.map(gross => allocation({
      grossAmountMicroUsd: gross, totalCommittedMicroUsd: total.toString(),
      unitPriceMicroUsd: fixture.unitPriceMicroUsd, maxUnits: fixture.maxUnits,
      ...(fixture.cancelled === undefined ? {} : { cancelled: fixture.cancelled }),
    }));
    expect(results).toEqual(fixture.expected);
  });
});
test('conservation and capacity across 1000 deterministic rounds', () => {
  for (let sample = 1n; sample <= 1000n; sample++) {
    const price = sample * 101n;
    const maxUnits = sample % 17n + 1n;
    const grossAmounts = [sample * 1001n, sample * 1027n, sample * 73n];
    const total = grossAmounts.reduce((sum, gross) => sum + gross, 0n);
    let units = 0n;
    let accepted = 0n;
    for (const gross of grossAmounts) {
      const result = allocation({ grossAmountMicroUsd: gross.toString(), totalCommittedMicroUsd: total.toString(), unitPriceMicroUsd: price.toString(), maxUnits: maxUnits.toString() });
      expect(BigInt(result.acceptedMicroUsd) + BigInt(result.refundMicroUsd)).toBe(gross);
      expect(BigInt(result.founderRewardMicroUsd) + BigInt(result.platformRevenueMicroUsd)).toBe(BigInt(result.feeMicroUsd));
      expect(BigInt(result.units) * price + BigInt(result.dustMicroUsd)).toBe(BigInt(result.projectProceedsMicroUsd));
      units += BigInt(result.units); accepted += BigInt(result.acceptedMicroUsd);
    }
    expect(units <= maxUnits).toBe(true);
    expect(accepted <= price * maxUnits).toBe(true);
  }
});
test.each(['-1', '1.5', '01', '1e6', '', (U64_MAX + 1n).toString()])('rejects unsafe amount %s', value => {
  expect(() => u64(value)).toThrow();
});
test('supports amounts beyond JavaScript safe integers', () => {
  const amount = '9007199254740993';
  const result = allocation({ grossAmountMicroUsd: amount, totalCommittedMicroUsd: amount, unitPriceMicroUsd: '1', maxUnits: amount });
  expect(BigInt(result.acceptedMicroUsd)).toBe(9007199254740993n);
});
test('rejects overflow, zero price and inconsistent totals', () => {
  const input = { grossAmountMicroUsd: '1', totalCommittedMicroUsd: '1', unitPriceMicroUsd: '1', maxUnits: '1' };
  expect(() => allocation({ ...input, unitPriceMicroUsd: U64_MAX.toString(), maxUnits: '2' })).toThrow();
  expect(() => allocation({ ...input, unitPriceMicroUsd: '0' })).toThrow();
  expect(() => allocation({ ...input, totalCommittedMicroUsd: '0' })).toThrow();
});
