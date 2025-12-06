use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, Mint, Token, TokenAccount, Transfer},
};

declare_id!("DmEwwQX5n6mt2Hgv923xmVLDQpWWcvYmTcm3yJbZ5xRr");


// 2 token lamports = 1 WSOL lamport 
const EXCHANGE_RATE_NUMERATOR: u64 = 1;
const EXCHANGE_RATE_DENOMINATOR: u64 = 2;

#[program]
pub mod pooling {
    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>,
        token_amount: u64,
        wsol_amount: u64,
    ) -> Result<()> {
        let pool = &mut ctx.accounts.pool;
        pool.authority = ctx.accounts.authority.key();
        pool.token_mint = ctx.accounts.token_mint.key();
        pool.bump = ctx.bumps.pool;

        // Token, authority -> pool_token_ata
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.authority_token_ata.to_account_info(),
                    to: ctx.accounts.pool_token_ata.to_account_info(),
                    authority: ctx.accounts.authority.to_account_info(),
                },
            ),
            token_amount,
        )?;

        // WSOL, authority -> pool_wsol_ata
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.authority_wsol_ata.to_account_info(),
                    to: ctx.accounts.pool_wsol_ata.to_account_info(),
                    authority: ctx.accounts.authority.to_account_info(),
                },
            ),
            wsol_amount,
        )?;

        msg!(
            "Pool initialized with {} tokens and {} WSOL",
            token_amount,
            wsol_amount
        );
        Ok(())
    }

    pub fn buy(ctx: Context<Trade>, wsol_amount: u64) -> Result<()> {
        let token_amount = wsol_amount
            .checked_mul(EXCHANGE_RATE_DENOMINATOR)
            .unwrap()
            .checked_div(EXCHANGE_RATE_NUMERATOR)
            .unwrap();
        
        let token_mint_key = ctx.accounts.token_mint.key();

        // user WSOL -> Pool
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.user_wsol_ata.to_account_info(),
                    to: ctx.accounts.pool_wsol_ata.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            wsol_amount,
        )?;

        // pool Token -> user
        let seeds = &[
            b"pool",
            token_mint_key.as_ref(),
            &[ctx.accounts.pool.bump],
        ];
        let signer_seeds = &[&seeds[..]];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.pool_token_ata.to_account_info(),
                    to: ctx.accounts.user_token_ata.to_account_info(),
                    authority: ctx.accounts.pool.to_account_info(),
                },
                signer_seeds,
            ),
            token_amount,
        )?;

        msg!("Buy: {} WSOL for {} tokens", wsol_amount, token_amount);
        Ok(())
    }

    pub fn sell(ctx: Context<Trade>, token_amount: u64) -> Result<()> {
        let wsol_amount = token_amount
            .checked_mul(EXCHANGE_RATE_NUMERATOR)
            .unwrap()
            .checked_div(EXCHANGE_RATE_DENOMINATOR)
            .unwrap();
        let token_mint_key = ctx.accounts.token_mint.key();

        // user Token -> pool
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.user_token_ata.to_account_info(),
                    to: ctx.accounts.pool_token_ata.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            token_amount,
        )?;

        let seeds = &[
            b"pool",
            token_mint_key.as_ref(),
            &[ctx.accounts.pool.bump],
        ];
        let signer_seeds = &[&seeds[..]];
        
        // pool WSOL -> user
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.pool_wsol_ata.to_account_info(),
                    to: ctx.accounts.user_wsol_ata.to_account_info(),
                    authority: ctx.accounts.pool.to_account_info(),
                },
                signer_seeds,
            ),
            wsol_amount,
        )?;

        msg!("Sell: {} tokens for {} WSOL", token_amount, wsol_amount);
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + Pool::INIT_SPACE,
        seeds = [b"pool", token_mint.key().as_ref()],
        bump
    )]
    pub pool: Account<'info, Pool>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub token_mint: Account<'info, Mint>,

    /// CHECK: WSOL mint
    #[account(address = anchor_spl::token::spl_token::native_mint::ID)]
    pub wsol_mint: AccountInfo<'info>,

    #[account(
        init,
        payer = authority,
        associated_token::mint = token_mint,
        associated_token::authority = pool
    )]
    pub pool_token_ata: Account<'info, TokenAccount>,

    #[account(
        init,
        payer = authority,
        associated_token::mint = wsol_mint,
        associated_token::authority = pool
    )]
    pub pool_wsol_ata: Account<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = token_mint,
        associated_token::authority = authority
    )]
    pub authority_token_ata: Account<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = wsol_mint,
        associated_token::authority = authority
    )]
    pub authority_wsol_ata: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Trade<'info> {
    #[account(
        mut,
        seeds = [b"pool", token_mint.key().as_ref()],
        bump = pool.bump
    )]
    pub pool: Account<'info, Pool>,

    #[account(mut)]
    pub user: Signer<'info>,

    pub token_mint: Account<'info, Mint>,

    /// CHECK: WSOL mint
    #[account(address = anchor_spl::token::spl_token::native_mint::ID)]
    pub wsol_mint: AccountInfo<'info>,

    #[account(
        mut,
        associated_token::mint = token_mint,
        associated_token::authority = pool
    )]
    pub pool_token_ata: Account<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = wsol_mint,
        associated_token::authority = pool
    )]
    pub pool_wsol_ata: Account<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = token_mint,
        associated_token::authority = user
    )]
    pub user_token_ata: Account<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = wsol_mint,
        associated_token::authority = user
    )]
    pub user_wsol_ata: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[account]
#[derive(InitSpace)]
pub struct Pool {
    pub authority: Pubkey,
    pub token_mint: Pubkey,
    pub bump: u8,
}
