use anchor_lang::prelude::*;
use anchor_lang::solana_program::{program::{invoke, invoke_signed}, system_instruction};
use anchor_spl::{associated_token::AssociatedToken, token_2022::{self, Token2022}, token_interface::{Mint, TokenAccount}};
use anchor_spl::token_2022::spl_token_2022::{extension::ExtensionType, state::Mint as SplMint, instruction as token_ix};

// Devnet deployment (upgrade authority FsadR3sy…). Redeploying elsewhere must resync Anchor.toml and backend/idl/prospecto.json.
declare_id!("GRpwgGnAZkiynrTYyYPSfFUhYVUjtFg3Ad8KVdLrTe6S");
const MAX_FUNDING: u64 = 1_000_000_000;
const MAX_UNITS: u64 = 200_000;

#[program]
pub mod prospecto {
    use super::*;
    pub fn initialize_protocol(ctx: Context<InitializeProtocol>) -> Result<()> {
        let mint = &ctx.accounts.payment_mint;
        require!(mint.decimals == 6 && mint.freeze_authority.is_none() && mint.mint_authority == Some(ctx.accounts.relayer.key()).into(), ErrorCode::InvalidMint);
        require!(mint.to_account_info().data_len() == 82, ErrorCode::InvalidMint);
        ctx.accounts.config.set_inner(Config { admin:ctx.accounts.admin.key(), relayer:ctx.accounts.relayer.key(), payment_mint:mint.key(), protocol_fee_vault:ctx.accounts.protocol_fee_vault.key(), protocol_fee_bps:100, founder_share_bps:4000, paused:false, bump:ctx.bumps.config });
        Ok(())
    }
    pub fn set_paused(ctx:Context<Admin>, paused:bool)->Result<()> {ctx.accounts.config.paused=paused;Ok(())}
    pub fn create_project(ctx: Context<CreateProject>, project_id:[u8;16])->Result<()> {
        require!(!ctx.accounts.config.paused, ErrorCode::Paused);
        require!(ctx.accounts.founder.key()!=ctx.accounts.relayer.key(),ErrorCode::SelfParticipation);
        let p=ctx.accounts.project.key();
        let size=ExtensionType::try_calculate_account_len::<SplMint>(&[ExtensionType::NonTransferable])?;
        let bump=[ctx.bumps.receipt_mint]; let seeds:&[&[u8]]=&[b"receipt_mint",p.as_ref(),&bump];
        let mint=ctx.accounts.receipt_mint.to_account_info(); let payer=ctx.accounts.relayer.to_account_info();
        // Extension initialization must precede the base mint initialization. Authority is the project PDA.
        invoke_signed(&system_instruction::create_account(&payer.key(),&mint.key(),Rent::get()?.minimum_balance(size),size as u64,&Token2022::id()), &[payer,mint.clone(),ctx.accounts.system_program.to_account_info()], &[seeds])?;
        invoke(&token_ix::initialize_non_transferable_mint(&Token2022::id(),&mint.key())?, &[mint.clone(),ctx.accounts.token_program.to_account_info()])?;
        invoke(&token_ix::initialize_mint2(&Token2022::id(),&mint.key(),&p,None,0)?, &[mint,ctx.accounts.token_program.to_account_info()])?;
        ctx.accounts.project.set_inner(Project {project_id,founder_wallet:ctx.accounts.founder.key(),receipt_mint:ctx.accounts.receipt_mint.key(),round_number:0,bump:ctx.bumps.project});
        emit!(ProjectCreated {project_id,project:p,founder_wallet:ctx.accounts.founder.key(),receipt_mint:ctx.accounts.receipt_mint.key()}); Ok(())
    }
    pub fn fund_mock_usdc(ctx:Context<Fund>,intent_id:[u8;16],amount:u64,bank_proof_hash:[u8;32])->Result<()> {
        require!(!ctx.accounts.config.paused,ErrorCode::Paused);
        require!(amount>0 && amount<=MAX_FUNDING && amount%1_000_000==0,ErrorCode::InvalidAmount);
        require!(bank_proof_hash != [0;32],ErrorCode::InvalidProof);
        let r=&mut ctx.accounts.funding_receipt;
        if r.funded {
            require!(r.intent_id==intent_id && r.wallet==ctx.accounts.wallet.key() && r.amount==amount && r.payment_mint==ctx.accounts.payment_mint.key() && r.bank_proof_hash==bank_proof_hash,ErrorCode::ReplayMismatch);
            return Ok(());
        }
        token_2022::mint_to(CpiContext::new(ctx.accounts.token_program.to_account_info(),token_2022::MintTo {mint:ctx.accounts.payment_mint.to_account_info(),to:ctx.accounts.destination.to_account_info(),authority:ctx.accounts.relayer.to_account_info()}),amount)?;
        r.set_inner(FundingReceipt {intent_id,wallet:ctx.accounts.wallet.key(),amount,payment_mint:ctx.accounts.payment_mint.key(),bank_proof_hash,funded:true});
        emit!(MockWalletFunded {intent_id,wallet:r.wallet,amount,bank_proof_hash}); Ok(())
    }
    #[allow(clippy::too_many_arguments)]
    pub fn open_round(ctx:Context<OpenRound>,round_number:u16,opens_at:i64,closes_at:i64,unit_price_micro_usd:u64,max_units:u64,target_amount:u64,max_subscription_amount:u64,model_hash:[u8;32],evidence_root:[u8;32])->Result<()> {
        require!(!ctx.accounts.config.paused,ErrorCode::Paused);
        require!(round_number==ctx.accounts.project.round_number.checked_add(1).ok_or(ErrorCode::Overflow)?,ErrorCode::InvalidRound);
        let duration=closes_at.checked_sub(opens_at).ok_or(ErrorCode::Overflow)?;
        require!((86400..=2592000).contains(&duration) && closes_at>Clock::get()?.unix_timestamp,ErrorCode::InvalidRound);
        require!(max_units>0 && max_units<=MAX_UNITS && unit_price_micro_usd>0 && target_amount<=i64::MAX as u64 && max_subscription_amount>=unit_price_micro_usd && max_subscription_amount<=target_amount,ErrorCode::InvalidAmount);
        require!(unit_price_micro_usd.checked_mul(max_units)==Some(target_amount),ErrorCode::InvalidAmount);
        ctx.accounts.round.set_inner(Round {project:ctx.accounts.project.key(),round_number,opens_at,closes_at,unit_price_micro_usd,max_units,target_amount,max_subscription_amount,model_hash,evidence_root,total_committed:0,total_accepted:0,total_units_minted:0,status:RoundStatus::Open,filled:false,bump:ctx.bumps.round});
        ctx.accounts.project.round_number=round_number;
        emit!(RoundOpened {round:ctx.accounts.round.key(),project:ctx.accounts.project.key(),receipt_mint:ctx.accounts.project.receipt_mint,round_number,opens_at,closes_at,unit_price_micro_usd,max_units,target_amount,max_subscription_amount,model_hash,evidence_root}); Ok(())
    }
    pub fn subscribe(ctx:Context<Subscribe>,gross_amount:u64)->Result<()> {
        let r=&mut ctx.accounts.round; let now=Clock::get()?.unix_timestamp;
        require!(!ctx.accounts.config.paused,ErrorCode::Paused);
        require!(r.status==RoundStatus::Open && now>=r.opens_at && now<r.closes_at,ErrorCode::RoundNotOpen);
        require!(ctx.accounts.buyer.key()!=ctx.accounts.project.founder_wallet,ErrorCode::SelfParticipation);
        require!(gross_amount>=r.unit_price_micro_usd && gross_amount<=r.max_subscription_amount,ErrorCode::InvalidAmount);
        let total=r.total_committed.checked_add(gross_amount).ok_or(ErrorCode::Overflow)?;
        require!(total<=i64::MAX as u64,ErrorCode::Overflow);
        token_2022::transfer_checked(CpiContext::new(ctx.accounts.token_program.to_account_info(),token_2022::TransferChecked {from:ctx.accounts.buyer_payment_account.to_account_info(),mint:ctx.accounts.payment_mint.to_account_info(),to:ctx.accounts.round_vault.to_account_info(),authority:ctx.accounts.buyer.to_account_info()}),gross_amount,6)?;
        r.total_committed=total;
        ctx.accounts.subscription.set_inner(Subscription {round:r.key(),buyer_wallet:ctx.accounts.buyer.key(),gross_amount,accepted_amount:0,units:0,refunded_amount:0,minted:false,refunded:false});
        emit!(SubscriptionAccepted {round:r.key(),buyer_wallet:ctx.accounts.buyer.key(),gross_amount,total_committed:total}); Ok(())
    }
    pub fn finalize_round(ctx:Context<FinalizeRound>)->Result<()> {
        let r=&mut ctx.accounts.round;
        if r.status!=RoundStatus::Open {return Ok(());}
        require!(Clock::get()?.unix_timestamp>=r.closes_at,ErrorCode::RoundNotClosed);
        r.status=if r.total_committed==0 {RoundStatus::Expired} else {RoundStatus::Finalized};r.filled=r.total_committed>=r.target_amount;
        emit!(RoundFinalized {round:r.key(),total_committed:r.total_committed,filled:r.filled}); Ok(())
    }
    pub fn mint_final_allocation(ctx:Context<Settle>)->Result<()> {
        let r=&mut ctx.accounts.round;let s=&mut ctx.accounts.subscription;
        require!(r.status!=RoundStatus::Open,ErrorCode::RoundNotClosed);
        if s.minted || r.status==RoundStatus::Refunding {return Ok(());}
        let a=allocation(s.gross_amount,r.total_committed,r.target_amount,r.unit_price_micro_usd,false)?;
        let accepted=r.total_accepted.checked_add(a.accepted).ok_or(ErrorCode::Overflow)?;
        let units=r.total_units_minted.checked_add(a.units).ok_or(ErrorCode::Overflow)?;
        require!(accepted<=r.target_amount && units<=r.max_units,ErrorCode::Overflow);
        let project_key=ctx.accounts.project.key();let number=r.round_number.to_le_bytes();let bump=[r.bump];let round_seeds:&[&[u8]]=&[b"round",project_key.as_ref(),&number,&bump];
        let source=ctx.accounts.round_vault.to_account_info();let authority=r.to_account_info();let mint=ctx.accounts.payment_mint.to_account_info();let program=ctx.accounts.token_program.to_account_info();
        for (destination,amount) in [(ctx.accounts.project_vault.to_account_info(),a.net),(ctx.accounts.founder_reward_vault.to_account_info(),a.reward),(ctx.accounts.protocol_fee_vault.to_account_info(),a.fee-a.reward)] {
            if amount>0 {pay(program.clone(),source.clone(),mint.clone(),destination,authority.clone(),round_seeds,amount)?;}
        }
        if a.units>0 {let b=[ctx.accounts.project.bump];let seeds:&[&[u8]]=&[b"project",&ctx.accounts.project.project_id,&b]; token_2022::mint_to(CpiContext::new_with_signer(program,token_2022::MintTo {mint:ctx.accounts.receipt_mint.to_account_info(),to:ctx.accounts.buyer_receipt_account.to_account_info(),authority:ctx.accounts.project.to_account_info()},&[seeds]),a.units)?;}
        s.accepted_amount=a.accepted;s.units=a.units;s.minted=true;r.total_accepted=accepted;r.total_units_minted=units;
        emit!(AllocationMinted {round:r.key(),buyer_wallet:s.buyer_wallet,accepted_amount:a.accepted,units:a.units,fee:a.fee,founder_reward:a.reward}); Ok(())
    }
    pub fn refund_excess(ctx:Context<Settle>)->Result<()> {
        let r=&ctx.accounts.round;let s=&mut ctx.accounts.subscription;
        require!(r.status!=RoundStatus::Open,ErrorCode::RoundNotClosed);
        if s.refunded {return Ok(());}
        let a=allocation(s.gross_amount,r.total_committed,r.target_amount,r.unit_price_micro_usd,r.status==RoundStatus::Refunding)?;
        if a.refund>0 {let p=r.project;let n=r.round_number.to_le_bytes();let b=[r.bump];let seeds:&[&[u8]]=&[b"round",p.as_ref(),&n,&b];pay(ctx.accounts.token_program.to_account_info(),ctx.accounts.round_vault.to_account_info(),ctx.accounts.payment_mint.to_account_info(),ctx.accounts.buyer_payment_account.to_account_info(),r.to_account_info(),seeds,a.refund)?;}
        s.refunded_amount=a.refund;s.refunded=true;
        emit!(ExcessRefunded {round:r.key(),buyer_wallet:s.buyer_wallet,amount:a.refund});Ok(())
    }
    pub fn cancel_and_refund(ctx:Context<Cancel>)->Result<()> {let r=&mut ctx.accounts.round;require!(r.status==RoundStatus::Open && r.total_accepted==0,ErrorCode::AlreadySettled);r.status=RoundStatus::Refunding;emit!(RoundCancelled {round:r.key()});Ok(())}
    pub fn withdraw_project_proceeds(ctx:Context<Withdraw>,amount:u64)->Result<()> {withdraw(ctx,amount,false)}
    pub fn withdraw_founder_rewards(ctx:Context<Withdraw>,amount:u64)->Result<()> {withdraw(ctx,amount,true)}
}

fn pay<'info>(program:AccountInfo<'info>,from:AccountInfo<'info>,mint:AccountInfo<'info>,to:AccountInfo<'info>,authority:AccountInfo<'info>,seeds:&[&[u8]],amount:u64)->Result<()> {
    token_2022::transfer_checked(CpiContext::new_with_signer(program,token_2022::TransferChecked {from,mint,to,authority},&[seeds]),amount,6)
}
fn withdraw(ctx:Context<Withdraw>,amount:u64,reward:bool)->Result<()> {require!(amount>0,ErrorCode::InvalidAmount);let p=&ctx.accounts.project;let b=[p.bump];let seeds:&[&[u8]]=&[b"project",&p.project_id,&b];let source=if reward {ctx.accounts.founder_reward_vault.to_account_info()} else {ctx.accounts.project_vault.to_account_info()};pay(ctx.accounts.token_program.to_account_info(),source,ctx.accounts.payment_mint.to_account_info(),ctx.accounts.destination.to_account_info(),p.to_account_info(),seeds,amount)?;if reward {emit!(FounderRewardsWithdrawn {project:p.key(),amount});} else {emit!(ProceedsWithdrawn {project:p.key(),amount});}Ok(())}
#[derive(Debug,PartialEq)]
pub struct Allocation {pub accepted:u64,pub fee:u64,pub reward:u64,pub net:u64,pub units:u64,pub refund:u64}
pub fn allocation(g:u64,total:u64,target:u64,price:u64,cancelled:bool)->Result<Allocation> {
    require!(price>0 && g<=total && total>0,ErrorCode::InvalidAmount);
    let accepted=if cancelled {0} else if total<=target {g} else {u64::try_from((g as u128).checked_mul(target as u128).ok_or(ErrorCode::Overflow)?/(total as u128)).map_err(|_|ErrorCode::Overflow)?};
    let fee=((accepted as u128)*100/10000) as u64;let reward=((fee as u128)*4000/10000) as u64;let net=accepted.checked_sub(fee).ok_or(ErrorCode::Overflow)?;
    Ok(Allocation {accepted,fee,reward,net,units:net/price,refund:g.checked_sub(accepted).ok_or(ErrorCode::Overflow)?})
}

#[derive(Accounts)]
pub struct InitializeProtocol<'info> {
    #[account(init,payer=admin,space=8+Config::INIT_SPACE,seeds=[b"config"],bump)] pub config:Box<Account<'info,Config>>,
    #[account(mut)] pub admin:Signer<'info>,
    pub relayer:Signer<'info>,
    #[account(constraint=program.programdata_address()?==Some(program_data.key()) @ ErrorCode::InvalidAuthority)] pub program:Program<'info,crate::program::Prospecto>,
    #[account(constraint=program_data.upgrade_authority_address==Some(admin.key()) @ ErrorCode::InvalidAuthority)] pub program_data:Box<Account<'info,ProgramData>>,
    #[account(mint::token_program=token_program)] pub payment_mint:Box<InterfaceAccount<'info,Mint>>,
    #[account(init,payer=admin,seeds=[b"protocol_fee_vault"],bump,token::mint=payment_mint,token::authority=config,token::token_program=token_program)] pub protocol_fee_vault:Box<InterfaceAccount<'info,TokenAccount>>,
    pub token_program:Program<'info,Token2022>,pub system_program:Program<'info,System>,
}
#[derive(Accounts)]
pub struct Admin<'info> {#[account(mut,seeds=[b"config"],bump=config.bump,has_one=admin)] pub config:Box<Account<'info,Config>>,pub admin:Signer<'info>}
#[derive(Accounts)]
#[instruction(project_id:[u8;16])]
pub struct CreateProject<'info> {
    #[account(seeds=[b"config"],bump=config.bump,has_one=relayer,has_one=payment_mint)] pub config:Box<Account<'info,Config>>,
    #[account(init,payer=relayer,space=8+Project::INIT_SPACE,seeds=[b"project",project_id.as_ref()],bump)] pub project:Box<Account<'info,Project>>,
    /// CHECK: canonical PDA, created and initialized as a NonTransferable Token-2022 mint in the handler.
    #[account(mut,seeds=[b"receipt_mint",project.key().as_ref()],bump)] pub receipt_mint:UncheckedAccount<'info>,
    #[account(init,payer=relayer,seeds=[b"project_vault",project.key().as_ref()],bump,token::mint=payment_mint,token::authority=project,token::token_program=token_program)] pub project_vault:Box<InterfaceAccount<'info,TokenAccount>>,
    #[account(init,payer=relayer,seeds=[b"founder_reward_vault",project.key().as_ref()],bump,token::mint=payment_mint,token::authority=project,token::token_program=token_program)] pub founder_reward_vault:Box<InterfaceAccount<'info,TokenAccount>>,
    pub founder:Signer<'info>,#[account(mut)] pub relayer:Signer<'info>,#[account(mint::token_program=token_program)] pub payment_mint:Box<InterfaceAccount<'info,Mint>>,
    pub token_program:Program<'info,Token2022>,pub associated_token_program:Program<'info,AssociatedToken>,pub system_program:Program<'info,System>,
}
#[derive(Accounts)]
#[instruction(intent_id:[u8;16])]
pub struct Fund<'info> {
    #[account(seeds=[b"config"],bump=config.bump,has_one=relayer,has_one=payment_mint)] pub config:Box<Account<'info,Config>>,
    #[account(init_if_needed,payer=relayer,space=8+FundingReceipt::INIT_SPACE,seeds=[b"funding",intent_id.as_ref()],bump)] pub funding_receipt:Box<Account<'info,FundingReceipt>>,
    /// CHECK: recipient only; token account constraint and immutable receipt bind this key.
    pub wallet:UncheckedAccount<'info>,
    #[account(mut,associated_token::mint=payment_mint,associated_token::authority=wallet,associated_token::token_program=token_program)] pub destination:Box<InterfaceAccount<'info,TokenAccount>>,
    #[account(mut,mint::token_program=token_program,mint::authority=relayer,mint::decimals=6)] pub payment_mint:Box<InterfaceAccount<'info,Mint>>,
    #[account(mut)] pub relayer:Signer<'info>,pub token_program:Program<'info,Token2022>,pub system_program:Program<'info,System>,
}
#[derive(Accounts)]
#[instruction(round_number:u16)]
pub struct OpenRound<'info> {
    #[account(seeds=[b"config"],bump=config.bump,has_one=relayer,has_one=payment_mint)] pub config:Box<Account<'info,Config>>,
    #[account(mut,seeds=[b"project",project.project_id.as_ref()],bump=project.bump,constraint=project.founder_wallet==founder.key() @ ErrorCode::InvalidAuthority)] pub project:Box<Account<'info,Project>>,
    #[account(init,payer=relayer,space=8+Round::INIT_SPACE,seeds=[b"round",project.key().as_ref(),&round_number.to_le_bytes()],bump)] pub round:Box<Account<'info,Round>>,
    #[account(init,payer=relayer,seeds=[b"round_vault",round.key().as_ref()],bump,token::mint=payment_mint,token::authority=round,token::token_program=token_program)] pub round_vault:Box<InterfaceAccount<'info,TokenAccount>>,
    pub founder:Signer<'info>,#[account(mut)] pub relayer:Signer<'info>,#[account(mint::token_program=token_program)] pub payment_mint:Box<InterfaceAccount<'info,Mint>>,pub token_program:Program<'info,Token2022>,pub system_program:Program<'info,System>,
}
#[derive(Accounts)]
pub struct Subscribe<'info> {
    #[account(seeds=[b"config"],bump=config.bump,has_one=relayer,has_one=payment_mint)] pub config:Box<Account<'info,Config>>,
    #[account(seeds=[b"project",project.project_id.as_ref()],bump=project.bump)] pub project:Box<Account<'info,Project>>,
    #[account(mut,seeds=[b"round",project.key().as_ref(),&round.round_number.to_le_bytes()],bump=round.bump,has_one=project)] pub round:Box<Account<'info,Round>>,
    #[account(init,payer=relayer,space=8+Subscription::INIT_SPACE,seeds=[b"subscription",round.key().as_ref(),buyer.key().as_ref()],bump)] pub subscription:Box<Account<'info,Subscription>>,
    pub buyer:Signer<'info>,#[account(mut)] pub relayer:Signer<'info>,#[account(mint::token_program=token_program)] pub payment_mint:Box<InterfaceAccount<'info,Mint>>,
    #[account(mut,associated_token::mint=payment_mint,associated_token::authority=buyer,associated_token::token_program=token_program)] pub buyer_payment_account:Box<InterfaceAccount<'info,TokenAccount>>,
    #[account(mut,seeds=[b"round_vault",round.key().as_ref()],bump,token::mint=payment_mint,token::authority=round,token::token_program=token_program)] pub round_vault:Box<InterfaceAccount<'info,TokenAccount>>,
    pub token_program:Program<'info,Token2022>,pub system_program:Program<'info,System>,
}
#[derive(Accounts)]
pub struct FinalizeRound<'info> {#[account(mut,seeds=[b"round",round.project.as_ref(),&round.round_number.to_le_bytes()],bump=round.bump)] pub round:Box<Account<'info,Round>>}
#[derive(Accounts)]
pub struct Settle<'info> {
    #[account(seeds=[b"config"],bump=config.bump,has_one=payment_mint,has_one=protocol_fee_vault,has_one=relayer)] pub config:Box<Account<'info,Config>>,
    #[account(seeds=[b"project",project.project_id.as_ref()],bump=project.bump,has_one=receipt_mint)] pub project:Box<Account<'info,Project>>,
    #[account(mut,seeds=[b"round",project.key().as_ref(),&round.round_number.to_le_bytes()],bump=round.bump,has_one=project)] pub round:Box<Account<'info,Round>>,
    #[account(mut,seeds=[b"subscription",round.key().as_ref(),buyer.key().as_ref()],bump,has_one=round,constraint=subscription.buyer_wallet==buyer.key() @ ErrorCode::InvalidAuthority)] pub subscription:Box<Account<'info,Subscription>>,
    /// CHECK: subscription binds buyer; only receives tokens and does not sign the crank.
    pub buyer:UncheckedAccount<'info>,
    #[account(mut,mint::token_program=token_program,mint::authority=project,mint::decimals=0)] pub receipt_mint:Box<InterfaceAccount<'info,Mint>>,
    #[account(init_if_needed,payer=relayer,associated_token::mint=receipt_mint,associated_token::authority=buyer,associated_token::token_program=token_program)] pub buyer_receipt_account:Box<InterfaceAccount<'info,TokenAccount>>,
    #[account(init_if_needed,payer=relayer,associated_token::mint=payment_mint,associated_token::authority=buyer,associated_token::token_program=token_program)] pub buyer_payment_account:Box<InterfaceAccount<'info,TokenAccount>>,
    #[account(mint::token_program=token_program)] pub payment_mint:Box<InterfaceAccount<'info,Mint>>,
    #[account(mut,seeds=[b"round_vault",round.key().as_ref()],bump,token::mint=payment_mint,token::authority=round,token::token_program=token_program)] pub round_vault:Box<InterfaceAccount<'info,TokenAccount>>,
    #[account(mut,seeds=[b"project_vault",project.key().as_ref()],bump,token::mint=payment_mint,token::authority=project,token::token_program=token_program)] pub project_vault:Box<InterfaceAccount<'info,TokenAccount>>,
    #[account(mut,seeds=[b"founder_reward_vault",project.key().as_ref()],bump,token::mint=payment_mint,token::authority=project,token::token_program=token_program)] pub founder_reward_vault:Box<InterfaceAccount<'info,TokenAccount>>,
    #[account(mut,token::mint=payment_mint,token::authority=config,token::token_program=token_program)] pub protocol_fee_vault:Box<InterfaceAccount<'info,TokenAccount>>,
    #[account(mut)] pub relayer:Signer<'info>,pub token_program:Program<'info,Token2022>,pub associated_token_program:Program<'info,AssociatedToken>,pub system_program:Program<'info,System>,
}
#[derive(Accounts)]
pub struct Cancel<'info> {
    #[account(seeds=[b"config"],bump=config.bump)] pub config:Box<Account<'info,Config>>,
    #[account(seeds=[b"project",project.project_id.as_ref()],bump=project.bump)] pub project:Box<Account<'info,Project>>,
    #[account(mut,seeds=[b"round",project.key().as_ref(),&round.round_number.to_le_bytes()],bump=round.bump,has_one=project)] pub round:Box<Account<'info,Round>>,
    #[account(constraint=authority.key()==project.founder_wallet || authority.key()==config.admin @ ErrorCode::InvalidAuthority)] pub authority:Signer<'info>,
}
#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(seeds=[b"config"],bump=config.bump,has_one=payment_mint)] pub config:Box<Account<'info,Config>>,
    #[account(seeds=[b"project",project.project_id.as_ref()],bump=project.bump,constraint=project.founder_wallet==founder.key() @ ErrorCode::InvalidAuthority)] pub project:Box<Account<'info,Project>>,
    pub founder:Signer<'info>,#[account(mint::token_program=token_program)] pub payment_mint:Box<InterfaceAccount<'info,Mint>>,
    #[account(mut,seeds=[b"project_vault",project.key().as_ref()],bump,token::mint=payment_mint,token::authority=project,token::token_program=token_program)] pub project_vault:Box<InterfaceAccount<'info,TokenAccount>>,
    #[account(mut,seeds=[b"founder_reward_vault",project.key().as_ref()],bump,token::mint=payment_mint,token::authority=project,token::token_program=token_program)] pub founder_reward_vault:Box<InterfaceAccount<'info,TokenAccount>>,
    #[account(mut,associated_token::mint=payment_mint,associated_token::authority=founder,associated_token::token_program=token_program)] pub destination:Box<InterfaceAccount<'info,TokenAccount>>,
    pub token_program:Program<'info,Token2022>,
}
#[account] #[derive(InitSpace)]
pub struct Config {pub admin:Pubkey,pub relayer:Pubkey,pub payment_mint:Pubkey,pub protocol_fee_vault:Pubkey,pub protocol_fee_bps:u16,pub founder_share_bps:u16,pub paused:bool,pub bump:u8}
#[account] #[derive(InitSpace)]
pub struct Project {pub project_id:[u8;16],pub founder_wallet:Pubkey,pub receipt_mint:Pubkey,pub round_number:u16,pub bump:u8}
#[account] #[derive(InitSpace)]
pub struct Round {pub project:Pubkey,pub round_number:u16,pub opens_at:i64,pub closes_at:i64,pub unit_price_micro_usd:u64,pub max_units:u64,pub target_amount:u64,pub max_subscription_amount:u64,pub model_hash:[u8;32],pub evidence_root:[u8;32],pub total_committed:u64,pub total_accepted:u64,pub total_units_minted:u64,pub status:RoundStatus,pub filled:bool,pub bump:u8}
#[account] #[derive(InitSpace)]
pub struct Subscription {pub round:Pubkey,pub buyer_wallet:Pubkey,pub gross_amount:u64,pub accepted_amount:u64,pub units:u64,pub refunded_amount:u64,pub minted:bool,pub refunded:bool}
#[account] #[derive(InitSpace)]
pub struct FundingReceipt {pub intent_id:[u8;16],pub wallet:Pubkey,pub amount:u64,pub payment_mint:Pubkey,pub bank_proof_hash:[u8;32],pub funded:bool}
#[derive(AnchorSerialize,AnchorDeserialize,Clone,PartialEq,Eq,InitSpace)] pub enum RoundStatus {Open,Finalized,Expired,Refunding}
#[event] pub struct ProjectCreated {pub project_id:[u8;16],pub project:Pubkey,pub founder_wallet:Pubkey,pub receipt_mint:Pubkey}
#[event] pub struct MockWalletFunded {pub intent_id:[u8;16],pub wallet:Pubkey,pub amount:u64,pub bank_proof_hash:[u8;32]}
#[event] pub struct RoundOpened {pub round:Pubkey,pub project:Pubkey,pub receipt_mint:Pubkey,pub round_number:u16,pub opens_at:i64,pub closes_at:i64,pub unit_price_micro_usd:u64,pub max_units:u64,pub target_amount:u64,pub max_subscription_amount:u64,pub model_hash:[u8;32],pub evidence_root:[u8;32]}
#[event] pub struct SubscriptionAccepted {pub round:Pubkey,pub buyer_wallet:Pubkey,pub gross_amount:u64,pub total_committed:u64}
#[event] pub struct RoundFinalized {pub round:Pubkey,pub total_committed:u64,pub filled:bool}
#[event] pub struct AllocationMinted {pub round:Pubkey,pub buyer_wallet:Pubkey,pub accepted_amount:u64,pub units:u64,pub fee:u64,pub founder_reward:u64}
#[event] pub struct ExcessRefunded {pub round:Pubkey,pub buyer_wallet:Pubkey,pub amount:u64}
#[event] pub struct RoundCancelled {pub round:Pubkey}
#[event] pub struct ProceedsWithdrawn {pub project:Pubkey,pub amount:u64}
#[event] pub struct FounderRewardsWithdrawn {pub project:Pubkey,pub amount:u64}
#[error_code]
pub enum ErrorCode {#[msg("Protocol paused")] Paused,#[msg("Invalid token mint")] InvalidMint,#[msg("Invalid authority")] InvalidAuthority,#[msg("Invalid amount")] InvalidAmount,#[msg("Invalid proof")] InvalidProof,#[msg("Funding replay differs")] ReplayMismatch,#[msg("Founder cannot subscribe")] SelfParticipation,#[msg("Invalid round terms")] InvalidRound,#[msg("Round is not open")] RoundNotOpen,#[msg("Round has not closed")] RoundNotClosed,#[msg("Arithmetic limit exceeded")] Overflow,#[msg("Round already settled")] AlreadySettled}
#[cfg(test)] mod tests {
    use super::*;
    #[test] fn shared_documented_goldens(){
        let fixtures:serde_json::Value=serde_json::from_str(include_str!("../../../../docs/fixtures/nessie-purchase-cases.json")).unwrap();
        for case in fixtures["cases"].as_array().unwrap() {
            let value=|v:&serde_json::Value| v.as_str().unwrap().parse::<u64>().unwrap();
            let amounts=case["grossAmountsMicroUsd"].as_array().unwrap();let total=amounts.iter().map(value).sum();
            for (gross,expected) in amounts.iter().zip(case["expected"].as_array().unwrap()) {
                let result=allocation(value(gross),total,value(&case["targetMicroUsd"]),value(&case["unitPriceMicroUsd"]),case["cancelled"].as_bool().unwrap_or(false)).unwrap();
                assert_eq!(result.accepted,value(&expected["acceptedMicroUsd"]),"{}",case["name"]);
                assert_eq!(result.fee,value(&expected["feeMicroUsd"]));assert_eq!(result.reward,value(&expected["founderRewardMicroUsd"]));
                assert_eq!(result.net,value(&expected["projectProceedsMicroUsd"]));assert_eq!(result.units,value(&expected["units"]));assert_eq!(result.refund,value(&expected["refundMicroUsd"]));
            }
        }
    }
    #[test] fn golden(){let a=allocation(100_000_000,100_000_000,100_000_000,1_000_000,false).unwrap();assert_eq!(a,Allocation {accepted:100_000_000,fee:1_000_000,reward:400_000,net:99_000_000,units:99,refund:0});}
    #[test] fn oversubscription_and_conservation(){for total in [1_000_000_000,1_000_000_001,u64::MAX] {let a=allocation(100_000_000,total,100_000_000,1_000_000,false).unwrap();assert_eq!(a.accepted+a.refund,100_000_000);assert!(a.net+a.fee==a.accepted && a.units<=100);}}
    #[test] fn cancellation(){let a=allocation(100_000_000,100_000_000,100_000_000,1_000_000,true).unwrap();assert_eq!(a.refund,100_000_000);assert_eq!(a.units+a.fee+a.accepted,0);}
    #[test] fn zero_units_and_boundaries(){assert_eq!(allocation(1,100_000_000,10,1_000_000,false).unwrap().units,0);assert!(allocation(1,0,1,1,false).is_err());assert!(allocation(1,1,1,0,false).is_err());assert!(allocation(2,1,1,1,false).is_err());}
}
