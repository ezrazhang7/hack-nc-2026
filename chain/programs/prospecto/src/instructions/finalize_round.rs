use anchor_lang::prelude::*;

use crate::{
    constants::*,
    error::ProspectoError,
    events::RoundFinalized,
    state::{Round, RoundStatus},
};

/// Permissionless crank (M§7.5): after closes_at, freeze total_committed so pro-rata math is fixed.
#[derive(Accounts)]
pub struct FinalizeRound<'info> {
    #[account(
        mut,
        seeds = [ROUND_SEED, round.project.as_ref(), &round.round_number.to_le_bytes()],
        bump = round.bump,
    )]
    pub round: Account<'info, Round>,
}

pub fn handle_finalize_round(ctx: Context<FinalizeRound>) -> Result<()> {
    let round = &mut ctx.accounts.round;
    require!(round.status == RoundStatus::Open, ProspectoError::RoundNotOpen);
    require!(Clock::get()?.unix_timestamp >= round.closes_at, ProspectoError::RoundStillOpen);
    let expired = round.total_committed == 0;
    round.status = if expired { RoundStatus::Expired } else { RoundStatus::Finalized };
    round.filled = round.total_committed >= round.target_amount;
    emit!(RoundFinalized {
        round: round.key(),
        total_committed: round.total_committed,
        filled: round.filled,
        expired,
    });
    Ok(())
}
