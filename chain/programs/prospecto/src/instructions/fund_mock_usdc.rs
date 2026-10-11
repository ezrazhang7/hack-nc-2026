use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_interface::{mint_to, Mint, MintTo, Token2022, TokenAccount},
};

use crate::{constants::*, error::ProspectoError, events::MockWalletFunded, state::{Config, FundingReceipt}};

/// NESSIE_PURCHASE_FLOW §6 step D: mint mock USDC for one bank-confirmed funding intent, at most
/// once. The FundingReceipt PDA is the replay guard: a matching replay mints nothing, a mismatched
/// one fails. The chain trusts the relayer's assertion that the Nessie transfer succeeded (demo).
#[derive(Accounts)]
#[instruction(intent_id: [u8; 16])]
pub struct FundMockUsdc<'info> {
    #[account(mut)]
    pub relayer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = relayer, has_one = payment_mint)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        init_if_needed,
        payer = relayer,
        space = 8 + FundingReceipt::INIT_SPACE,
        seeds = [FUNDING_SEED, intent_id.as_ref()],
        bump,
    )]
    pub funding_receipt: Box<Account<'info, FundingReceipt>>,
    /// CHECK: the verified wallet being funded; only used as the ATA authority.
    pub wallet: UncheckedAccount<'info>,
    #[account(
        init_if_needed,
        payer = relayer,
        associated_token::mint = payment_mint,
        associated_token::authority = wallet,
        associated_token::token_program = token_program,
    )]
    pub wallet_payment_account: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub payment_mint: Box<InterfaceAccount<'info, Mint>>,
    pub token_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handle_fund_mock_usdc(
    ctx: Context<FundMockUsdc>,
    intent_id: [u8; 16],
    amount: u64,
    bank_proof_hash: [u8; 32],
) -> Result<()> {
    require!(!ctx.accounts.config.paused, ProspectoError::Paused);
    require!((1..=MAX_FUNDING_MICRO_USD).contains(&amount), ProspectoError::InvalidFundingAmount);
    let wallet = ctx.accounts.wallet.key();
    let payment_mint = ctx.accounts.payment_mint.key();
    let receipt = &mut ctx.accounts.funding_receipt;

    if receipt.funded {
        // Replay of an already-minted intent: every immutable field must match, and nothing mints.
        require!(
            receipt.intent_id == intent_id
                && receipt.wallet == wallet
                && receipt.amount == amount
                && receipt.payment_mint == payment_mint
                && receipt.bank_proof_hash == bank_proof_hash,
            ProspectoError::FundingReplayMismatch
        );
        return Ok(());
    }

    receipt.set_inner(FundingReceipt {
        intent_id,
        wallet,
        amount,
        payment_mint,
        bank_proof_hash,
        funded: true,
        bump: ctx.bumps.funding_receipt,
    });
    mint_to(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            MintTo {
                mint: ctx.accounts.payment_mint.to_account_info(),
                to: ctx.accounts.wallet_payment_account.to_account_info(),
                authority: ctx.accounts.relayer.to_account_info(),
            },
        ),
        amount,
    )?;
    emit!(MockWalletFunded { intent_id, wallet, amount, bank_proof_hash });
    Ok(())
}
