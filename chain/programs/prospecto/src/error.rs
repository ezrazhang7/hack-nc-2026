use anchor_lang::prelude::*;

#[error_code]
pub enum ProspectoError {
    #[msg("Only the program's upgrade authority can initialize the protocol")]
    NotUpgradeAuthority,
    #[msg("Protocol is paused")]
    Paused,
    #[msg("Basis points must be within 0–10000")]
    InvalidBps,
    #[msg("Payment mint must use 6 decimals and the relayer as mint authority")]
    InvalidPaymentMint,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("opens_at must be before closes_at and the duration within config limits")]
    InvalidRoundWindow,
    #[msg("Round has already closed")]
    RoundAlreadyClosed,
    #[msg("Unit price must be at least 1 micro-USD")]
    InvalidUnitPrice,
    #[msg("max_units must be positive and within the per-round cap")]
    InvalidMaxUnits,
    #[msg("target_amount must equal max_units × unit_price")]
    TargetMismatch,
    #[msg("max_subscription_amount must be between unit_price and target_amount")]
    InvalidSubscriptionCap,
    #[msg("Signer is not the project founder")]
    NotFounder,
    #[msg("Round is not accepting subscriptions")]
    RoundNotOpen,
    #[msg("The founder cannot subscribe to their own round")]
    FounderSelfSubscription,
    #[msg("Gross amount must be between unit_price and max_subscription_amount")]
    InvalidGrossAmount,
    #[msg("Round has not reached closes_at")]
    RoundStillOpen,
    #[msg("Round is not finalized")]
    RoundNotFinalized,
    #[msg("Allocation already minted for this subscription")]
    AlreadyMinted,
    #[msg("Excess already refunded for this subscription")]
    AlreadyRefunded,
    #[msg("Round cannot be refunded in its current status")]
    RoundNotRefundable,
    #[msg("Only the founder or the admin can cancel a round")]
    NotFounderOrAdmin,
    #[msg("Only an open round can be cancelled")]
    RoundNotCancellable,
    #[msg("Settlement invariant violated")]
    InvariantViolated,
    #[msg("Nothing to withdraw")]
    NothingToWithdraw,
    #[msg("Funding amount must be between 1 and 1,000,000,000 micro-USD")]
    InvalidFundingAmount,
    #[msg("Funding intent already used with different parameters")]
    FundingReplayMismatch,
}
