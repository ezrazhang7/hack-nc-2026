use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, Token2022, TokenAccount};

use super::shared::{allocation_for, transfer_from_pda};
use crate::{
    constants::*,
    error::ProspectoError,
    events::ExcessRefunded,
    state::{Config, Round, RoundStatus, Subscription},
};

/// Permissionless crank (M§7.5): return gross − accepted to the subscribing wallet, at most once.
/// A cancelled (Refunding) round accepted nothing, so the whole gross comes back.
#[derive(Accounts)]
pub struct RefundExcess<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = payment_mint)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        seeds = [ROUND_SEED, round.project.as_ref(), &round.round_number.to_le_bytes()],
        bump = round.bump,
    )]
    pub round: Box<Account<'info, Round>>,
    #[account(
        mut,
        seeds = [SUBSCRIPTION_SEED, round.key().as_ref(), subscription.buyer.as_ref()],
        bump = subscription.bump,
        has_one = round,
    )]
    pub subscription: Box<Account<'info, Subscription>>,
    #[account(
        mut,
        token::mint = payment_mint,
        token::authority = subscription.buyer,
        token::token_program = token_program,
    )]
    pub buyer_payment_account: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, seeds = [ROUND_VAULT_SEED, round.key().as_ref()], bump)]
    pub round_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub payment_mint: Box<InterfaceAccount<'info, Mint>>,
    pub token_program: Program<'info, Token2022>,
}

pub fn handle_refund_excess(ctx: Context<RefundExcess>) -> Result<()> {
    let round = &ctx.accounts.round;
    require!(!ctx.accounts.subscription.refunded, ProspectoError::AlreadyRefunded);
    let gross = ctx.accounts.subscription.gross_amount;
    let refund = match round.status {
        RoundStatus::Finalized => allocation_for(round, gross)?.refund,
        RoundStatus::Refunding => gross,
        _ => return err!(ProspectoError::RoundNotRefundable),
    };

    let round_number = round.round_number.to_le_bytes();
    let round_bump = [round.bump];
    let round_seeds: &[&[u8]] = &[ROUND_SEED, round.project.as_ref(), &round_number, &round_bump];
    transfer_from_pda(
        &ctx.accounts.token_program.to_account_info(),
        &ctx.accounts.round_vault.to_account_info(),
        &ctx.accounts.payment_mint.to_account_info(),
        &ctx.accounts.buyer_payment_account.to_account_info(),
        &ctx.accounts.round.to_account_info(),
        refund,
        ctx.accounts.payment_mint.decimals,
        &[round_seeds],
    )?;

    let subscription = &mut ctx.accounts.subscription;
    subscription.refunded_amount = refund;
    subscription.refunded = true;
    emit!(ExcessRefunded {
        round: subscription.round,
        subscription: subscription.key(),
        buyer: subscription.buyer,
        amount: refund,
    });
    Ok(())
}
