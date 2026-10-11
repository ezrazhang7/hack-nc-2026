// End-to-end program tests in LiteSVM: protocol init, Nessie-style funding with replay guard,
// project + round creation, subscriptions, pro-rata settlement, refunds, cancellation,
// withdrawals, and the non-transferable receipt. Amounts are micro-USD.

use {
    anchor_lang::{
        prelude::{Clock, Pubkey},
        solana_program::{instruction::Instruction, system_program},
        AccountDeserialize, InstructionData, ToAccountMetas,
    },
    anchor_spl::{
        associated_token::{self, get_associated_token_address_with_program_id},
        token_2022::spl_token_2022::{
            self,
            extension::{BaseStateWithExtensions, ExtensionType, StateWithExtensions},
            state::{Account as TokenAccountState, Mint as MintState},
        },
        token_2022_extensions::spl_token_metadata_interface::state::TokenMetadata,
    },
    litesvm::LiteSVM,
    prospecto::{
        accounts as acc, instruction as ix, InitializeProtocolArgs, OpenRoundArgs, Round, RoundStatus,
        Subscription,
    },
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_program_option::COption,
    solana_program_pack::Pack,
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
};

const USD: u64 = 1_000_000;
const DAY: i64 = 86_400;
const TOKEN_2022: Pubkey = spl_token_2022::ID;

struct Env {
    svm: LiteSVM,
    admin: Keypair,
    relayer: Keypair,
    founder: Keypair,
    payment_mint: Pubkey,
    config: Pubkey,
    protocol_fee_vault: Pubkey,
}

fn pda(seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, &prospecto::id()).0
}

fn send(svm: &mut LiteSVM, ixs: &[Instruction], payer: &Keypair, signers: &[&Keypair]) -> Result<(), String> {
    svm.expire_blockhash();
    let msg = Message::new_with_blockhash(ixs, Some(&payer.pubkey()), &svm.latest_blockhash());
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), signers).unwrap();
    svm.send_transaction(tx).map(|_| ()).map_err(|e| format!("{:?}\n{}", e.err, e.meta.logs.join("\n")))
}

fn expect_err(result: Result<(), String>, needle: &str) {
    let err = result.expect_err(&format!("expected failure containing {needle}"));
    assert!(err.contains(needle), "expected {needle}, got:\n{err}");
}

fn read<T: AccountDeserialize>(svm: &LiteSVM, key: &Pubkey) -> T {
    let account = svm.get_account(key).unwrap();
    T::try_deserialize(&mut account.data.as_slice()).unwrap()
}

fn balance(svm: &LiteSVM, token_account: &Pubkey) -> u64 {
    let account = svm.get_account(token_account).unwrap();
    StateWithExtensions::<TokenAccountState>::unpack(&account.data).unwrap().base.amount
}

fn ata(owner: &Pubkey, mint: &Pubkey) -> Pubkey {
    get_associated_token_address_with_program_id(owner, mint, &TOKEN_2022)
}

fn set_clock(svm: &mut LiteSVM, unix_timestamp: i64) {
    let mut clock: Clock = svm.get_sysvar();
    clock.unix_timestamp = unix_timestamp;
    svm.set_sysvar(&clock);
}

fn now(svm: &LiteSVM) -> i64 {
    svm.get_sysvar::<Clock>().unix_timestamp
}

fn setup() -> Env {
    let mut svm = LiteSVM::new();
    let program_id = prospecto::id();
    svm.add_program(program_id, include_bytes!("../../../target/deploy/prospecto.so")).unwrap();
    set_clock(&mut svm, 1_800_000_000);

    let (admin, relayer, founder) = (Keypair::new(), Keypair::new(), Keypair::new());
    for k in [&admin, &relayer, &founder] {
        svm.airdrop(&k.pubkey(), 100_000_000_000).unwrap();
    }

    // LiteSVM deploys with no upgrade authority; make `admin` the upgrade authority, as on Devnet.
    let program_data = Pubkey::find_program_address(&[program_id.as_ref()], &solana_sdk_ids::bpf_loader_upgradeable::ID).0;
    let mut account = svm.get_account(&program_data).unwrap();
    account.data[12] = 1;
    account.data[13..45].copy_from_slice(admin.pubkey().as_ref());
    svm.set_account(program_data, account).unwrap();

    // Mock USDC: Token-2022, 6 decimals, relayer as mint authority (devnet-setup does the same).
    let payment_mint = Pubkey::new_unique();
    let mut data = vec![0u8; MintState::LEN];
    MintState {
        mint_authority: COption::Some(relayer.pubkey()),
        supply: 0,
        decimals: 6,
        is_initialized: true,
        freeze_authority: COption::None,
    }
    .pack_into_slice(&mut data);
    svm.set_account(
        payment_mint,
        solana_account::Account {
            lamports: svm.minimum_balance_for_rent_exemption(data.len()),
            data,
            owner: TOKEN_2022,
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();

    let config = pda(&[b"config"]);
    let protocol_fee_vault = pda(&[b"protocol_fee_vault"]);
    let init = |signer: &Keypair| {
        Instruction::new_with_bytes(
            program_id,
            &ix::InitializeProtocol {
                args: InitializeProtocolArgs {
                    relayer: relayer.pubkey(),
                    protocol_fee_bps: 100,
                    founder_share_bps: 4000,
                    max_units_per_round: 200_000,
                    min_round_seconds: DAY,
                    max_round_seconds: 30 * DAY,
                },
            }
            .data(),
            acc::InitializeProtocol {
                admin: signer.pubkey(),
                config,
                payment_mint,
                protocol_fee_vault,
                program: program_id,
                program_data,
                token_program: TOKEN_2022,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )
    };
    let intruder = Keypair::new();
    svm.airdrop(&intruder.pubkey(), 1_000_000_000).unwrap();
    expect_err(send(&mut svm, &[init(&intruder)], &intruder, &[&intruder]), "NotUpgradeAuthority");
    send(&mut svm, &[init(&admin)], &admin, &[&admin]).unwrap();

    Env { svm, admin, relayer, founder, payment_mint, config, protocol_fee_vault }
}

impl Env {
    fn fund_ix(&self, intent: [u8; 16], wallet: &Pubkey, amount: u64, proof: [u8; 32]) -> Instruction {
        Instruction::new_with_bytes(
            prospecto::id(),
            &ix::FundMockUsdc { intent_id: intent, amount, bank_proof_hash: proof }.data(),
            acc::FundMockUsdc {
                relayer: self.relayer.pubkey(),
                config: self.config,
                funding_receipt: pda(&[b"funding", &intent]),
                wallet: *wallet,
                wallet_payment_account: ata(wallet, &self.payment_mint),
                payment_mint: self.payment_mint,
                token_program: TOKEN_2022,
                associated_token_program: associated_token::ID,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )
    }

    fn fund(&mut self, intent: [u8; 16], wallet: &Pubkey, amount: u64) -> Result<(), String> {
        let i = self.fund_ix(intent, wallet, amount, [7; 32]);
        let relayer = self.relayer.insecure_clone();
        send(&mut self.svm, &[i], &relayer, &[&relayer])
    }

    fn project_ixs(&self, project_id: [u8; 16], round: &OpenRoundArgs, create: bool) -> Vec<Instruction> {
        let project = pda(&[b"project", &project_id]);
        let round_pda = pda(&[b"round", project.as_ref(), &round.round_number.to_le_bytes()]);
        let mut ixs = vec![];
        if create {
            ixs.push(Instruction::new_with_bytes(
                prospecto::id(),
                &ix::CreateProject { project_id }.data(),
                acc::CreateProject {
                    relayer: self.relayer.pubkey(),
                    founder: self.founder.pubkey(),
                    config: self.config,
                    project,
                    receipt_mint: pda(&[b"receipt_mint", project.as_ref()]),
                    project_vault: pda(&[b"project_vault", project.as_ref()]),
                    founder_reward_vault: pda(&[b"founder_reward_vault", project.as_ref()]),
                    payment_mint: self.payment_mint,
                    token_program: TOKEN_2022,
                    system_program: system_program::ID,
                }
                .to_account_metas(None),
            ));
        }
        ixs.push(Instruction::new_with_bytes(
            prospecto::id(),
            &ix::OpenRound { args: round.clone() }.data(),
            acc::OpenRound {
                relayer: self.relayer.pubkey(),
                founder: self.founder.pubkey(),
                config: self.config,
                project,
                round: round_pda,
                round_vault: pda(&[b"round_vault", round_pda.as_ref()]),
                payment_mint: self.payment_mint,
                token_program: TOKEN_2022,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        ));
        ixs
    }

    fn open(&mut self, project_id: [u8; 16], round: &OpenRoundArgs, create: bool) -> Result<(), String> {
        let ixs = self.project_ixs(project_id, round, create);
        let (relayer, founder) = (self.relayer.insecure_clone(), self.founder.insecure_clone());
        send(&mut self.svm, &ixs, &relayer, &[&relayer, &founder])
    }

    fn subscribe(&mut self, project: &Pubkey, round: &Pubkey, buyer: &Keypair, gross: u64) -> Result<(), String> {
        let i = Instruction::new_with_bytes(
            prospecto::id(),
            &ix::Subscribe { gross_amount: gross }.data(),
            acc::Subscribe {
                relayer: self.relayer.pubkey(),
                buyer: buyer.pubkey(),
                config: self.config,
                project: *project,
                round: *round,
                subscription: pda(&[b"subscription", round.as_ref(), buyer.pubkey().as_ref()]),
                buyer_payment_account: ata(&buyer.pubkey(), &self.payment_mint),
                round_vault: pda(&[b"round_vault", round.as_ref()]),
                payment_mint: self.payment_mint,
                token_program: TOKEN_2022,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        );
        let relayer = self.relayer.insecure_clone();
        send(&mut self.svm, &[i], &relayer, &[&relayer, buyer])
    }

    fn crank(&mut self, i: Instruction) -> Result<(), String> {
        let payer = self.admin.insecure_clone();
        send(&mut self.svm, &[i], &payer, &[&payer])
    }

    fn finalize_ix(round: &Pubkey) -> Instruction {
        Instruction::new_with_bytes(
            prospecto::id(),
            &ix::FinalizeRound {}.data(),
            acc::FinalizeRound { round: *round }.to_account_metas(None),
        )
    }

    fn mint_ix(&self, project: &Pubkey, round: &Pubkey, buyer: &Pubkey) -> Instruction {
        let receipt_mint = pda(&[b"receipt_mint", project.as_ref()]);
        Instruction::new_with_bytes(
            prospecto::id(),
            &ix::MintFinalAllocation {}.data(),
            acc::MintFinalAllocation {
                payer: self.admin.pubkey(),
                config: self.config,
                project: *project,
                round: *round,
                subscription: pda(&[b"subscription", round.as_ref(), buyer.as_ref()]),
                buyer: *buyer,
                receipt_mint,
                buyer_receipt_account: ata(buyer, &receipt_mint),
                round_vault: pda(&[b"round_vault", round.as_ref()]),
                project_vault: pda(&[b"project_vault", project.as_ref()]),
                founder_reward_vault: pda(&[b"founder_reward_vault", project.as_ref()]),
                protocol_fee_vault: self.protocol_fee_vault,
                payment_mint: self.payment_mint,
                token_program: TOKEN_2022,
                associated_token_program: associated_token::ID,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )
    }

    fn refund_ix(&self, round: &Pubkey, buyer: &Pubkey) -> Instruction {
        Instruction::new_with_bytes(
            prospecto::id(),
            &ix::RefundExcess {}.data(),
            acc::RefundExcess {
                config: self.config,
                round: *round,
                subscription: pda(&[b"subscription", round.as_ref(), buyer.as_ref()]),
                buyer_payment_account: ata(buyer, &self.payment_mint),
                round_vault: pda(&[b"round_vault", round.as_ref()]),
                payment_mint: self.payment_mint,
                token_program: TOKEN_2022,
            }
            .to_account_metas(None),
        )
    }

    fn cancel_ix(&self, authority: &Pubkey, project: &Pubkey, round: &Pubkey) -> Instruction {
        Instruction::new_with_bytes(
            prospecto::id(),
            &ix::CancelAndRefund {}.data(),
            acc::CancelAndRefund { authority: *authority, config: self.config, project: *project, round: *round }
                .to_account_metas(None),
        )
    }

    fn withdraw_ix(&self, project: &Pubkey, vault: &Pubkey, rewards: bool) -> Instruction {
        let data = if rewards { ix::WithdrawFounderRewards {}.data() } else { ix::WithdrawProjectProceeds {}.data() };
        Instruction::new_with_bytes(
            prospecto::id(),
            &data,
            acc::Withdraw {
                founder: self.founder.pubkey(),
                config: self.config,
                project: *project,
                vault: *vault,
                founder_payment_account: ata(&self.founder.pubkey(), &self.payment_mint),
                payment_mint: self.payment_mint,
                token_program: TOKEN_2022,
            }
            .to_account_metas(None),
        )
    }
}

fn round_args(svm: &LiteSVM, round_number: u16, max_units: u64, price: u64, max_sub: u64) -> OpenRoundArgs {
    let opens_at = now(svm);
    OpenRoundArgs {
        round_number,
        opens_at,
        closes_at: opens_at + 14 * DAY,
        unit_price_micro_usd: price,
        max_units,
        target_amount: max_units * price,
        max_subscription_amount: max_sub,
        model_hash: [1; 32],
        evidence_root: [2; 32],
    }
}

#[test]
fn funding_is_minted_at_most_once_per_intent() {
    let mut env = setup();
    let wallet = Keypair::new().pubkey();
    let account = ata(&wallet, &env.payment_mint);

    env.fund([9; 16], &wallet, 100 * USD).unwrap();
    assert_eq!(balance(&env.svm, &account), 100 * USD);

    // Matching replay (a retried saga step) succeeds without minting again.
    env.fund([9; 16], &wallet, 100 * USD).unwrap();
    assert_eq!(balance(&env.svm, &account), 100 * USD);

    // Same intent with a different amount or proof is refused.
    expect_err(env.fund([9; 16], &wallet, 200 * USD), "FundingReplayMismatch");
    let i = env.fund_ix([9; 16], &wallet, 100 * USD, [8; 32]);
    let relayer = env.relayer.insecure_clone();
    expect_err(send(&mut env.svm, &[i], &relayer, &[&relayer]), "FundingReplayMismatch");

    // Limits (NESSIE_PURCHASE_FLOW §6 step D).
    expect_err(env.fund([10; 16], &wallet, 0), "InvalidFundingAmount");
    expect_err(env.fund([11; 16], &wallet, 1_000 * USD + 1), "InvalidFundingAmount");

    // Only the configured relayer can fund.
    let mut i = env.fund_ix([12; 16], &wallet, USD, [7; 32]);
    let stranger = Keypair::new();
    env.svm.airdrop(&stranger.pubkey(), 1_000_000_000).unwrap();
    i.accounts[0].pubkey = stranger.pubkey();
    expect_err(send(&mut env.svm, &[i], &stranger, &[&stranger]), "ConstraintHasOne");
    assert_eq!(balance(&env.svm, &account), 100 * USD);
}

#[test]
fn oversubscribed_round_settles_pro_rata() {
    let mut env = setup();
    let project_id = [0xab; 16];
    let project = pda(&[b"project", &project_id]);
    let receipt_mint = pda(&[b"receipt_mint", project.as_ref()]);

    // $150 target at $1/unit, $100 per-person cap; three buyers commit $100 each.
    let args = round_args(&env.svm, 1, 150, USD, 100 * USD);
    let round = pda(&[b"round", project.as_ref(), &1u16.to_le_bytes()]);

    // open_round validation mirrors backend/src/rounds/service.ts.
    let mut bad = args.clone();
    bad.target_amount += 1;
    expect_err(env.open(project_id, &bad, true), "TargetMismatch");
    let mut bad = args.clone();
    bad.closes_at = bad.opens_at + 31 * DAY;
    expect_err(env.open(project_id, &bad, true), "InvalidRoundWindow");
    env.open(project_id, &args, true).unwrap();

    // The receipt mint is Token-2022 NonTransferable, 0 decimals, minted only by the Project PDA.
    let mint_account = env.svm.get_account(&receipt_mint).unwrap();
    let mint = StateWithExtensions::<MintState>::unpack(&mint_account.data).unwrap();
    assert_eq!(mint.base.decimals, 0);
    assert_eq!(mint.base.mint_authority, COption::Some(project));
    assert_eq!(mint.base.freeze_authority, COption::None);
    assert!(mint.get_extension_types().unwrap().contains(&ExtensionType::NonTransferable));
    let metadata = mint.get_variable_len_extension::<TokenMetadata>().unwrap();
    assert_eq!(metadata.name, "Prospecto Devnet Receipt (not equity)");

    let buyers: Vec<Keypair> = (0..3).map(|_| Keypair::new()).collect();
    for (i, b) in buyers.iter().enumerate() {
        env.fund([i as u8 + 1; 16], &b.pubkey(), 100 * USD).unwrap();
    }
    env.fund([0xf0; 16], &env.founder.pubkey(), 10 * USD).unwrap();

    // The founder cannot buy their own round; buyers cannot exceed the cap or subscribe twice.
    let founder = env.founder.insecure_clone();
    expect_err(env.subscribe(&project, &round, &founder, 5 * USD), "FounderSelfSubscription");
    expect_err(env.subscribe(&project, &round, &buyers[0], 100 * USD + 1), "InvalidGrossAmount");
    expect_err(env.subscribe(&project, &round, &buyers[0], USD - 1), "InvalidGrossAmount");
    for b in &buyers {
        env.subscribe(&project, &round, b, 100 * USD).unwrap();
    }
    env.fund([0x20; 16], &buyers[0].pubkey(), 10 * USD).unwrap();
    expect_err(env.subscribe(&project, &round, &buyers[0], USD), "already in use");

    let r: Round = read(&env.svm, &round);
    assert_eq!((r.total_committed, r.subscriber_count), (300 * USD, 3));

    // Settlement waits for closes_at; nothing mints before finalization.
    expect_err(env.crank(Env::finalize_ix(&round)), "RoundStillOpen");
    let i = env.mint_ix(&project, &round, &buyers[0].pubkey());
    expect_err(env.crank(i), "RoundNotFinalized");
    set_clock(&mut env.svm, args.closes_at);
    expect_err(env.subscribe(&project, &round, &buyers[1], USD), "already in use");
    let late = Keypair::new();
    env.fund([0x30; 16], &late.pubkey(), 10 * USD).unwrap();
    expect_err(env.subscribe(&project, &round, &late, USD), "RoundNotOpen");
    env.crank(Env::finalize_ix(&round)).unwrap();
    let r: Round = read(&env.svm, &round);
    assert_eq!((r.status, r.filled), (RoundStatus::Finalized, true));

    for b in &buyers {
        let i = env.mint_ix(&project, &round, &b.pubkey());
        env.crank(i).unwrap();
        let i = env.refund_ix(&round, &b.pubkey());
        env.crank(i).unwrap();
    }
    let i = env.mint_ix(&project, &round, &buyers[0].pubkey());
    expect_err(env.crank(i), "AlreadyMinted");
    let i = env.refund_ix(&round, &buyers[0].pubkey());
    expect_err(env.crank(i), "AlreadyRefunded");

    // $300 into $150: each accepts $50, fee $0.50 ($0.20 founder / $0.30 platform), proceeds $49.50,
    // 49 units, $0.50 dust kept in proceeds, $50 refunded (BACKEND_STACK §6.3).
    for (i, b) in buyers.iter().enumerate() {
        let s: Subscription = read(&env.svm, &pda(&[b"subscription", round.as_ref(), b.pubkey().as_ref()]));
        assert_eq!((s.accepted_amount, s.units, s.refunded_amount), (50 * USD, 49, 50 * USD));
        assert_eq!(balance(&env.svm, &ata(&b.pubkey(), &receipt_mint)), 49);
        let extra = if i == 0 { 10 * USD } else { 0 };
        assert_eq!(balance(&env.svm, &ata(&b.pubkey(), &env.payment_mint)), 50 * USD + extra);
    }
    let project_vault = pda(&[b"project_vault", project.as_ref()]);
    let reward_vault = pda(&[b"founder_reward_vault", project.as_ref()]);
    assert_eq!(balance(&env.svm, &project_vault), 3 * 49_500_000);
    assert_eq!(balance(&env.svm, &reward_vault), 3 * 200_000);
    assert_eq!(balance(&env.svm, &env.protocol_fee_vault), 3 * 300_000);
    assert_eq!(balance(&env.svm, &pda(&[b"round_vault", round.as_ref()])), 0);
    let r: Round = read(&env.svm, &round);
    assert_eq!((r.total_accepted, r.total_units_minted), (150 * USD, 147));

    // Receipts cannot be transferred (M§7.1 / demo step "receipt transfer fails").
    let transfer = spl_token_2022::instruction::transfer_checked(
        &TOKEN_2022,
        &ata(&buyers[0].pubkey(), &receipt_mint),
        &receipt_mint,
        &ata(&buyers[1].pubkey(), &receipt_mint),
        &buyers[0].pubkey(),
        &[],
        1,
        0,
    )
    .unwrap();
    env.svm.airdrop(&buyers[0].pubkey(), 1_000_000_000).unwrap();
    expect_err(send(&mut env.svm, &[transfer], &buyers[0], &[&buyers[0]]), "Transfer is disabled for this mint");

    // A finalized round cannot be cancelled.
    let i = env.cancel_ix(&env.founder.pubkey(), &project, &round);
    expect_err(send(&mut env.svm, &[i], &founder, &[&founder]), "RoundNotCancellable");

    // Founder withdrawals move each vault's full balance to the founder's own account, once.
    let founder_account = ata(&founder.pubkey(), &env.payment_mint);
    let i = env.withdraw_ix(&project, &project_vault, false);
    send(&mut env.svm, &[i], &founder, &[&founder]).unwrap();
    let i = env.withdraw_ix(&project, &reward_vault, true);
    send(&mut env.svm, &[i], &founder, &[&founder]).unwrap();
    assert_eq!(balance(&env.svm, &founder_account), 10 * USD + 3 * 49_500_000 + 3 * 200_000);
    let i = env.withdraw_ix(&project, &project_vault, false);
    expect_err(send(&mut env.svm, &[i], &founder, &[&founder]), "NothingToWithdraw");
    // Each withdrawal is bound to its own vault.
    let i = env.withdraw_ix(&project, &project_vault, true);
    expect_err(send(&mut env.svm, &[i], &founder, &[&founder]), "RequireKeysEqViolated");
}

#[test]
fn cancelled_round_refunds_full_gross_and_mints_nothing() {
    let mut env = setup();
    let project_id = [0xcd; 16];
    let project = pda(&[b"project", &project_id]);
    let args = round_args(&env.svm, 1, 1_000, USD, 100 * USD);
    let round = pda(&[b"round", project.as_ref(), &1u16.to_le_bytes()]);
    env.open(project_id, &args, true).unwrap();

    let buyer = Keypair::new();
    env.fund([1; 16], &buyer.pubkey(), 100 * USD).unwrap();
    env.subscribe(&project, &round, &buyer, 40 * USD).unwrap();

    // Refunds are only for finalized or cancelled rounds; only the founder or admin may cancel.
    let i = env.refund_ix(&round, &buyer.pubkey());
    expect_err(env.crank(i), "RoundNotRefundable");
    let stranger = Keypair::new();
    env.svm.airdrop(&stranger.pubkey(), 1_000_000_000).unwrap();
    let i = env.cancel_ix(&stranger.pubkey(), &project, &round);
    expect_err(send(&mut env.svm, &[i], &stranger, &[&stranger]), "NotFounderOrAdmin");
    let i = env.cancel_ix(&env.admin.pubkey(), &project, &round);
    env.crank(i).unwrap();
    assert_eq!(read::<Round>(&env.svm, &round).status, RoundStatus::Refunding);

    let i = env.mint_ix(&project, &round, &buyer.pubkey());
    expect_err(env.crank(i), "RoundNotFinalized");
    let i = env.refund_ix(&round, &buyer.pubkey());
    env.crank(i).unwrap();
    assert_eq!(balance(&env.svm, &ata(&buyer.pubkey(), &env.payment_mint)), 100 * USD);
    expect_err(env.subscribe(&project, &round, &buyer, USD), "already in use");

    // A second round on the same project needs no create_project; an empty round expires.
    let args2 = round_args(&env.svm, 2, 1_000, USD, 100 * USD);
    let round2 = pda(&[b"round", project.as_ref(), &2u16.to_le_bytes()]);
    env.open(project_id, &args2, false).unwrap();
    set_clock(&mut env.svm, args2.closes_at);
    env.crank(Env::finalize_ix(&round2)).unwrap();
    assert_eq!(read::<Round>(&env.svm, &round2).status, RoundStatus::Expired);
}

#[test]
fn only_the_founder_opens_rounds() {
    let mut env = setup();
    let project_id = [0xee; 16];
    env.open(project_id, &round_args(&env.svm, 1, 100, USD, 10 * USD), true).unwrap();
    let project = pda(&[b"project", &project_id]);
    let args = round_args(&env.svm, 2, 100, USD, 10 * USD);
    let mut ixs = env.project_ixs(project_id, &args, false);
    let impostor = Keypair::new();
    ixs[0].accounts[1].pubkey = impostor.pubkey();
    let relayer = env.relayer.insecure_clone();
    expect_err(send(&mut env.svm, &ixs, &relayer, &[&relayer, &impostor]), "NotFounder");
    assert!(env.svm.get_account(&pda(&[b"round", project.as_ref(), &2u16.to_le_bytes()])).is_none());
    let _ = &env.admin;
}
