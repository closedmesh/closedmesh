use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, CreateAccount};
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

declare_id!("2XPnsypjFLQoXrHgzShZURUaCykgP37Q1vZXjpN4gGDF");

pub const CONFIG_SEED: &[u8] = b"senda-vault-config";
pub const AUTH_SEED: &[u8] = b"senda-vault-auth";
pub const CUST_SEED: &[u8] = b"senda-cust";
pub const PEER_SEED: &[u8] = b"senda-peer";
pub const MARGIN_SEED: &[u8] = b"senda-margin";
pub const BATCH_SEED: &[u8] = b"senda-batch";
pub const REFUND_SEED: &[u8] = b"senda-refund";

pub const DEFAULT_MIN_CLAIM_ATOMIC: u64 = 10_000_000; // $10
pub const DEFAULT_MIN_DEPOSIT_ATOMIC: u64 = 5_000_000; // $5
pub const DEFAULT_MAX_TVL_ATOMIC: u64 = 1_000_000_000; // $1_000 week-1

#[program]
pub mod senda_vault {
    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>,
        admin: Pubkey,
        oracle: Pubkey,
    ) -> Result<()> {
        require!(admin != Pubkey::default(), VaultError::InvalidPubkey);
        require!(oracle != Pubkey::default(), VaultError::InvalidPubkey);

        let config = &mut ctx.accounts.config;
        config.admin = admin;
        config.oracle = oracle;
        config.usdc_mint = ctx.accounts.usdc_mint.key();
        config.vault_authority = ctx.accounts.vault_authority.key();
        config.vault_ata = ctx.accounts.vault_ata.key();
        config.paused = true; // M0-safe; unpause after G0/G1
        config.min_claim_atomic = DEFAULT_MIN_CLAIM_ATOMIC;
        config.min_deposit_atomic = DEFAULT_MIN_DEPOSIT_ATOMIC;
        config.max_tvl_atomic = DEFAULT_MAX_TVL_ATOMIC;
        config.settle_fee_bps = 0;
        config.bump = ctx.bumps.config;
        config.authority_bump = ctx.bumps.vault_authority;

        let margin = &mut ctx.accounts.margin;
        margin.available_atomic = 0;
        margin.bump = ctx.bumps.margin;

        emit!(Initialized {
            admin,
            oracle,
            usdc_mint: config.usdc_mint,
            vault_ata: config.vault_ata,
        });
        Ok(())
    }

    pub fn set_params(
        ctx: Context<AdminOnly>,
        oracle: Option<Pubkey>,
        paused: Option<bool>,
        min_claim_atomic: Option<u64>,
        min_deposit_atomic: Option<u64>,
        max_tvl_atomic: Option<u64>,
        settle_fee_bps: Option<u16>,
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;
        if let Some(o) = oracle {
            require!(o != Pubkey::default(), VaultError::InvalidPubkey);
            config.oracle = o;
        }
        if let Some(p) = paused {
            config.paused = p;
        }
        if let Some(v) = min_claim_atomic {
            config.min_claim_atomic = v;
        }
        if let Some(v) = min_deposit_atomic {
            config.min_deposit_atomic = v;
        }
        if let Some(v) = max_tvl_atomic {
            config.max_tvl_atomic = v;
        }
        if let Some(v) = settle_fee_bps {
            require!(v <= 10_000, VaultError::InvalidFeeBps);
            config.settle_fee_bps = v;
        }
        Ok(())
    }

    pub fn pause(ctx: Context<AdminOnly>) -> Result<()> {
        ctx.accounts.config.paused = true;
        Ok(())
    }

    pub fn unpause(ctx: Context<AdminOnly>) -> Result<()> {
        ctx.accounts.config.paused = false;
        Ok(())
    }

    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        let config = &ctx.accounts.config;
        require!(!config.paused, VaultError::Paused);
        require!(amount >= config.min_deposit_atomic, VaultError::BelowMinDeposit);

        let vault_balance = ctx.accounts.vault_ata.amount;
        let new_tvl = vault_balance
            .checked_add(amount)
            .ok_or(VaultError::MathOverflow)?;
        require!(new_tvl <= config.max_tvl_atomic, VaultError::TvlCapExceeded);

        let decimals = ctx.accounts.usdc_mint.decimals;
        transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.customer_ata.to_account_info(),
                    mint: ctx.accounts.usdc_mint.to_account_info(),
                    to: ctx.accounts.vault_ata.to_account_info(),
                    authority: ctx.accounts.customer.to_account_info(),
                },
            ),
            amount,
            decimals,
        )?;

        let cust = &mut ctx.accounts.customer_escrow;
        if cust.owner == Pubkey::default() {
            cust.owner = ctx.accounts.customer.key();
            cust.bump = ctx.bumps.customer_escrow;
        } else {
            require_keys_eq!(cust.owner, ctx.accounts.customer.key(), VaultError::OwnerMismatch);
        }
        cust.available_atomic = cust
            .available_atomic
            .checked_add(amount)
            .ok_or(VaultError::MathOverflow)?;

        emit!(DepositEvent {
            wallet: ctx.accounts.customer.key(),
            amount,
        });
        Ok(())
    }

    /// One settle line per ix (worker aggregates off-chain). `batch_id` PDA enforces idempotency.
    pub fn oracle_settle_batch(
        ctx: Context<OracleSettleBatch>,
        batch_id: [u8; 16],
        customer_debit: u64,
        peer_credit: u64,
        margin_credit: u64,
    ) -> Result<()> {
        let config = &ctx.accounts.config;
        require!(!config.paused, VaultError::Paused);
        require!(
            customer_debit == peer_credit.saturating_add(margin_credit),
            VaultError::SettleImbalance
        );
        require!(customer_debit > 0, VaultError::ZeroAmount);

        let cust = &mut ctx.accounts.customer_escrow;
        require_keys_eq!(
            cust.owner,
            ctx.accounts.customer_wallet.key(),
            VaultError::OwnerMismatch
        );
        require!(
            cust.available_atomic >= customer_debit,
            VaultError::InsufficientCustomer
        );
        cust.available_atomic = cust
            .available_atomic
            .checked_sub(customer_debit)
            .ok_or(VaultError::MathOverflow)?;

        if peer_credit > 0 {
            let peer_wallet = ctx
                .accounts
                .peer_wallet
                .as_ref()
                .ok_or(VaultError::PeerRequired)?
                .key();
            require!(peer_wallet != Pubkey::default(), VaultError::InvalidPubkey);
            let peer_info = ctx
                .accounts
                .peer_escrow
                .as_ref()
                .ok_or(VaultError::PeerRequired)?;
            let (expected, bump) =
                Pubkey::find_program_address(&[PEER_SEED, peer_wallet.as_ref()], ctx.program_id);
            require_keys_eq!(peer_info.key(), expected, VaultError::BadPeerEscrow);

            ensure_peer_escrow(
                &ctx.accounts.oracle.to_account_info(),
                peer_info,
                &ctx.accounts.system_program.to_account_info(),
                peer_wallet,
                bump,
                ctx.program_id,
            )?;

            let mut data = peer_info.try_borrow_mut_data()?;
            let mut peer = PeerEscrow::try_deserialize(&mut &data[..])?;
            if peer.owner == Pubkey::default() {
                peer.owner = peer_wallet;
                peer.bump = bump;
            } else {
                require_keys_eq!(peer.owner, peer_wallet, VaultError::OwnerMismatch);
            }
            peer.available_atomic = peer
                .available_atomic
                .checked_add(peer_credit)
                .ok_or(VaultError::MathOverflow)?;
            peer.try_serialize(&mut &mut data[..])?;
        }

        if margin_credit > 0 {
            let margin = &mut ctx.accounts.margin;
            margin.available_atomic = margin
                .available_atomic
                .checked_add(margin_credit)
                .ok_or(VaultError::MathOverflow)?;
        }

        let receipt = &mut ctx.accounts.batch_receipt;
        receipt.batch_id = batch_id;
        receipt.bump = ctx.bumps.batch_receipt;

        emit!(SettleBatchEvent {
            batch_id,
            n_lines: 1,
            total_debit: customer_debit,
        });
        Ok(())
    }

    pub fn peer_claim(ctx: Context<PeerClaim>, amount: u64) -> Result<()> {
        let config = &ctx.accounts.config;
        require!(!config.paused, VaultError::Paused);

        let peer = &mut ctx.accounts.peer_escrow;
        require_keys_eq!(peer.owner, ctx.accounts.peer.key(), VaultError::OwnerMismatch);

        let claim_amount = if amount == 0 {
            peer.available_atomic
        } else {
            amount
        };
        require!(claim_amount > 0, VaultError::ZeroAmount);
        require!(
            claim_amount >= config.min_claim_atomic,
            VaultError::BelowMinClaim
        );
        require!(
            peer.available_atomic >= claim_amount,
            VaultError::InsufficientPeer
        );

        peer.available_atomic = peer
            .available_atomic
            .checked_sub(claim_amount)
            .ok_or(VaultError::MathOverflow)?;

        let mint_key = config.usdc_mint;
        let authority_bump = config.authority_bump;
        let signer_seeds: &[&[&[u8]]] = &[&[AUTH_SEED, mint_key.as_ref(), &[authority_bump]]];

        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.vault_ata.to_account_info(),
                    mint: ctx.accounts.usdc_mint.to_account_info(),
                    to: ctx.accounts.peer_ata.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                },
                signer_seeds,
            ),
            claim_amount,
            ctx.accounts.usdc_mint.decimals,
        )?;

        emit!(PeerClaimEvent {
            peer: ctx.accounts.peer.key(),
            amount: claim_amount,
        });
        Ok(())
    }

    pub fn customer_refund(
        ctx: Context<CustomerRefund>,
        refund_id: [u8; 16],
        amount: u64,
    ) -> Result<()> {
        let config = &ctx.accounts.config;
        require!(!config.paused, VaultError::Paused);
        require!(amount > 0, VaultError::ZeroAmount);

        let cust = &mut ctx.accounts.customer_escrow;
        require_keys_eq!(
            cust.owner,
            ctx.accounts.customer_wallet.key(),
            VaultError::OwnerMismatch
        );
        require!(
            cust.available_atomic >= amount,
            VaultError::InsufficientCustomer
        );
        cust.available_atomic = cust
            .available_atomic
            .checked_sub(amount)
            .ok_or(VaultError::MathOverflow)?;

        let receipt = &mut ctx.accounts.refund_receipt;
        receipt.refund_id = refund_id;
        receipt.bump = ctx.bumps.refund_receipt;

        let mint_key = config.usdc_mint;
        let authority_bump = config.authority_bump;
        let signer_seeds: &[&[&[u8]]] = &[&[AUTH_SEED, mint_key.as_ref(), &[authority_bump]]];

        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.vault_ata.to_account_info(),
                    mint: ctx.accounts.usdc_mint.to_account_info(),
                    to: ctx.accounts.customer_ata.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                },
                signer_seeds,
            ),
            amount,
            ctx.accounts.usdc_mint.decimals,
        )?;

        emit!(CustomerRefundEvent {
            customer: ctx.accounts.customer_wallet.key(),
            amount,
            refund_id,
        });
        Ok(())
    }

    pub fn admin_withdraw_margin(ctx: Context<AdminWithdrawMargin>, amount: u64) -> Result<()> {
        require!(amount > 0, VaultError::ZeroAmount);
        let margin = &mut ctx.accounts.margin;
        require!(
            margin.available_atomic >= amount,
            VaultError::InsufficientMargin
        );
        margin.available_atomic = margin
            .available_atomic
            .checked_sub(amount)
            .ok_or(VaultError::MathOverflow)?;

        let config = &ctx.accounts.config;
        let mint_key = config.usdc_mint;
        let authority_bump = config.authority_bump;
        let signer_seeds: &[&[&[u8]]] = &[&[AUTH_SEED, mint_key.as_ref(), &[authority_bump]]];

        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.vault_ata.to_account_info(),
                    mint: ctx.accounts.usdc_mint.to_account_info(),
                    to: ctx.accounts.destination_ata.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                },
                signer_seeds,
            ),
            amount,
            ctx.accounts.usdc_mint.decimals,
        )?;

        emit!(MarginWithdrawEvent {
            destination: ctx.accounts.destination.key(),
            amount,
        });
        Ok(())
    }
}

#[account]
pub struct VaultConfig {
    pub admin: Pubkey,
    pub oracle: Pubkey,
    pub usdc_mint: Pubkey,
    pub vault_authority: Pubkey,
    pub vault_ata: Pubkey,
    pub paused: bool,
    pub min_claim_atomic: u64,
    pub min_deposit_atomic: u64,
    pub max_tvl_atomic: u64,
    pub settle_fee_bps: u16,
    pub bump: u8,
    pub authority_bump: u8,
}

impl VaultConfig {
    pub const LEN: usize = 8 + 32 * 5 + 1 + 8 * 3 + 2 + 1 + 1;
}

#[account]
pub struct CustomerEscrow {
    pub owner: Pubkey,
    pub available_atomic: u64,
    /// Reserved for v1.1; unused in v1 (Redis holds request reserves).
    pub reserved_atomic: u64,
    pub bump: u8,
}

impl CustomerEscrow {
    pub const LEN: usize = 8 + 32 + 8 + 8 + 1;
}

#[account]
pub struct PeerEscrow {
    pub owner: Pubkey,
    pub available_atomic: u64,
    pub bump: u8,
}

impl PeerEscrow {
    pub const LEN: usize = 8 + 32 + 8 + 1;
}

#[account]
pub struct MarginEscrow {
    pub available_atomic: u64,
    pub bump: u8,
}

impl MarginEscrow {
    pub const LEN: usize = 8 + 8 + 1;
}

#[account]
pub struct BatchReceipt {
    pub batch_id: [u8; 16],
    pub bump: u8,
}

impl BatchReceipt {
    pub const LEN: usize = 8 + 16 + 1;
}

#[account]
pub struct RefundReceipt {
    pub refund_id: [u8; 16],
    pub bump: u8,
}

impl RefundReceipt {
    pub const LEN: usize = 8 + 16 + 1;
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub deployer: Signer<'info>,

    pub usdc_mint: InterfaceAccount<'info, Mint>,

    #[account(
        init,
        payer = deployer,
        space = VaultConfig::LEN,
        seeds = [CONFIG_SEED, usdc_mint.key().as_ref()],
        bump
    )]
    pub config: Account<'info, VaultConfig>,

    /// CHECK: PDA authority for vault ATA; no data.
    #[account(
        seeds = [AUTH_SEED, usdc_mint.key().as_ref()],
        bump
    )]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(
        init,
        payer = deployer,
        associated_token::mint = usdc_mint,
        associated_token::authority = vault_authority,
        associated_token::token_program = token_program,
    )]
    pub vault_ata: InterfaceAccount<'info, TokenAccount>,

    #[account(
        init,
        payer = deployer,
        space = MarginEscrow::LEN,
        seeds = [MARGIN_SEED],
        bump
    )]
    pub margin: Account<'info, MarginEscrow>,

    pub system_program: Program<'info, System>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [CONFIG_SEED, config.usdc_mint.as_ref()],
        bump = config.bump,
        has_one = admin @ VaultError::UnauthorizedAdmin,
    )]
    pub config: Account<'info, VaultConfig>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub customer: Signer<'info>,

    #[account(
        seeds = [CONFIG_SEED, config.usdc_mint.as_ref()],
        bump = config.bump,
    )]
    pub config: Account<'info, VaultConfig>,

    #[account(
        constraint = usdc_mint.key() == config.usdc_mint @ VaultError::WrongMint
    )]
    pub usdc_mint: InterfaceAccount<'info, Mint>,

    /// CHECK: vault authority PDA
    #[account(
        seeds = [AUTH_SEED, config.usdc_mint.as_ref()],
        bump = config.authority_bump,
        constraint = vault_authority.key() == config.vault_authority @ VaultError::BadVaultAuthority,
    )]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(
        mut,
        constraint = vault_ata.key() == config.vault_ata @ VaultError::BadVaultAta,
    )]
    pub vault_ata: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        constraint = customer_ata.mint == config.usdc_mint @ VaultError::WrongMint,
        constraint = customer_ata.owner == customer.key() @ VaultError::OwnerMismatch,
    )]
    pub customer_ata: InterfaceAccount<'info, TokenAccount>,

    #[account(
        init_if_needed,
        payer = customer,
        space = CustomerEscrow::LEN,
        seeds = [CUST_SEED, customer.key().as_ref()],
        bump
    )]
    pub customer_escrow: Account<'info, CustomerEscrow>,

    pub system_program: Program<'info, System>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
#[instruction(batch_id: [u8; 16])]
pub struct OracleSettleBatch<'info> {
    #[account(mut)]
    pub oracle: Signer<'info>,

    #[account(
        seeds = [CONFIG_SEED, config.usdc_mint.as_ref()],
        bump = config.bump,
        has_one = oracle @ VaultError::UnauthorizedOracle,
    )]
    pub config: Account<'info, VaultConfig>,

    /// CHECK: customer wallet identity for escrow seeds (need not sign).
    pub customer_wallet: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [CUST_SEED, customer_wallet.key().as_ref()],
        bump = customer_escrow.bump,
    )]
    pub customer_escrow: Account<'info, CustomerEscrow>,

    /// Optional: required when peer_credit > 0.
    /// CHECK: peer payout wallet
    pub peer_wallet: Option<UncheckedAccount<'info>>,

    /// Optional: peer escrow PDA; required when peer_credit > 0.
    /// CHECK: validated + init'd in handler
    #[account(mut)]
    pub peer_escrow: Option<UncheckedAccount<'info>>,

    #[account(
        mut,
        seeds = [MARGIN_SEED],
        bump = margin.bump,
    )]
    pub margin: Account<'info, MarginEscrow>,

    #[account(
        init,
        payer = oracle,
        space = BatchReceipt::LEN,
        seeds = [BATCH_SEED, batch_id.as_ref()],
        bump
    )]
    pub batch_receipt: Account<'info, BatchReceipt>,

    pub system_program: Program<'info, System>,
}

fn ensure_peer_escrow<'info>(
    payer: &AccountInfo<'info>,
    peer_escrow: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    peer_wallet: Pubkey,
    bump: u8,
    program_id: &Pubkey,
) -> Result<()> {
    if peer_escrow.lamports() > 0 && !peer_escrow.data_is_empty() {
        require_keys_eq!(*peer_escrow.owner, *program_id, VaultError::BadPeerEscrow);
        return Ok(());
    }

    let space = PeerEscrow::LEN;
    let lamports = Rent::get()?.minimum_balance(space);
    let seeds: &[&[u8]] = &[PEER_SEED, peer_wallet.as_ref(), &[bump]];
    system_program::create_account(
        CpiContext::new_with_signer(
            system_program.clone(),
            CreateAccount {
                from: payer.clone(),
                to: peer_escrow.clone(),
            },
            &[seeds],
        ),
        lamports,
        space as u64,
        program_id,
    )?;

    let mut data = peer_escrow.try_borrow_mut_data()?;
    let peer = PeerEscrow {
        owner: Pubkey::default(),
        available_atomic: 0,
        bump,
    };
    // Discriminator + body
    let mut cursor = std::io::Cursor::new(&mut data[..]);
    peer.try_serialize(&mut cursor)?;
    Ok(())
}

#[derive(Accounts)]
pub struct PeerClaim<'info> {
    #[account(mut)]
    pub peer: Signer<'info>,

    #[account(
        seeds = [CONFIG_SEED, config.usdc_mint.as_ref()],
        bump = config.bump,
    )]
    pub config: Account<'info, VaultConfig>,

    #[account(
        constraint = usdc_mint.key() == config.usdc_mint @ VaultError::WrongMint
    )]
    pub usdc_mint: InterfaceAccount<'info, Mint>,

    /// CHECK: vault authority PDA
    #[account(
        seeds = [AUTH_SEED, config.usdc_mint.as_ref()],
        bump = config.authority_bump,
    )]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(
        mut,
        constraint = vault_ata.key() == config.vault_ata @ VaultError::BadVaultAta,
    )]
    pub vault_ata: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [PEER_SEED, peer.key().as_ref()],
        bump = peer_escrow.bump,
    )]
    pub peer_escrow: Account<'info, PeerEscrow>,

    #[account(
        init_if_needed,
        payer = peer,
        associated_token::mint = usdc_mint,
        associated_token::authority = peer,
        associated_token::token_program = token_program,
    )]
    pub peer_ata: InterfaceAccount<'info, TokenAccount>,

    pub system_program: Program<'info, System>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}

#[derive(Accounts)]
#[instruction(refund_id: [u8; 16])]
pub struct CustomerRefund<'info> {
    #[account(mut)]
    pub oracle: Signer<'info>,

    #[account(
        seeds = [CONFIG_SEED, config.usdc_mint.as_ref()],
        bump = config.bump,
        has_one = oracle @ VaultError::UnauthorizedOracle,
    )]
    pub config: Account<'info, VaultConfig>,

    #[account(
        constraint = usdc_mint.key() == config.usdc_mint @ VaultError::WrongMint
    )]
    pub usdc_mint: InterfaceAccount<'info, Mint>,

    /// CHECK: vault authority PDA
    #[account(
        seeds = [AUTH_SEED, config.usdc_mint.as_ref()],
        bump = config.authority_bump,
    )]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(
        mut,
        constraint = vault_ata.key() == config.vault_ata @ VaultError::BadVaultAta,
    )]
    pub vault_ata: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: customer wallet
    pub customer_wallet: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [CUST_SEED, customer_wallet.key().as_ref()],
        bump = customer_escrow.bump,
    )]
    pub customer_escrow: Account<'info, CustomerEscrow>,

    #[account(
        mut,
        constraint = customer_ata.mint == config.usdc_mint @ VaultError::WrongMint,
        constraint = customer_ata.owner == customer_wallet.key() @ VaultError::OwnerMismatch,
    )]
    pub customer_ata: InterfaceAccount<'info, TokenAccount>,

    #[account(
        init,
        payer = oracle,
        space = RefundReceipt::LEN,
        seeds = [REFUND_SEED, refund_id.as_ref()],
        bump
    )]
    pub refund_receipt: Account<'info, RefundReceipt>,

    pub system_program: Program<'info, System>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct AdminWithdrawMargin<'info> {
    pub admin: Signer<'info>,

    #[account(
        seeds = [CONFIG_SEED, config.usdc_mint.as_ref()],
        bump = config.bump,
        has_one = admin @ VaultError::UnauthorizedAdmin,
    )]
    pub config: Account<'info, VaultConfig>,

    #[account(
        constraint = usdc_mint.key() == config.usdc_mint @ VaultError::WrongMint
    )]
    pub usdc_mint: InterfaceAccount<'info, Mint>,

    /// CHECK: vault authority PDA
    #[account(
        seeds = [AUTH_SEED, config.usdc_mint.as_ref()],
        bump = config.authority_bump,
    )]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(
        mut,
        constraint = vault_ata.key() == config.vault_ata @ VaultError::BadVaultAta,
    )]
    pub vault_ata: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [MARGIN_SEED],
        bump = margin.bump,
    )]
    pub margin: Account<'info, MarginEscrow>,

    /// CHECK: admin-chosen destination wallet (Squads / ops treasury).
    pub destination: UncheckedAccount<'info>,

    #[account(
        mut,
        constraint = destination_ata.mint == config.usdc_mint @ VaultError::WrongMint,
        constraint = destination_ata.owner == destination.key() @ VaultError::OwnerMismatch,
    )]
    pub destination_ata: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
}

#[event]
pub struct Initialized {
    pub admin: Pubkey,
    pub oracle: Pubkey,
    pub usdc_mint: Pubkey,
    pub vault_ata: Pubkey,
}

#[event]
pub struct DepositEvent {
    pub wallet: Pubkey,
    pub amount: u64,
}

#[event]
pub struct SettleBatchEvent {
    pub batch_id: [u8; 16],
    pub n_lines: u16,
    pub total_debit: u64,
}

#[event]
pub struct PeerClaimEvent {
    pub peer: Pubkey,
    pub amount: u64,
}

#[event]
pub struct CustomerRefundEvent {
    pub customer: Pubkey,
    pub amount: u64,
    pub refund_id: [u8; 16],
}

#[event]
pub struct MarginWithdrawEvent {
    pub destination: Pubkey,
    pub amount: u64,
}

#[error_code]
pub enum VaultError {
    #[msg("Program is paused")]
    Paused,
    #[msg("Unauthorized admin")]
    UnauthorizedAdmin,
    #[msg("Unauthorized oracle")]
    UnauthorizedOracle,
    #[msg("Invalid pubkey")]
    InvalidPubkey,
    #[msg("Invalid fee bps")]
    InvalidFeeBps,
    #[msg("Below minimum deposit")]
    BelowMinDeposit,
    #[msg("Below minimum claim")]
    BelowMinClaim,
    #[msg("TVL cap exceeded")]
    TvlCapExceeded,
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("Wrong USDC mint")]
    WrongMint,
    #[msg("Bad vault ATA")]
    BadVaultAta,
    #[msg("Bad vault authority")]
    BadVaultAuthority,
    #[msg("Owner mismatch")]
    OwnerMismatch,
    #[msg("Settle line imbalance")]
    SettleImbalance,
    #[msg("Insufficient customer balance")]
    InsufficientCustomer,
    #[msg("Insufficient peer balance")]
    InsufficientPeer,
    #[msg("Insufficient margin")]
    InsufficientMargin,
    #[msg("Zero amount")]
    ZeroAmount,
    #[msg("Peer wallet/escrow required when peer_credit > 0")]
    PeerRequired,
    #[msg("Bad peer escrow account")]
    BadPeerEscrow,
}
