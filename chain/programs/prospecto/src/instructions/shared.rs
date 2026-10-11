use anchor_lang::prelude::*;
use anchor_spl::token_interface::{transfer_checked, TransferChecked};

use crate::{error::ProspectoError, math, state::Round};

/// Moves `amount` out of a PDA-owned vault; zero amounts are skipped so dust-free legs cost nothing.
#[allow(clippy::too_many_arguments)]
pub fn transfer_from_pda<'info>(
    token_program: &AccountInfo<'info>,
    from: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    amount: u64,
    decimals: u8,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    transfer_checked(
        CpiContext::new_with_signer(
            token_program.key(),
            TransferChecked { from: from.clone(), mint: mint.clone(), to: to.clone(), authority: authority.clone() },
            signer_seeds,
        ),
        amount,
        decimals,
    )
}

/// A finalized round's settlement for one subscription, from the frozen round totals.
pub fn allocation_for(round: &Round, gross: u64) -> Result<math::Allocation> {
    math::allocate(
        gross,
        round.total_committed,
        round.target_amount,
        round.unit_price_micro_usd,
        round.protocol_fee_bps,
        round.founder_share_bps,
    )
    .map_err(|_| error!(ProspectoError::InvariantViolated))
}
