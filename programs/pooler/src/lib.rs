use anchor_lang::prelude::*;
use anchor_lang::system_program;

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
        game.player1_deposit = 0;
        game.player2_deposit = 0;
        game.player1_fees_paid = 0;
        game.player2_fees_paid = 0;
        game.board_state = initial_board_state;
        game.current_turn = 1;
        game.status = GameStatus::WaitingForPlayer2;
        game.winner = Pubkey::default();
        // Для упрощения в учебном примере не используем PDA seeds для аккаунта игры,
        // поэтому bump просто ставим в 0.
        game.bump = 0;
        game.move_index = 0;
        game.last_activity_slot = Clock::get()?.slot;

        msg!(
            "init_game: GameState initialized: status={:?}, current_turn={}, pot_lamports={}, bump={}",
            game.status,
            game.current_turn,
            game.pot_lamports,
            game.bump
        );

        // Забираем ставку у первого игрока в аккаунт игры через CPI в системную программу.
        let cpi_accounts = system_program::Transfer {
            from: ctx.accounts.player1.to_account_info(),
            to: game.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(ctx.accounts.system_program.to_account_info(), cpi_accounts);
        system_program::transfer(cpi_ctx, stake_lamports)?;

        game.pot_lamports = game
            .pot_lamports
            .checked_add(stake_lamports)
            .ok_or(ErrorCode::MathOverflow)?;
        game.player1_deposit = game
            .player1_deposit
            .checked_add(stake_lamports)
            .ok_or(ErrorCode::MathOverflow)?;

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

        let cpi_accounts = system_program::Transfer {
            from: ctx.accounts.player2.to_account_info(),
            to: game.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(ctx.accounts.system_program.to_account_info(), cpi_accounts);
        system_program::transfer(cpi_ctx, stake)?;

        game.pot_lamports = game
            .pot_lamports
            .checked_add(stake)
            .ok_or(ErrorCode::MathOverflow)?;
        game.player2_deposit = game
            .player2_deposit
            .checked_add(stake)
            .ok_or(ErrorCode::MathOverflow)?;

        game.last_activity_slot = Clock::get()?.slot;
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

        // Проверяем, что у игрока достаточно средств для оплаты хода.
        let from_lamports = **current_player_signer.to_account_info().lamports.borrow();
        require!(
            from_lamports >= move_fee,
            ErrorCode::NotEnoughBalanceForMove
        );

        let cpi_accounts = system_program::Transfer {
            from: current_player_signer.to_account_info(),
            to: game.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(ctx.accounts.system_program.to_account_info(), cpi_accounts);
        system_program::transfer(cpi_ctx, move_fee)?;
        game.pot_lamports = game
            .pot_lamports
            .checked_add(move_fee)
            .ok_or(ErrorCode::MathOverflow)?;

        // Обновляем, кто сколько заплатил комиссий за ходы.
        match game.current_turn {
            1 => {
                game.player1_fees_paid = game
                    .player1_fees_paid
                    .checked_add(move_fee)
                    .ok_or(ErrorCode::MathOverflow)?;
            }
            2 => {
                game.player2_fees_paid = game
                    .player2_fees_paid
                    .checked_add(move_fee)
                    .ok_or(ErrorCode::MathOverflow)?;
            }
            _ => {}
        }

        // Обновляем состояние доски (валидация оффчейн)
        game.board_state = new_board_state;

        // Увеличиваем счётчик ходов
        game.move_index = game
            .move_index
            .checked_add(1)
            .ok_or(ErrorCode::MathOverflow)?;

        // Переключаем очередь хода
        game.current_turn = if game.current_turn == 1 { 2 } else { 1 };

        // Обновляем время последней активности (используется для force_refund)
        game.last_activity_slot = Clock::get()?.slot;

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
        let (winner_account_info, winner_label) = if winner == game.player1 {
            msg!(
                "finish_game: winner is player1={}, pot_lamports={}",
                game.player1,
                pot
            );
            (ctx.accounts.player1.to_account_info(), "player1")
        } else {
            msg!(
                "finish_game: winner is player2={}, pot_lamports={}",
                game.player2,
                pot
            );
            (ctx.accounts.player2.to_account_info(), "player2")
        };

        // Переводим весь банк победителю напрямую, т.к. аккаунт игры принадлежит нашей программе.
        **game.to_account_info().try_borrow_mut_lamports()? -= pot;
        **winner_account_info.try_borrow_mut_lamports()? += pot;

        game.pot_lamports = 0;
        game.status = GameStatus::Finished;
        game.winner = winner;

        msg!(
            "finish_game: completed, game_id={}, final_status={:?}, winner={} ({})",
            game.game_id,
            game.status,
            game.winner,
            winner_label
        );

        Ok(())
    }

    /// Отмена игры до присоединения второго игрока.
    ///
    /// Используется для случая, когда второй игрок так и не зашёл в игру.
    /// Возвращает весь банк (ставку) первому игроку.
    pub fn cancel_before_join(ctx: Context<CancelBeforeJoin>) -> Result<()> {
        let game = &mut ctx.accounts.game;

        require!(
            game.status == GameStatus::WaitingForPlayer2,
            ErrorCode::GameNotWaitingForPlayer2
        );

        let amount = game.pot_lamports;
        msg!(
            "cancel_before_join: refunding {} lamports to player1={}",
            amount,
            game.player1
        );

        // Переводим банк обратно игроку напрямую (аккаунт игры принадлежит нашей программе).
        **game.to_account_info().try_borrow_mut_lamports()? -= amount;
        **ctx
            .accounts
            .player1
            .to_account_info()
            .try_borrow_mut_lamports()? += amount;

        game.pot_lamports = 0;
        game.player1_deposit = 0;
        game.status = GameStatus::Finished;

        Ok(())
    }

    /// Аварийный возврат средств обоим игрокам по тайм-ауту.
    ///
    /// Если игра зависла в Active (кто-то не ходит / не подписывает),
    /// и с момента последнего действия прошло достаточно слотов, то
    /// банк делится между игроками пропорционально их вкладам.
    pub fn force_refund(ctx: Context<ForceRefund>) -> Result<()> {
        let game = &mut ctx.accounts.game;

        require!(game.status == GameStatus::Active, ErrorCode::GameNotActive);

        let current_slot = Clock::get()?.slot;
        let last = game.last_activity_slot;

        msg!(
            "force_refund: current_slot={}, last_activity_slot={}",
            current_slot,
            last
        );

        require!(
            current_slot
                .checked_sub(last)
                .ok_or(ErrorCode::MathOverflow)?
                >= FORCE_REFUND_TIMEOUT_SLOTS,
            ErrorCode::TimeoutNotReached
        );

        let total_p1 = game
            .player1_deposit
            .checked_add(game.player1_fees_paid)
            .ok_or(ErrorCode::MathOverflow)?;
        let total_p2 = game
            .player2_deposit
            .checked_add(game.player2_fees_paid)
            .ok_or(ErrorCode::MathOverflow)?;

        let pot = game.pot_lamports;
        msg!(
            "force_refund: pot={}, total_p1={}, total_p2={}",
            pot,
            total_p1,
            total_p2
        );

        let total = total_p1
            .checked_add(total_p2)
            .ok_or(ErrorCode::MathOverflow)?;
        require!(total == pot, ErrorCode::InconsistentPot);

        // Возвращаем каждому ровно его вклад. Аккаунт игры принадлежит нашей программе,
        // поэтому можем напрямую изменять его баланс.
        if total_p1 > 0 {
            **game.to_account_info().try_borrow_mut_lamports()? -= total_p1;
            **ctx
                .accounts
                .player1
                .to_account_info()
                .try_borrow_mut_lamports()? += total_p1;
        }

        if total_p2 > 0 {
            **game.to_account_info().try_borrow_mut_lamports()? -= total_p2;
            **ctx
                .accounts
                .player2
                .to_account_info()
                .try_borrow_mut_lamports()? += total_p2;
        }

        game.pot_lamports = 0;
        game.player1_deposit = 0;
        game.player2_deposit = 0;
        game.player1_fees_paid = 0;
        game.player2_fees_paid = 0;
        game.status = GameStatus::Finished;

        Ok(())
    }

    /// Ручной (взаимный) возврат средств обоим игрокам без тайм-аута.
    ///
    /// Требует подписи ОБОИХ игроков. Логика распределения средств
    /// такая же, как в force_refund: каждый получает свой депозит +
    /// все уплаченные им ходы, при этом сумма вкладов должна совпадать с pot_lamports.
    pub fn manual_refund(ctx: Context<ForceRefund>) -> Result<()> {
        let game = &mut ctx.accounts.game;

        require!(game.status == GameStatus::Active, ErrorCode::GameNotActive);

        let total_p1 = game
            .player1_deposit
            .checked_add(game.player1_fees_paid)
            .ok_or(ErrorCode::MathOverflow)?;
        let total_p2 = game
            .player2_deposit
            .checked_add(game.player2_fees_paid)
            .ok_or(ErrorCode::MathOverflow)?;

        let pot = game.pot_lamports;
        msg!(
            "manual_refund: pot={}, total_p1={}, total_p2={}",
            pot,
            total_p1,
            total_p2
        );

        let total = total_p1
            .checked_add(total_p2)
            .ok_or(ErrorCode::MathOverflow)?;
        require!(total == pot, ErrorCode::InconsistentPot);

        // Возвращаем каждому ровно его вклад.
        if total_p1 > 0 {
            **game.to_account_info().try_borrow_mut_lamports()? -= total_p1;
            **ctx
                .accounts
                .player1
                .to_account_info()
                .try_borrow_mut_lamports()? += total_p1;
        }

        if total_p2 > 0 {
            **game.to_account_info().try_borrow_mut_lamports()? -= total_p2;
            **ctx
                .accounts
                .player2
                .to_account_info()
                .try_borrow_mut_lamports()? += total_p2;
        }

        game.pot_lamports = 0;
        game.player1_deposit = 0;
        game.player2_deposit = 0;
        game.player1_fees_paid = 0;
        game.player2_fees_paid = 0;
        game.status = GameStatus::Finished;

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
    pub player1_deposit: u64,     // 8
    pub player2_deposit: u64,     // 8
    pub player1_fees_paid: u64,   // 8
    pub player2_fees_paid: u64,   // 8
    pub last_activity_slot: u64,  // 8
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

/// Тайм-аут в слотах для аварийного возврата средств.
/// Для демо на localnet держим маленьким (например, 5 слотов).
pub const FORCE_REFUND_TIMEOUT_SLOTS: u64 = 5;

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

/// Отмена игры до присоединения второго игрока.
#[derive(Accounts)]
pub struct CancelBeforeJoin<'info> {
    /// Аккаунт игры.
    #[account(mut)]
    pub game: Account<'info, GameState>,

    /// Первый игрок, который создавал игру и может её отменить.
    #[account(mut, address = game.player1)]
    pub player1: Signer<'info>,

    /// Системная программа Solana.
    pub system_program: Program<'info, System>,
}

/// Аварийный возврат средств обоим игрокам по тайм-ауту.
#[derive(Accounts)]
pub struct ForceRefund<'info> {
    /// Аккаунт игры.
    #[account(mut)]
    pub game: Account<'info, GameState>,

    /// Первый игрок.
    #[account(mut, address = game.player1)]
    pub player1: Signer<'info>,

    /// Второй игрок.
    #[account(mut, address = game.player2)]
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

    /// Системная программа Solana, нужна для transfer через CPI.
    pub system_program: Program<'info, System>,
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

    /// Системная программа Solana, нужна для transfer через CPI.
    pub system_program: Program<'info, System>,
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

    #[msg("Not enough balance to pay move fee")]
    NotEnoughBalanceForMove,

    #[msg("Force refund timeout not reached yet")]
    TimeoutNotReached,

    #[msg("Inconsistent pot and recorded contributions")]
    InconsistentPot,
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
    )]
    pub game: Account<'info, GameState>,

    /// Первый игрок, он платит за создание аккаунта и вносит первую ставку.
    #[account(mut)]
    pub player1: Signer<'info>,

    /// Стандартная системная программа Solana, нужна для создания аккаунта.
    pub system_program: Program<'info, System>,
}

