use anchor_lang::prelude::*;

// PDA seeds (BACKEND_STACK §6.1). The backend derives the same addresses (rounds/service.ts `seeds`).
#[constant]
pub const CONFIG_SEED: &[u8] = b"config";
#[constant]
pub const PROJECT_SEED: &[u8] = b"project";
#[constant]
pub const RECEIPT_MINT_SEED: &[u8] = b"receipt_mint";
#[constant]
pub const PROJECT_VAULT_SEED: &[u8] = b"project_vault";
#[constant]
pub const FOUNDER_REWARD_VAULT_SEED: &[u8] = b"founder_reward_vault";
#[constant]
pub const PROTOCOL_FEE_VAULT_SEED: &[u8] = b"protocol_fee_vault";
#[constant]
pub const ROUND_SEED: &[u8] = b"round";
#[constant]
pub const ROUND_VAULT_SEED: &[u8] = b"round_vault";
#[constant]
pub const SUBSCRIPTION_SEED: &[u8] = b"subscription";
#[constant]
pub const FUNDING_SEED: &[u8] = b"funding";

pub const BPS_DENOMINATOR: u64 = 10_000;

/// Mock USDC uses 6 decimals, so one base unit is one micro-USD (BACKEND_STACK §6.3).
pub const PAYMENT_DECIMALS: u8 = 6;
/// Receipts count whole participation units.
pub const RECEIPT_DECIMALS: u8 = 0;

/// NESSIE_PURCHASE_FLOW §6 step D: one funding mint is at most $1,000.
pub const MAX_FUNDING_MICRO_USD: u64 = 1_000_000_000;

// Token-2022 metadata on every receipt mint (M§7.1): the wallet and explorer show what it is.
pub const RECEIPT_NAME: &str = "Prospecto Devnet Receipt (not equity)";
pub const RECEIPT_SYMBOL: &str = "PRCPT";
pub const RECEIPT_URI: &str = "";
