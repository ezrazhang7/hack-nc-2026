use anchor_lang::prelude::*;
use anchor_spl::token_interface::{transfer_checked, Mint, Token2022, TokenAccount, TransferChecked};

use crate::{
    constants::*,
    error::ProspectoError,
    events::SubscriptionAccepted,
    state::{Config, Project, Round, RoundStatus, Subscription},
};

/// M§7.4: commit mock USDC to the round vault. The relayer's co-signature is the eligibility
/// attestation (BACKEND_STACK §6.2); it expires with the blockhash. Receipts mint after close.
#[derive(Accounts)]
pub struct Subscribe<'info> {
    #[account(mut)]
    pub relayer: Signer<'info>,
    pub buyer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = relayer, has_one = payment_mint)]
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
    // `init` makes one subscription per buyer per round (BACKEND_STACK §6.2).
    #[account(
        init,
        payer = relayer,
        space = 8 + Subscription::INIT_SPACE,
        seeds = [SUBSCRIPTION_SEED, round.key().as_ref(), buyer.key().as_ref()],
        bump,
    )]
    pub subscription: Box<Account<'info, Subscription>>,
    #[account(
        mut,
        token::mint = payment_mint,
        token::authority = buyer,
        token::token_program = token_program,
    )]
    pub buyer_payment_account: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, seeds = [ROUND_VAULT_SEED, round.key().as_ref()], bump)]
    pub round_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub payment_mint: Box<InterfaceAccount<'info, Mint>>,
    pub token_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}

pub fn handle_subscribe(ctx: Context<Subscribe>, gross_amount: u64) -> Result<()> {
    require!(!ctx.accounts.config.paused, ProspectoError::Paused);
    let round = &ctx.accounts.round;
    let now = Clock::get()?.unix_timestamp;
    require!(
        round.status == RoundStatus::Open && round.opens_at <= now && now < round.closes_at,
        ProspectoError::RoundNotOpen
    );
    require_keys_neq!(ctx.accounts.buyer.key(), ctx.accounts.project.founder_wallet, ProspectoError::FounderSelfSubscription);
    require!(
        round.unit_price_micro_usd <= gross_amount && gross_amount <= round.max_subscription_amount,
        ProspectoError::InvalidGrossAmount
    );

    transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.buyer_payment_account.to_account_info(),
                mint: ctx.accounts.payment_mint.to_account_info(),
                to: ctx.accounts.round_vault.to_account_info(),
                authority: ctx.accounts.buyer.to_account_info(),
            },
        ),
        gross_amount,
        ctx.accounts.payment_mint.decimals,
    )?;

    let round = &mut ctx.accounts.round;
    round.total_committed = round.total_committed.checked_add(gross_amount).ok_or(ProspectoError::Overflow)?;
    round.subscriber_count = round.subscriber_count.checked_add(1).ok_or(ProspectoError::Overflow)?;
    ctx.accounts.subscription.set_inner(Subscription {
        round: round.key(),
        buyer: ctx.accounts.buyer.key(),
        gross_amount,
        accepted_amount: 0,
        units: 0,
        refunded_amount: 0,
        minted: false,
        refunded: false,
        bump: ctx.bumps.subscription,
    });
    emit!(SubscriptionAccepted {
        round: round.key(),
        subscription: ctx.accounts.subscription.key(),
        buyer: ctx.accounts.buyer.key(),
        gross_amount,
        total_committed: round.total_committed,
    });
    Ok(())
}
