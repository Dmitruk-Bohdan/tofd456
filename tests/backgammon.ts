import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import * as fs from "fs";
import { Backgammon } from "../target/types/backgammon";

function loadKeypair(path: string): Keypair {
  const secret = JSON.parse(fs.readFileSync(path, "utf8"));
  const secretKey = Uint8Array.from(secret);
  return Keypair.fromSecretKey(secretKey);
}

describe("backgammon program basic flow", () => {
  // Настраиваем Anchor провайдер из окружения (Anchor.toml + solana config)
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Backgammon as Program<Backgammon>;

  // Игроки – читаем заранее созданные ключи
  const player1 = loadKeypair("keys/player1/player1.json");
  const player2 = loadKeypair("keys/player2/player2.json");

  // Параметры игры (в лампортах)
  const stakeLamportsNumber = 0.5 * anchor.web3.LAMPORTS_PER_SOL;
  const moveFeeLamportsNumber = 0.01 * anchor.web3.LAMPORTS_PER_SOL;

  it("runs init_game -> join_game -> make_move x2 -> finish_game", async () => {
    const connection = provider.connection;

    // Минимальный баланс: ставка + 2 хода * комиссия + небольшой запас
    const minRequiredLamportsPerPlayer =
      stakeLamportsNumber + 2 * moveFeeLamportsNumber + 0.1 * anchor.web3.LAMPORTS_PER_SOL;

    for (const kp of [player1, player2]) {
      const balance = await connection.getBalance(kp.publicKey);
      if (balance < minRequiredLamportsPerPlayer) {
        const toAirdrop = minRequiredLamportsPerPlayer - balance;
        console.log(
          `Airdropping ${toAirdrop} lamports to ${kp.publicKey.toBase58()} (old balance=${balance})`
        );
        const sig = await connection.requestAirdrop(kp.publicKey, toAirdrop);
        await connection.confirmTransaction(sig, "confirmed");
      }
    }

    const gameId = new anchor.BN(1);
    const stakeLamports = new anchor.BN(stakeLamportsNumber);
    const moveFeeLamports = new anchor.BN(moveFeeLamportsNumber);

    // Начальное состояние доски – просто заглушка из нулей длиной 64
    const initialBoardState = new Array<number>(64).fill(0);

    // PDA аккаунта игры: seeds = ["game", player1, player2, game_id_le_bytes]
    const [gamePda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("game"),
        player1.publicKey.toBuffer(),
        player2.publicKey.toBuffer(),
        Buffer.from(gameId.toArray("le", 8)),
      ],
      program.programId
    );

    // ---------------- init_game ----------------
    await program.methods
      .initGame(
        gameId,
        stakeLamports,
        moveFeeLamports,
        player2.publicKey,
        initialBoardState
      )
      .accounts({
        game: gamePda,
        player1: player1.publicKey,
        systemProgram: SystemProgram.programId,
      } as any)
      .signers([player1])
      .rpc();

    let gameAccount = await program.account.gameState.fetch(gamePda);
    console.log("After init_game:", {
      pot_lamports: gameAccount.potLamports.toString(),
      status: gameAccount.status,
      current_turn: gameAccount.currentTurn,
    });

    // ---------------- join_game ----------------
    await program.methods
      .joinGame()
      .accounts({
        game: gamePda,
        player2: player2.publicKey,
        systemProgram: SystemProgram.programId,
      } as any)
      .signers([player2])
      .rpc();

    gameAccount = await program.account.gameState.fetch(gamePda);
    console.log("After join_game:", {
      pot_lamports: gameAccount.potLamports.toString(),
      status: gameAccount.status,
      current_turn: gameAccount.currentTurn,
    });

    // ---------------- make_move #1 (ходит player1) ----------------
    const boardAfterMove1 = [...initialBoardState];
    boardAfterMove1[0] = 1; // условный ход

    await program.methods
      .makeMove(boardAfterMove1)
      .accounts({
        game: gamePda,
        player1: player1.publicKey,
        player2: player2.publicKey,
      })
      .signers([player1, player2])
      .rpc();

    gameAccount = await program.account.gameState.fetch(gamePda);
    console.log("After make_move #1:", {
      pot_lamports: gameAccount.potLamports.toString(),
      status: gameAccount.status,
      current_turn: gameAccount.currentTurn,
      move_index: gameAccount.moveIndex.toString(),
    });

    // ---------------- make_move #2 (ходит player2) ----------------
    const boardAfterMove2 = [...boardAfterMove1];
    boardAfterMove2[1] = 2; // условный ход

    await program.methods
      .makeMove(boardAfterMove2)
      .accounts({
        game: gamePda,
        player1: player1.publicKey,
        player2: player2.publicKey,
      })
      .signers([player1, player2])
      .rpc();

    gameAccount = await program.account.gameState.fetch(gamePda);
    console.log("After make_move #2:", {
      pot_lamports: gameAccount.potLamports.toString(),
      status: gameAccount.status,
      current_turn: gameAccount.currentTurn,
      move_index: gameAccount.moveIndex.toString(),
    });

    // ---------------- finish_game (выиграл player1) ----------------
    await program.methods
      .finishGame(player1.publicKey)
      .accounts({
        game: gamePda,
        player1: player1.publicKey,
        player2: player2.publicKey,
      })
      .signers([player1, player2])
      .rpc();

    gameAccount = await program.account.gameState.fetch(gamePda);
    console.log("After finish_game:", {
      pot_lamports: gameAccount.potLamports.toString(),
      status: gameAccount.status,
      winner: gameAccount.winner.toBase58(),
    });
  });
});

