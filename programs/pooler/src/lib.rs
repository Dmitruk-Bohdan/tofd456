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
        msg!(
            "init_game: game_id={}, stake_lamports={}, move_fee_lamports={}, player1={}, player2={}",
            game_id,
            stake_lamports,
            move_fee_lamports,
            ctx.accounts.player1.key(),
            player2_pubkey
        );

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
        game.move_index = 0;

        msg!(
            "init_game: GameState initialized: status={:?}, current_turn={}, pot_lamports={}, bump={}",
            game.status,
            game.current_turn,
            game.pot_lamports,
            game.bump
        );

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

        msg!(
            "init_game: stake transferred from player1={}, stake_lamports={}, pot_lamports={}",
            game.player1,
            stake_lamports,
            game.pot_lamports
        );

        Ok(())
    }

    /// Присоединение второго игрока к уже созданной игре.
    pub fn join_game(ctx: Context<JoinGame>) -> Result<()> {
        let game = &mut ctx.accounts.game;

        msg!(
            "join_game: game_id={}, player2_expected={}, player2_actual={}",
            game.game_id,
            game.player2,
            ctx.accounts.player2.key()
        );

        // Игра должна ожидать второго игрока
        require!(
            game.status == GameStatus::WaitingForPlayer2,
            ErrorCode::GameNotWaitingForPlayer2
        );

        // Проверяем, что присоединился именно тот второй игрок,
        // который был указан при инициализации.
        require_keys_eq!(
            ctx.accounts.player2.key(),
            game.player2,
            ErrorCode::InvalidPlayer2
        );

        // Списываем стартовую ставку со второго игрока в аккаунт игры
        let stake = game.stake_lamports;

        msg!(
            "join_game: transferring stake from player2={}, stake_lamports={}",
            ctx.accounts.player2.key(),
            stake
        );

        **ctx
            .accounts
            .player2
            .to_account_info()
            .try_borrow_mut_lamports()? -= stake;
        **game
            .to_account_info()
            .try_borrow_mut_lamports()? += stake;

        game.pot_lamports += stake;
        game.status = GameStatus::Active;

        msg!(
            "join_game: completed, pot_lamports={}, status={:?}",
            game.pot_lamports,
            game.status
        );

        Ok(())
    }

    /// Ход одного из игроков.
    ///
    /// Валидация правил нард делается оффчейн, а здесь мы:
    /// - проверяем, что ходит правильный игрок;
    /// - списываем move_fee_lamports с ходящего игрока в пользу банка;
    /// - обновляем board_state;
    /// - переключаем очередь хода.
    pub fn make_move(
        ctx: Context<MakeMove>,
        new_board_state: [u8; 64],
    ) -> Result<()> {
        let game = &mut ctx.accounts.game;

        msg!(
            "make_move: game_id={}, move_index={}, current_turn={}, status={:?}",
            game.game_id,
            game.move_index,
            game.current_turn,
            game.status
        );

        require!(game.status == GameStatus::Active, ErrorCode::GameNotActive);

        // Определяем, чей сейчас ход, и берём соответствующего подписанта.
        let current_player_signer = match game.current_turn {
            1 => {
                msg!("make_move: expected current player = player1={}", game.player1);
                &ctx.accounts.player1
            }
            2 => {
                msg!("make_move: expected current player = player2={}", game.player2);
                &ctx.accounts.player2
            }
            _ => {
                msg!(
                    "make_move: invalid current_turn value = {}",
                    game.current_turn
                );
                return Err(ErrorCode::InvalidCurrentTurn.into());
            }
        };

        // Списываем комиссию за ход в пользу банка
        let move_fee = game.move_fee_lamports;
        msg!(
            "make_move: charging move_fee={}, from_player={}",
            move_fee,
            current_player_signer.key()
        );

        **current_player_signer
            .to_account_info()
            .try_borrow_mut_lamports()? -= move_fee;
        **game.to_account_info().try_borrow_mut_lamports()? += move_fee;
        game.pot_lamports = game
            .pot_lamports
            .checked_add(move_fee)
            .ok_or(ErrorCode::MathOverflow)?;

        // Обновляем состояние доски (валидация оффчейн)
        game.board_state = new_board_state;

        // Увеличиваем счётчик ходов
        game.move_index = game
            .move_index
            .checked_add(1)
            .ok_or(ErrorCode::MathOverflow)?;

        // Переключаем очередь хода
        game.current_turn = if game.current_turn == 1 { 2 } else { 1 };

        msg!(
            "make_move: completed, new_move_index={}, new_current_turn={}, pot_lamports={}",
            game.move_index,
            game.current_turn,
            game.pot_lamports
        );

        Ok(())
    }

    /// Завершение игры и вывод банка победителю.
    ///
    /// Валидация результата (кто на самом деле выиграл) делается оффчейн,
    /// но вывести банк можно только, если транзакцию подписали ОБА игрока.
    pub fn finish_game(ctx: Context<FinishGame>, winner: Pubkey) -> Result<()> {
        let game = &mut ctx.accounts.game;

        msg!(
            "finish_game: game_id={}, status={:?}, winner_param={}, game.player1={}, game.player2={}",
            game.game_id,
            game.status,
            winner,
            game.player1,
            game.player2
        );

        require!(game.status == GameStatus::Active, ErrorCode::GameNotActive);

        // Гарантируем, что это действительно те самые игроки
        require_keys_eq!(
            ctx.accounts.player1.key(),
            game.player1,
            ErrorCode::InvalidPlayer1
        );
        require_keys_eq!(
            ctx.accounts.player2.key(),
            game.player2,
            ErrorCode::InvalidPlayer2
        );

        // Победителем может быть только один из двух игроков.
        require!(
            winner == game.player1 || winner == game.player2,
            ErrorCode::InvalidWinner
        );

        let pot = game.pot_lamports;

        // Определяем, чей аккаунт победителя пополнить
        let winner_account_info = if winner == game.player1 {
            msg!(
                "finish_game: winner is player1={}, pot_lamports={}",
                game.player1,
                pot
            );
            ctx.accounts.player1.to_account_info()
        } else {
            msg!(
                "finish_game: winner is player2={}, pot_lamports={}",
                game.player2,
                pot
            );
            ctx.accounts.player2.to_account_info()
        };

        // Переводим весь банк победителю
        **game.to_account_info().try_borrow_mut_lamports()? -= pot;
        **winner_account_info.try_borrow_mut_lamports()? += pot;

        game.pot_lamports = 0;
        game.status = GameStatus::Finished;
        game.winner = winner;

        msg!(
            "finish_game: completed, game_id={}, final_status={:?}, winner={}",
            game.game_id,
            game.status,
            game.winner
        );

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
    pub move_index: u64,          // 8
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
/// Для логирования через `{:?}` добавляем также Debug.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum GameStatus {
    WaitingForPlayer2,
    Active,
    Finished,
}

/// Контекст для присоединения второго игрока.
#[derive(Accounts)]
pub struct JoinGame<'info> {
    /// Аккаунт игры. Уже должен быть инициализирован через init_game.
    #[account(mut)]
    pub game: Account<'info, GameState>,

    /// Второй игрок, вносит свою стартовую ставку.
    #[account(mut)]
    pub player2: Signer<'info>,

    /// Системная программа Solana.
    pub system_program: Program<'info, System>,
}

/// Контекст для совершения хода.
#[derive(Accounts)]
pub struct MakeMove<'info> {
    /// Аккаунт игры.
    #[account(mut)]
    pub game: Account<'info, GameState>,

    /// Первый игрок, должен совпадать с game.player1.
    #[account(mut, address = game.player1)]
    pub player1: Signer<'info>,

    /// Второй игрок, должен совпадать с game.player2.
    #[account(mut, address = game.player2)]
    pub player2: Signer<'info>,
}

/// Контекст для завершения игры и вывода банка победителю.
#[derive(Accounts)]
pub struct FinishGame<'info> {
    /// Аккаунт игры.
    #[account(mut)]
    pub game: Account<'info, GameState>,

    /// Первый игрок, должен совпадать с game.player1.
    #[account(mut, address = game.player1)]
    pub player1: Signer<'info>,

    /// Второй игрок, должен совпадать с game.player2.
    #[account(mut, address = game.player2)]
    pub player2: Signer<'info>,
}

/// Коды ошибок для удобной диагностики.
#[error_code]
pub enum ErrorCode {
    #[msg("Game is not waiting for player 2")]
    GameNotWaitingForPlayer2,

    #[msg("Invalid player 2")]
    InvalidPlayer2,

    #[msg("Game is not active")]
    GameNotActive,

    #[msg("It's not this player's turn")]
    NotPlayersTurn,

    #[msg("Invalid current_turn value")]
    InvalidCurrentTurn,

    #[msg("Math overflow")]
    MathOverflow,

    #[msg("Invalid winner")]
    InvalidWinner,
    
    #[msg("Invalid player 1")]
    InvalidPlayer1,
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

