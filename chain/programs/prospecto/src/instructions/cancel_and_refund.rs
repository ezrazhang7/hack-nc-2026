use anchor_lang::prelude::*;

use crate::{
    constants::*,
    error::ProspectoError,
    events::RoundCancelled,
    state::{Config, Project, Round, RoundStatus},
};

/// Founder or admin cancels a round before finalization (NESSIE_PURCHASE_FLOW §8). Nothing has been
/// paid out while a round is Open, so every subscription then refunds its full gross via refund_excess.
#[derive(Accounts)]
pub struct CancelAndRefund<'info> {
    pub authority: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(seeds = [PROJECT_SEED, project.project_id.as_ref()], bump = project.bump)]
    pub project: Box<Account<'info, Project>>,
    #[account(
        mut,
        seeds = [ROUND_SEED, project.key().as_ref(), &round.round_number.to_le_bytes()],
        bump = round.bump,
        has_one = project,
    )]
    pub round: Box<Account<'info, Round>>,
}

pub fn handle_cancel_and_refund(ctx: Context<CancelAndRefund>) -> Result<()> {
    let signer = ctx.accounts.authority.key();
    require!(
        signer == ctx.accounts.project.founder_wallet || signer == ctx.accounts.config.admin,
        ProspectoError::NotFounderOrAdmin
    );
    let round = &mut ctx.accounts.round;
    require!(round.status == RoundStatus::Open, ProspectoError::RoundNotCancellable);
    round.status = RoundStatus::Refunding;
    emit!(RoundCancelled { round: round.key(), cancelled_by: signer });
    Ok(())
}
