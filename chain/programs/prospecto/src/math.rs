// PURE settlement math (BACKEND_STACK §6.3, NESSIE_PURCHASE_FLOW §8). Integer micro-USD, u128
// intermediates, every division rounds down. backend/src/settlement/math.ts mirrors this exactly;
// both are checked against docs/fixtures/nessie-purchase-cases.json.

use crate::constants::BPS_DENOMINATOR;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Allocation {
    pub accepted: u64,
    pub fee: u64,
    pub founder_reward: u64,
    pub platform_revenue: u64,
    /// accepted − fee; sub-unit dust stays here (M§4.12).
    pub project_proceeds: u64,
    pub units: u64,
    pub refund: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MathError {
    Overflow,
    InvalidInput,
}

/// One subscription's settlement given the round's final total commitments.
pub fn allocate(
    gross: u64,
    total_committed: u64,
    target: u64,
    unit_price: u64,
    protocol_fee_bps: u16,
    founder_share_bps: u16,
) -> Result<Allocation, MathError> {
    let bps = BPS_DENOMINATOR as u128;
    if unit_price == 0
        || gross > total_committed
        || protocol_fee_bps as u128 > bps
        || founder_share_bps as u128 > bps
    {
        return Err(MathError::InvalidInput);
    }
    let accepted = if total_committed <= target {
        gross
    } else {
        narrow((gross as u128 * target as u128) / total_committed as u128)?
    };
    let fee = narrow((accepted as u128 * protocol_fee_bps as u128) / bps)?;
    let founder_reward = narrow((fee as u128 * founder_share_bps as u128) / bps)?;
    let platform_revenue = fee.checked_sub(founder_reward).ok_or(MathError::Overflow)?;
    let project_proceeds = accepted.checked_sub(fee).ok_or(MathError::Overflow)?;
    let units = project_proceeds / unit_price;
    let refund = gross.checked_sub(accepted).ok_or(MathError::Overflow)?;
    Ok(Allocation { accepted, fee, founder_reward, platform_revenue, project_proceeds, units, refund })
}

fn narrow(value: u128) -> Result<u64, MathError> {
    u64::try_from(value).map_err(|_| MathError::Overflow)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Fixture {
        fee_bps: u16,
        founder_fee_share_bps: u16,
        cases: Vec<Case>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Case {
        name: String,
        target_micro_usd: String,
        max_units: String,
        unit_price_micro_usd: String,
        gross_amounts_micro_usd: Vec<String>,
        #[serde(default)]
        cancelled: bool,
        expected: Vec<Expected>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Expected {
        accepted_micro_usd: String,
        fee_micro_usd: String,
        founder_reward_micro_usd: String,
        platform_revenue_micro_usd: String,
        project_proceeds_micro_usd: String,
        units: String,
        refund_micro_usd: String,
        dust_micro_usd: String,
    }

    fn n(s: &str) -> u64 {
        s.parse().unwrap()
    }

    /// Golden cases shared with the TypeScript mirror; any drift between the two fails here.
    #[test]
    fn matches_shared_fixtures() {
        let raw = include_str!("../../../../docs/fixtures/nessie-purchase-cases.json");
        let fixture: Fixture = serde_json::from_str(raw).unwrap();
        assert!(!fixture.cases.is_empty());
        for case in fixture.cases {
            let target = n(&case.target_micro_usd);
            let price = n(&case.unit_price_micro_usd);
            let grosses: Vec<u64> = case.gross_amounts_micro_usd.iter().map(|g| n(g)).collect();
            let total: u64 = grosses.iter().sum();
            let (mut sum_accepted, mut sum_units) = (0u64, 0u64);
            for (gross, want) in grosses.iter().zip(case.expected.iter()) {
                let got = if case.cancelled {
                    Allocation { accepted: 0, fee: 0, founder_reward: 0, platform_revenue: 0, project_proceeds: 0, units: 0, refund: *gross }
                } else {
                    allocate(*gross, total, target, price, fixture.fee_bps, fixture.founder_fee_share_bps).unwrap()
                };
                let ctx = &case.name;
                assert_eq!(got.accepted, n(&want.accepted_micro_usd), "{ctx} accepted");
                assert_eq!(got.fee, n(&want.fee_micro_usd), "{ctx} fee");
                assert_eq!(got.founder_reward, n(&want.founder_reward_micro_usd), "{ctx} founder reward");
                assert_eq!(got.platform_revenue, n(&want.platform_revenue_micro_usd), "{ctx} platform revenue");
                assert_eq!(got.project_proceeds, n(&want.project_proceeds_micro_usd), "{ctx} proceeds");
                assert_eq!(got.units, n(&want.units), "{ctx} units");
                assert_eq!(got.refund, n(&want.refund_micro_usd), "{ctx} refund");
                assert_eq!(got.project_proceeds - got.units * price, n(&want.dust_micro_usd), "{ctx} dust");
                assert_eq!(got.accepted + got.refund, *gross, "{ctx} accepted + refund = gross");
                assert_eq!(got.fee, got.founder_reward + got.platform_revenue, "{ctx} fee split");
                sum_accepted += got.accepted;
                sum_units += got.units;
            }
            assert!(sum_accepted <= target, "{} Σaccepted ≤ target", case.name);
            assert!(sum_units <= n(&case.max_units), "{} Σunits ≤ max_units", case.name);
        }
    }

    #[test]
    fn rejects_invalid_input() {
        assert_eq!(allocate(1, 1, 1, 0, 100, 4000), Err(MathError::InvalidInput));
        assert_eq!(allocate(2, 1, 1, 1, 100, 4000), Err(MathError::InvalidInput));
        assert_eq!(allocate(1, 1, 1, 1, 10_001, 4000), Err(MathError::InvalidInput));
        assert_eq!(allocate(1, 1, 1, 1, 100, 10_001), Err(MathError::InvalidInput));
    }

    #[test]
    fn u64_extremes_do_not_overflow() {
        let a = allocate(u64::MAX, u64::MAX, u64::MAX - 1, 1, 10_000, 10_000).unwrap();
        assert_eq!(a.accepted + a.refund, u64::MAX);
        assert_eq!(a.fee, a.accepted);
        assert_eq!(a.project_proceeds, 0);
    }
}
