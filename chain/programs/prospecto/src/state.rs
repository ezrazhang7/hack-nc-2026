use anchor_lang::prelude::*;

/// Protocol settings (BACKEND_STACK §6.1). Limits mirror backend/src/rounds/policy.ts.
#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    /// Fee payer, eligibility co-signer, and mock USDC mint authority (demo trust assumption).
    pub relayer: Pubkey,
    pub payment_mint: Pubkey,
    pub protocol_fee_vault: Pubkey,
    pub protocol_fee_bps: u16,
    pub founder_share_bps: u16,
    pub max_units_per_round: u64,
    pub min_round_seconds: i64,
    pub max_round_seconds: i64,
    pub paused: bool,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace, Debug)]
pub enum ProjectStatus {
    Active,
}

#[account]
#[derive(InitSpace)]
pub struct Project {
    pub project_id: [u8; 16],
    pub founder_wallet: Pubkey,
    pub receipt_mint: Pubkey,
    pub project_vault: Pubkey,
    pub founder_reward_vault: Pubkey,
    pub status: ProjectStatus,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace, Debug)]
pub enum RoundStatus {
    /// Accepting subscriptions between opens_at and closes_at.
    Open,
    /// Closed with commitments; allocations can be minted and excess refunded.
    Finalized,
    /// Closed with no commitments.
    Expired,
    /// Cancelled before finalization; every subscription refunds its full gross.
    Refunding,
}

#[account]
#[derive(InitSpace)]
pub struct Round {
    pub project: Pubkey,
    pub round_number: u16,
    pub opens_at: i64,
    pub closes_at: i64,
    pub unit_price_micro_usd: u64,
    pub max_units: u64,
    pub target_amount: u64,
    pub max_subscription_amount: u64,
    pub model_hash: [u8; 32],
    pub evidence_root: [u8; 32],
    /// Fee terms snapshotted at open so settlement never depends on later config.
    pub protocol_fee_bps: u16,
    pub founder_share_bps: u16,
    pub total_committed: u64,
    pub total_accepted: u64,
    pub total_units_minted: u64,
    pub subscriber_count: u32,
    pub filled: bool,
    pub status: RoundStatus,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Subscription {
    pub round: Pubkey,
    pub buyer: Pubkey,
    pub gross_amount: u64,
    pub accepted_amount: u64,
    pub units: u64,
    pub refunded_amount: u64,
    pub minted: bool,
    pub refunded: bool,
    pub bump: u8,
}

/// Replay guard for one Nessie funding intent (NESSIE_PURCHASE_FLOW §6 step D). Never closed.
#[account]
#[derive(InitSpace)]
pub struct FundingReceipt {
    pub intent_id: [u8; 16],
    pub wallet: Pubkey,
    pub amount: u64,
    pub payment_mint: Pubkey,
    pub bank_proof_hash: [u8; 32],
    pub funded: bool,
    pub bump: u8,
}
