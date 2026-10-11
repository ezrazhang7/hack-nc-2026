use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, Token2022, TokenAccount};

use crate::{constants::*, error::ProspectoError, program::Prospecto, state::Config};

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InitializeProtocolArgs {
    pub relayer: Pubkey,
    pub protocol_fee_bps: u16,
    pub founder_share_bps: u16,
    pub max_units_per_round: u64,
    pub min_round_seconds: i64,
    pub max_round_seconds: i64,
}

#[derive(Accounts)]
pub struct InitializeProtocol<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(init, payer = admin, space = 8 + Config::INIT_SPACE, seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, Config>,
    /// Mock USDC, created off-chain by devnet-setup with the relayer as mint authority.
    #[account(mint::token_program = token_program)]
    pub payment_mint: InterfaceAccount<'info, Mint>,
    #[account(
        init,
        payer = admin,
        seeds = [PROTOCOL_FEE_VAULT_SEED],
        bump,
        token::mint = payment_mint,
        token::authority = config,
        token::token_program = token_program,
    )]
    pub protocol_fee_vault: InterfaceAccount<'info, TokenAccount>,
    // Only the upgrade authority may initialize, so nobody can front-run the deploy and become admin.
    #[account(constraint = program.programdata_address()? == Some(program_data.key()))]
    pub program: Program<'info, Prospecto>,
    #[account(constraint = program_data.upgrade_authority_address == Some(admin.key()) @ ProspectoError::NotUpgradeAuthority)]
    pub program_data: Account<'info, ProgramData>,
    pub token_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}

pub fn handle_initialize_protocol(ctx: Context<InitializeProtocol>, args: InitializeProtocolArgs) -> Result<()> {
    require!(
        args.protocol_fee_bps as u64 <= BPS_DENOMINATOR && args.founder_share_bps as u64 <= BPS_DENOMINATOR,
        ProspectoError::InvalidBps
    );
    require!(
        0 < args.min_round_seconds && args.min_round_seconds <= args.max_round_seconds && args.max_units_per_round > 0,
        ProspectoError::InvalidRoundWindow
    );
    let mint = &ctx.accounts.payment_mint;
    require!(
        mint.decimals == PAYMENT_DECIMALS && mint.mint_authority == Some(args.relayer).into(),
        ProspectoError::InvalidPaymentMint
    );

    ctx.accounts.config.set_inner(Config {
        admin: ctx.accounts.admin.key(),
        relayer: args.relayer,
        payment_mint: mint.key(),
        protocol_fee_vault: ctx.accounts.protocol_fee_vault.key(),
        protocol_fee_bps: args.protocol_fee_bps,
        founder_share_bps: args.founder_share_bps,
        max_units_per_round: args.max_units_per_round,
        min_round_seconds: args.min_round_seconds,
        max_round_seconds: args.max_round_seconds,
        paused: false,
        bump: ctx.bumps.config,
    });
    Ok(())
}
