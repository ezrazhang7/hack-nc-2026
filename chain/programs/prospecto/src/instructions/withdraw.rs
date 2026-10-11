use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, Token2022, TokenAccount};

use super::shared::transfer_from_pda;
use crate::{
    constants::*,
    error::ProspectoError,
    events::{FounderRewardsWithdrawn, ProceedsWithdrawn},
    state::{Config, Project},
};

/// Founder withdraws the full balance of one project vault to their own mock-USDC account.
/// Devnet tokens only; nothing is credited back to Nessie (NESSIE_PURCHASE_FLOW §8).
#[derive(Accounts)]
pub struct Withdraw<'info> {
    pub founder: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = payment_mint)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        seeds = [PROJECT_SEED, project.project_id.as_ref()],
        bump = project.bump,
        constraint = project.founder_wallet == founder.key() @ ProspectoError::NotFounder,
    )]
    pub project: Box<Account<'info, Project>>,
    /// project_vault or founder_reward_vault; the handler checks which.
    #[account(mut, token::authority = project, token::mint = payment_mint)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        token::mint = payment_mint,
        token::authority = founder,
        token::token_program = token_program,
    )]
    pub founder_payment_account: Box<InterfaceAccount<'info, TokenAccount>>,
    pub payment_mint: Box<InterfaceAccount<'info, Mint>>,
    pub token_program: Program<'info, Token2022>,
}

fn withdraw_all(ctx: &Context<Withdraw>, expected_vault: Pubkey) -> Result<u64> {
    require_keys_eq!(ctx.accounts.vault.key(), expected_vault);
    let amount = ctx.accounts.vault.amount;
    require!(amount > 0, ProspectoError::NothingToWithdraw);
    let project = &ctx.accounts.project;
    let bump = [project.bump];
    let seeds: &[&[u8]] = &[PROJECT_SEED, project.project_id.as_ref(), &bump];
    transfer_from_pda(
        &ctx.accounts.token_program.to_account_info(),
        &ctx.accounts.vault.to_account_info(),
        &ctx.accounts.payment_mint.to_account_info(),
        &ctx.accounts.founder_payment_account.to_account_info(),
        &ctx.accounts.project.to_account_info(),
        amount,
        ctx.accounts.payment_mint.decimals,
        &[seeds],
    )?;
    Ok(amount)
}

pub fn handle_withdraw_project_proceeds(ctx: Context<Withdraw>) -> Result<()> {
    let amount = withdraw_all(&ctx, ctx.accounts.project.project_vault)?;
    emit!(ProceedsWithdrawn { project: ctx.accounts.project.key(), amount });
    Ok(())
}

pub fn handle_withdraw_founder_rewards(ctx: Context<Withdraw>) -> Result<()> {
    let amount = withdraw_all(&ctx, ctx.accounts.project.founder_reward_vault)?;
    emit!(FounderRewardsWithdrawn { project: ctx.accounts.project.key(), amount });
    Ok(())
}
