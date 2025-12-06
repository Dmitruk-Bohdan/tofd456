use anchor_lang::prelude::*;

declare_id!("DmEwwQX5n6mt2Hgv923xmVLDQpWWcvYmTcm3yJbZ5xRr");

/// Основной модуль программы.
/// В терминах Anchor сюда кладутся инструкции (функции, которые можно вызвать снаружи).
#[program]
pub mod backgammon {
    use super::*;

    /// Инициализация новой игры.
    ///
    /// Аналог C# метода:
    /// public Result InitGame(Context<InitGame> ctx, ulong gameId, ...)
pub fn init_game(
    ctx: Context<InitGame>,
    game_id: u64,
    stake_lamports: u64,
    move_fee_lamports: u64,
    player2_pubkey: Pubkey,
    initial_board_state: [u8; 64],
) -> Result<()> {
    // ОДНА мут-ссылка на аккаунт игры
    let game = &mut ctx.accounts.game;

    // Заполняем структуру состояния игры
    game.player1 = ctx.accounts.player1.key();
    game.player2 = player2_pubkey;
    game.game_id = game_id;
    game.stake_lamports = stake_lamports;
    game.move_fee_lamports = move_fee_lamports;
    game.pot_lamports = 0;
    game.board_state = initial_board_state;
    game.current_turn = 1;
    game.status = GameStatus::WaitingForPlayer2;
    game.winner = Pubkey::default();
    game.bump = ctx.bumps.game;

    // Забираем ставку у первого игрока в аккаунт игры

    // player1: берём лампорты напрямую с ctx.accounts.player1
    **ctx
        .accounts
        .player1
        .to_account_info()
        .try_borrow_mut_lamports()? -= stake_lamports;

    // game: берём лампорты через уже взятую &mut ссылку `game`,
    // а не через ctx.accounts.game
    **game
        .to_account_info()
        .try_borrow_mut_lamports()? += stake_lamports;

    game.pot_lamports += stake_lamports;

    Ok(())
}
}


/// Это on-chain аккаунт, который хранит состояние одной игры.
#[account]
pub struct GameState {
    pub player1: Pubkey,          // 32 байта
    pub player2: Pubkey,          // 32 байта
    pub game_id: u64,             // 8
    pub stake_lamports: u64,      // 8
    pub move_fee_lamports: u64,   // 8
    pub pot_lamports: u64,        // 8
    pub board_state: [u8; 64],    // 64
    pub current_turn: u8,         // 1
    pub status: GameStatus,       // ~1
    pub winner: Pubkey,           // 32
    pub bump: u8,                 // 1
}

// Ассоциированная константа для расчёта размера аккаунта.
// Мы берём с запасом.
impl GameState {
    pub const MAX_SIZE: usize = 256;
}

/// Enum тоже хранится on-chain, поэтому нужен Serialize/Deserialize.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum GameStatus {
    WaitingForPlayer2,
    Active,
    Finished,
}

/// Контекст для init_game.
///
/// #[instruction(...)] говорит Anchor'у:
/// "эта инструкция принимает такие-то аргументы, их можно использовать в seeds".
#[derive(Accounts)]
#[instruction(game_id: u64, player2_pubkey: Pubkey)]
pub struct InitGame<'info> {
    /// Аккаунт игры. Создаётся этой инструкцией.
    #[account(
        init,
        payer = player1,
        space = 8 + GameState::MAX_SIZE,
        seeds = [
            b"game",
            player1.key().as_ref(),
            player2_pubkey.as_ref(),
            &game_id.to_le_bytes(),
        ],
        bump
    )]
    pub game: Account<'info, GameState>,

    /// Первый игрок, он платит за создание аккаунта и вносит первую ставку.
    #[account(mut)]
    pub player1: Signer<'info>,

    /// Стандартная системная программа Solana, нужна для создания аккаунта.
    pub system_program: Program<'info, System>,
}

