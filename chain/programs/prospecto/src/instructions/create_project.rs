use anchor_lang::{
    prelude::*,
    system_program::{create_account, CreateAccount},
};
use anchor_spl::{
    token_2022::{
        initialize_mint2,
        spl_token_2022::{extension::ExtensionType, pod::PodMint},
        InitializeMint2,
    },
    token_2022_extensions::{
        metadata_pointer_initialize, non_transferable_mint_initialize, spl_pod::optional_keys::OptionalNonZeroPubkey,
        spl_token_metadata_interface::state::TokenMetadata, token_metadata_initialize, MetadataPointerInitialize,
        NonTransferableMintInitialize, TokenMetadataInitialize,
    },
    token_interface::{Mint, Token2022, TokenAccount},
};

use crate::{
    constants::*,
    error::ProspectoError,
    events::ProjectCreated,
    state::{Config, Project, ProjectStatus},
};

/// M§7.2 steps 4–6: Project PDA, a NonTransferable receipt mint controlled by it, and its vaults.
#[derive(Accounts)]
#[instruction(project_id: [u8; 16])]
pub struct CreateProject<'info> {
    #[account(mut)]
    pub relayer: Signer<'info>,
    pub founder: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = relayer, has_one = payment_mint)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        init,
        payer = relayer,
        space = 8 + Project::INIT_SPACE,
        seeds = [PROJECT_SEED, project_id.as_ref()],
        bump,
    )]
    pub project: Box<Account<'info, Project>>,
    /// CHECK: created and initialized below as a Token-2022 mint at this PDA.
    #[account(mut, seeds = [RECEIPT_MINT_SEED, project.key().as_ref()], bump)]
    pub receipt_mint: UncheckedAccount<'info>,
    #[account(
        init,
        payer = relayer,
        seeds = [PROJECT_VAULT_SEED, project.key().as_ref()],
        bump,
        token::mint = payment_mint,
        token::authority = project,
        token::token_program = token_program,
    )]
    pub project_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        init,
        payer = relayer,
        seeds = [FOUNDER_REWARD_VAULT_SEED, project.key().as_ref()],
        bump,
        token::mint = payment_mint,
        token::authority = project,
        token::token_program = token_program,
    )]
    pub founder_reward_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub payment_mint: Box<InterfaceAccount<'info, Mint>>,
    pub token_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}

pub fn handle_create_project(ctx: Context<CreateProject>, project_id: [u8; 16]) -> Result<()> {
    require!(!ctx.accounts.config.paused, ProspectoError::Paused);
    let project_key = ctx.accounts.project.key();
    let mint_key = ctx.accounts.receipt_mint.key();
    let token_program = ctx.accounts.token_program.key();
    let project_bump = [ctx.bumps.project];
    let project_seeds: &[&[u8]] = &[PROJECT_SEED, project_id.as_ref(), &project_bump];
    let mint_bump = [ctx.bumps.receipt_mint];
    let mint_seeds: &[&[u8]] = &[RECEIPT_MINT_SEED, project_key.as_ref(), &mint_bump];

    // Extensions must be initialized before initialize_mint2; the account is allocated at the
    // fixed-extension size and funded for the metadata the token program reallocs in afterwards.
    let mint_len = ExtensionType::try_calculate_account_len::<PodMint>(&[
        ExtensionType::NonTransferable,
        ExtensionType::MetadataPointer,
    ])?;
    let metadata = TokenMetadata {
        update_authority: OptionalNonZeroPubkey::try_from(Some(project_key))?,
        mint: mint_key,
        name: RECEIPT_NAME.to_string(),
        symbol: RECEIPT_SYMBOL.to_string(),
        uri: RECEIPT_URI.to_string(),
        additional_metadata: vec![],
    };
    let lamports = Rent::get()?.minimum_balance(mint_len + metadata.tlv_size_of()?);
    create_account(
        CpiContext::new_with_signer(
            ctx.accounts.system_program.key(),
            CreateAccount {
                from: ctx.accounts.relayer.to_account_info(),
                to: ctx.accounts.receipt_mint.to_account_info(),
            },
            &[mint_seeds],
        ),
        lamports,
        mint_len as u64,
        &token_program,
    )?;
    non_transferable_mint_initialize(CpiContext::new(
        token_program,
        NonTransferableMintInitialize {
            token_program_id: ctx.accounts.token_program.to_account_info(),
            mint: ctx.accounts.receipt_mint.to_account_info(),
        },
    ))?;
    metadata_pointer_initialize(
        CpiContext::new(
            token_program,
            MetadataPointerInitialize {
                token_program_id: ctx.accounts.token_program.to_account_info(),
                mint: ctx.accounts.receipt_mint.to_account_info(),
            },
        ),
        Some(project_key),
        Some(mint_key),
    )?;
    // Mint authority is the Project PDA and there is no freeze authority (M§7.1).
    initialize_mint2(
        CpiContext::new(token_program, InitializeMint2 { mint: ctx.accounts.receipt_mint.to_account_info() }),
        RECEIPT_DECIMALS,
        &project_key,
        None,
    )?;
    token_metadata_initialize(
        CpiContext::new_with_signer(
            token_program,
            TokenMetadataInitialize {
                program_id: ctx.accounts.token_program.to_account_info(),
                metadata: ctx.accounts.receipt_mint.to_account_info(),
                update_authority: ctx.accounts.project.to_account_info(),
                mint_authority: ctx.accounts.project.to_account_info(),
                mint: ctx.accounts.receipt_mint.to_account_info(),
            },
            &[project_seeds],
        ),
        metadata.name,
        metadata.symbol,
        metadata.uri,
    )?;

    ctx.accounts.project.set_inner(Project {
        project_id,
        founder_wallet: ctx.accounts.founder.key(),
        receipt_mint: mint_key,
        project_vault: ctx.accounts.project_vault.key(),
        founder_reward_vault: ctx.accounts.founder_reward_vault.key(),
        status: ProjectStatus::Active,
        bump: ctx.bumps.project,
    });
    emit!(ProjectCreated {
        project: project_key,
        project_id,
        founder_wallet: ctx.accounts.founder.key(),
        receipt_mint: mint_key,
        project_vault: ctx.accounts.project_vault.key(),
        founder_reward_vault: ctx.accounts.founder_reward_vault.key(),
    });
    Ok(())
}
