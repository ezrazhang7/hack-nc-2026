// Prospecto primary-issuance program (M§6.3, M§7, BACKEND_STACK §6). Devnet only: mock USDC and
// non-transferable participation receipts. Receipts are not equity and carry no redemption promise.

pub mod constants;
pub mod error;
pub mod events;
pub mod instructions;
pub mod math;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use state::*;

declare_id!("DnofuRV6ipCbSsuH4nJx8AABfqziwfuihckoMLDNRJdY");

#[program]
pub mod prospecto {
    use super::*;

    pub fn initialize_protocol(ctx: Context<InitializeProtocol>, args: InitializeProtocolArgs) -> Result<()> {
        instructions::initialize::handle_initialize_protocol(ctx, args)
    }

    pub fn fund_mock_usdc(
        ctx: Context<FundMockUsdc>,
        intent_id: [u8; 16],
        amount: u64,
        bank_proof_hash: [u8; 32],
    ) -> Result<()> {
        instructions::fund_mock_usdc::handle_fund_mock_usdc(ctx, intent_id, amount, bank_proof_hash)
    }

    pub fn create_project(ctx: Context<CreateProject>, project_id: [u8; 16]) -> Result<()> {
        instructions::create_project::handle_create_project(ctx, project_id)
    }

    pub fn open_round(ctx: Context<OpenRound>, args: OpenRoundArgs) -> Result<()> {
        instructions::open_round::handle_open_round(ctx, args)
    }

    pub fn subscribe(ctx: Context<Subscribe>, gross_amount: u64) -> Result<()> {
        instructions::subscribe::handle_subscribe(ctx, gross_amount)
    }

    pub fn finalize_round(ctx: Context<FinalizeRound>) -> Result<()> {
        instructions::finalize_round::handle_finalize_round(ctx)
    }

    pub fn mint_final_allocation(ctx: Context<MintFinalAllocation>) -> Result<()> {
        instructions::mint_final_allocation::handle_mint_final_allocation(ctx)
    }

    pub fn refund_excess(ctx: Context<RefundExcess>) -> Result<()> {
        instructions::refund_excess::handle_refund_excess(ctx)
    }

    pub fn cancel_and_refund(ctx: Context<CancelAndRefund>) -> Result<()> {
        instructions::cancel_and_refund::handle_cancel_and_refund(ctx)
    }

    pub fn withdraw_project_proceeds(ctx: Context<Withdraw>) -> Result<()> {
        instructions::withdraw::handle_withdraw_project_proceeds(ctx)
    }

    pub fn withdraw_founder_rewards(ctx: Context<Withdraw>) -> Result<()> {
        instructions::withdraw::handle_withdraw_founder_rewards(ctx)
    }
}
