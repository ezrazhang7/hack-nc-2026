// Events the indexer mirrors into Tiger (BACKEND_STACK §6.2). RoundOpened carries every open_round
// arg so recordRoundOpened can compare them field by field with the DRAFT row.

use anchor_lang::prelude::*;

#[event]
pub struct MockWalletFunded {
    pub intent_id: [u8; 16],
    pub wallet: Pubkey,
    pub amount: u64,
    pub bank_proof_hash: [u8; 32],
}

#[event]
pub struct ProjectCreated {
    pub project: Pubkey,
    pub project_id: [u8; 16],
    pub founder_wallet: Pubkey,
    pub receipt_mint: Pubkey,
    pub project_vault: Pubkey,
    pub founder_reward_vault: Pubkey,
}

#[event]
pub struct RoundOpened {
    pub round: Pubkey,
    pub project: Pubkey,
    pub receipt_mint: Pubkey,
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

#[event]
pub struct SubscriptionAccepted {
    pub round: Pubkey,
    pub subscription: Pubkey,
    pub buyer: Pubkey,
    pub gross_amount: u64,
    pub total_committed: u64,
}

#[event]
pub struct RoundFinalized {
    pub round: Pubkey,
    pub total_committed: u64,
    pub filled: bool,
    pub expired: bool,
}

#[event]
pub struct AllocationMinted {
    pub round: Pubkey,
    pub subscription: Pubkey,
    pub buyer: Pubkey,
    pub accepted_amount: u64,
    pub fee: u64,
    pub founder_reward: u64,
    pub project_proceeds: u64,
    pub units: u64,
}

#[event]
pub struct ExcessRefunded {
    pub round: Pubkey,
    pub subscription: Pubkey,
    pub buyer: Pubkey,
    pub amount: u64,
}

#[event]
pub struct RoundCancelled {
    pub round: Pubkey,
    pub cancelled_by: Pubkey,
}

#[event]
pub struct ProceedsWithdrawn {
    pub project: Pubkey,
    pub amount: u64,
}

#[event]
pub struct FounderRewardsWithdrawn {
    pub project: Pubkey,
    pub amount: u64,
}
