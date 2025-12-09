import * as anchor from "@coral-xyz/anchor";
import { Program, Wallet } from "@coral-xyz/anchor";
import { Keypair, SystemProgram } from "@solana/web3.js";
import * as fs from "fs";
import { Backgammon } from "../target/types/backgammon";

function loadKeypair(path: string): Keypair {
  const secret = JSON.parse(fs.readFileSync(path, "utf8"));
  const secretKey = Uint8Array.from(secret);
  return Keypair.fromSecretKey(secretKey);
}

async function main() {
  const connection = new anchor.web3.Connection("http://127.0.0.1:8899", "confirmed");

  const mainAuthority = loadKeypair("keys/main-authority/main-authority.json");
  const wallet = new Wallet(mainAuthority);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    preflightCommitment: "confirmed",
  });
  anchor.setProvider(provider);

  const program = anchor.workspace.Backgammon as Program<Backgammon>;

  const player1 = loadKeypair("keys/player1/player1.json");
  const player2 = loadKeypair("keys/player2/player2.json"); // не используется, но читаем для полноты
  const game = Keypair.generate();

  const stakeLamportsNumber = 0.5 * anchor.web3.LAMPORTS_PER_SOL;
  const moveFeeLamportsNumber = 0.01 * anchor.web3.LAMPORTS_PER_SOL;

  const minRequiredLamportsPlayer1 =
    stakeLamportsNumber + 2 * moveFeeLamportsNumber + 0.1 * anchor.web3.LAMPORTS_PER_SOL;

  // Баланс до начала
  const balance1_before = await connection.getBalance(player1.publicKey);
  console.log("Player1 balance before init_game:", balance1_before / anchor.web3.LAMPORTS_PER_SOL, "SOL");

  if (balance1_before < minRequiredLamportsPlayer1) {
    const toAirdrop = minRequiredLamportsPlayer1 - balance1_before;
    console.log(
      `Airdropping ${toAirdrop} lamports to player1=${player1.publicKey.toBase58()} (old balance=${balance1_before})`
    );
    const sig = await connection.requestAirdrop(player1.publicKey, toAirdrop);
    await connection.confirmTransaction(sig, "confirmed");
  }

  const gameId = new anchor.BN(1);
  const stakeLamports = new anchor.BN(stakeLamportsNumber);
  const moveFeeLamports = new anchor.BN(moveFeeLamportsNumber);

  // init_game
  await program.methods
    .initGame(
      gameId,
      stakeLamports,
      moveFeeLamports,
      player2.publicKey
    )
    .accounts({
      game: game.publicKey,
      player1: player1.publicKey,
      systemProgram: SystemProgram.programId,
    } as any)
    .signers([player1, game])
    .rpc();

  console.log("Game account pubkey:", game.publicKey.toBase58());

  let gameAccount = await program.account.gameState.fetch(game.publicKey);
  console.log("After init_game:", {
    pot_sol: Number(gameAccount.potLamports) / anchor.web3.LAMPORTS_PER_SOL,
    status: gameAccount.status,
    current_turn: gameAccount.currentTurn,
  });

  const balance1_after_init = await connection.getBalance(player1.publicKey);
  console.log("Player1 balance after init_game:", balance1_after_init / anchor.web3.LAMPORTS_PER_SOL, "SOL");

  // cancel_before_join
  await program.methods
    .cancelBeforeJoin()
    .accounts({
      game: game.publicKey,
      player1: player1.publicKey,
      systemProgram: SystemProgram.programId,
    } as any)
    .signers([player1])
    .rpc();

  gameAccount = await program.account.gameState.fetch(game.publicKey);
  console.log("After cancel_before_join:", {
    pot_sol: Number(gameAccount.potLamports) / anchor.web3.LAMPORTS_PER_SOL,
    status: gameAccount.status,
  });

  const balance1_after_cancel = await connection.getBalance(player1.publicKey);
  console.log("Player1 balance after cancel_before_join:", balance1_after_cancel / anchor.web3.LAMPORTS_PER_SOL, "SOL");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});


