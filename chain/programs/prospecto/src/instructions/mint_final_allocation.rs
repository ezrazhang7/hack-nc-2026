use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_interface::{mint_to, Mint, MintTo, Token2022, TokenAccount},
};

use super::shared::{allocation_for, transfer_from_pda};
use crate::{
    constants::*,
    error::ProspectoError,
    events::AllocationMinted,
    state::{Config, Project, Round, RoundStatus, Subscription},
};

/// Permissionless crank (M§7.5, BACKEND_STACK §6.3): split one subscription's accepted amount into
/// project proceeds, founder reward, and platform fee, and mint its receipt units. At most once.
#[derive(Accounts)]
pub struct MintFinalAllocation<'info> {
    /// Pays for the buyer's receipt account if it does not exist yet.
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = payment_mint, has_one = protocol_fee_vault)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        seeds = [PROJECT_SEED, project.project_id.as_ref()],
        bump = project.bump,
        has_one = receipt_mint,
        has_one = project_vault,
        has_one = founder_reward_vault,
    )]
    pub project: Box<Account<'info, Project>>,
    #[account(
        mut,
        seeds = [ROUND_SEED, project.key().as_ref(), &round.round_number.to_le_bytes()],
        bump = round.bump,
        has_one = project,
    )]
    pub round: Box<Account<'info, Round>>,
    #[account(
        mut,
        seeds = [SUBSCRIPTION_SEED, round.key().as_ref(), buyer.key().as_ref()],
        bump = subscription.bump,
        has_one = round,
        has_one = buyer,
    )]
    pub subscription: Box<Account<'info, Subscription>>,
    /// CHECK: identity only; bound to the subscription by `has_one = buyer`.
    pub buyer: UncheckedAccount<'info>,
    #[account(mut)]
    pub receipt_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        init_if_needed,
        payer = payer,
        associated_token::mint = receipt_mint,
        associated_token::authority = buyer,
        associated_token::token_program = token_program,
    )]
    pub buyer_receipt_account: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, seeds = [ROUND_VAULT_SEED, round.key().as_ref()], bump)]
    pub round_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub project_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub founder_reward_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub protocol_fee_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub payment_mint: Box<InterfaceAccount<'info, Mint>>,
    pub token_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handle_mint_final_allocation(ctx: Context<MintFinalAllocation>) -> Result<()> {
    let round = &ctx.accounts.round;
    require!(round.status == RoundStatus::Finalized, ProspectoError::RoundNotFinalized);
    require!(!ctx.accounts.subscription.minted, ProspectoError::AlreadyMinted);
    let a = allocation_for(round, ctx.accounts.subscription.gross_amount)?;

    let total_accepted = round.total_accepted.checked_add(a.accepted).ok_or(ProspectoError::Overflow)?;
    let total_units = round.total_units_minted.checked_add(a.units).ok_or(ProspectoError::Overflow)?;
    require!(
        total_accepted <= round.target_amount && total_units <= round.max_units,
        ProspectoError::InvariantViolated
    );

    let project_key = ctx.accounts.project.key();
    let round_number = round.round_number.to_le_bytes();
    let round_bump = [round.bump];
    let round_seeds: &[&[u8]] = &[ROUND_SEED, project_key.as_ref(), &round_number, &round_bump];
    let decimals = ctx.accounts.payment_mint.decimals;
    let token_program = ctx.accounts.token_program.to_account_info();
    let vault = ctx.accounts.round_vault.to_account_info();
    let mint = ctx.accounts.payment_mint.to_account_info();
    let authority = ctx.accounts.round.to_account_info();
    for (to, amount) in [
        (ctx.accounts.project_vault.to_account_info(), a.project_proceeds),
        (ctx.accounts.founder_reward_vault.to_account_info(), a.founder_reward),
        (ctx.accounts.protocol_fee_vault.to_account_info(), a.platform_revenue),
    ] {
        transfer_from_pda(&token_program, &vault, &mint, &to, &authority, amount, decimals, &[round_seeds])?;
    }

    if a.units > 0 {
        let project = &ctx.accounts.project;
        let project_bump = [project.bump];
        let project_seeds: &[&[u8]] = &[PROJECT_SEED, project.project_id.as_ref(), &project_bump];
        mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                MintTo {
                    mint: ctx.accounts.receipt_mint.to_account_info(),
                    to: ctx.accounts.buyer_receipt_account.to_account_info(),
                    authority: ctx.accounts.project.to_account_info(),
                },
                &[project_seeds],
            ),
            a.units,
        )?;
    }

    let round = &mut ctx.accounts.round;
    round.total_accepted = total_accepted;
    round.total_units_minted = total_units;
    let subscription = &mut ctx.accounts.subscription;
    subscription.accepted_amount = a.accepted;
    subscription.units = a.units;
    subscription.minted = true;
    emit!(AllocationMinted {
        round: round.key(),
        subscription: subscription.key(),
        buyer: subscription.buyer,
        accepted_amount: a.accepted,
        fee: a.fee,
        founder_reward: a.founder_reward,
        project_proceeds: a.project_proceeds,
        units: a.units,
    });
    Ok(())
}
