use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, Token2022, TokenAccount};

use crate::{
    constants::*,
    error::ProspectoError,
    events::RoundOpened,
    state::{Config, Project, Round, RoundStatus},
};

/// Exactly the args backend/src/rounds/service.ts `chainInstructions` emits (BACKEND_STACK §6.4).
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct OpenRoundArgs {
    pub round_number: u16,
    pub opens_at: i64,
    pub closes_at: i64,
    pub unit_price_micro_usd: u64,
    pub max_units: u64,
    pub target_amount: u64,
    pub max_subscription_amount: u64,
    pub model_hash: [u8; 32],
    pub evidence_root: [u8; 32],
}

#[derive(Accounts)]
#[instruction(args: OpenRoundArgs)]
pub struct OpenRound<'info> {
    #[account(mut)]
    pub relayer: Signer<'info>,
    pub founder: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = relayer, has_one = payment_mint)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        seeds = [PROJECT_SEED, project.project_id.as_ref()],
        bump = project.bump,
        constraint = project.founder_wallet == founder.key() @ ProspectoError::NotFounder,
    )]
    pub project: Box<Account<'info, Project>>,
    #[account(
        init,
        payer = relayer,
        space = 8 + Round::INIT_SPACE,
        seeds = [ROUND_SEED, project.key().as_ref(), &args.round_number.to_le_bytes()],
        bump,
    )]
    pub round: Box<Account<'info, Round>>,
    #[account(
        init,
        payer = relayer,
        seeds = [ROUND_VAULT_SEED, round.key().as_ref()],
        bump,
        token::mint = payment_mint,
        token::authority = round,
        token::token_program = token_program,
    )]
    pub round_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub payment_mint: Box<InterfaceAccount<'info, Mint>>,
    pub token_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}

pub fn handle_open_round(ctx: Context<OpenRound>, args: OpenRoundArgs) -> Result<()> {
    let config = &ctx.accounts.config;
    require!(!config.paused, ProspectoError::Paused);
    let duration = args.closes_at.checked_sub(args.opens_at).ok_or(ProspectoError::Overflow)?;
    require!(
        args.opens_at < args.closes_at && config.min_round_seconds <= duration && duration <= config.max_round_seconds,
        ProspectoError::InvalidRoundWindow
    );
    require!(Clock::get()?.unix_timestamp < args.closes_at, ProspectoError::RoundAlreadyClosed);
    require!(args.unit_price_micro_usd >= 1, ProspectoError::InvalidUnitPrice);
    require!(
        args.max_units > 0 && args.max_units <= config.max_units_per_round,
        ProspectoError::InvalidMaxUnits
    );
    let target = args.max_units.checked_mul(args.unit_price_micro_usd).ok_or(ProspectoError::Overflow)?;
    require!(target == args.target_amount, ProspectoError::TargetMismatch);
    require!(
        args.unit_price_micro_usd <= args.max_subscription_amount && args.max_subscription_amount <= target,
        ProspectoError::InvalidSubscriptionCap
    );

    ctx.accounts.round.set_inner(Round {
        project: ctx.accounts.project.key(),
        round_number: args.round_number,
        opens_at: args.opens_at,
        closes_at: args.closes_at,
        unit_price_micro_usd: args.unit_price_micro_usd,
        max_units: args.max_units,
        target_amount: args.target_amount,
        max_subscription_amount: args.max_subscription_amount,
        model_hash: args.model_hash,
        evidence_root: args.evidence_root,
        protocol_fee_bps: config.protocol_fee_bps,
        founder_share_bps: config.founder_share_bps,
        total_committed: 0,
        total_accepted: 0,
        total_units_minted: 0,
        subscriber_count: 0,
        filled: false,
        status: RoundStatus::Open,
        bump: ctx.bumps.round,
    });
    emit!(RoundOpened {
        round: ctx.accounts.round.key(),
        project: ctx.accounts.project.key(),
        receipt_mint: ctx.accounts.project.receipt_mint,
        round_number: args.round_number,
        opens_at: args.opens_at,
        closes_at: args.closes_at,
        unit_price_micro_usd: args.unit_price_micro_usd,
        max_units: args.max_units,
        target_amount: args.target_amount,
        max_subscription_amount: args.max_subscription_amount,
        model_hash: args.model_hash,
        evidence_root: args.evidence_root,
    });
    Ok(())
}
