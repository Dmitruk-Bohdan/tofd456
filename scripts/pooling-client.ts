import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  PublicKey,
  Keypair,
  SystemProgram,
  LAMPORTS_PER_SOL,
  Transaction,
} from "@solana/web3.js";
import {
  NATIVE_MINT,
  getAssociatedTokenAddress,
} from "@solana/spl-token";
import { Pooling } from "../target/types/pooling";

const PROGRAM_ID = new PublicKey("DmEwwQX5n6mt2Hgv923xmVLDQpWWcvYmTcm3yJbZ5xRr");

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.pooling as Program<Pooling>;

  const tokenMint = new PublicKey("FnAm65TW1YzAsdc8TKonKm25vahE31HHM7QZzWuZsku8");

  const authority = provider.wallet.publicKey;

  const [poolPDA, poolBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), tokenMint.toBuffer()],
    PROGRAM_ID
  );

  console.log("Pool PDA:", poolPDA.toBase58());


  // users ATA
  const authorityTokenAta = await getAssociatedTokenAddress(tokenMint, authority);
  const authorityWsolAta = await getAssociatedTokenAddress(NATIVE_MINT, authority);

  console.log("Authority token ATA:", authorityTokenAta.toBase58());
  console.log("Authority WSOL ATA:", authorityWsolAta.toBase58());

  // Initialize pool
  const tokenAmount = new anchor.BN(10 * 10 ** 8); 
  const wsolAmount = new anchor.BN(0.01 * LAMPORTS_PER_SOL); 

  try {
    await program.methods
      .initialize(tokenAmount, wsolAmount)
      .accounts({
        authority: authority,
        tokenMint: tokenMint,
      })
      .rpc();
    console.log("Pool initialized with liquidity");
  } catch (e) {
    console.log("Pool may already exist");
  }

  await new Promise((resolve) => setTimeout(resolve, 2000));

  const userTokenAta = await getAssociatedTokenAddress(tokenMint, authority);
  const userWsolAta = await getAssociatedTokenAddress(NATIVE_MINT, authority);

  const beforeTokenBalance = await provider.connection.getTokenAccountBalance(authorityTokenAta);
  const beforeWsolBalance = await provider.connection.getTokenAccountBalance(authorityWsolAta);

  console.log();
  console.log("Before buy");
  console.log("User token balance:", beforeTokenBalance.value.uiAmount, "(mint:", tokenMint.toBase58() + ")");
  console.log("User WSOL balance:", beforeWsolBalance.value.uiAmount, "(mint: So11111111111111111111111111111111111111112)");

  // Buy
  const buyWsolAmount = new anchor.BN(0.0001 * LAMPORTS_PER_SOL);

  await program.methods
    .buy(buyWsolAmount)
    .accounts({
      user: authority,
      tokenMint: tokenMint,
    })
    .signers([provider.wallet.payer])
    .rpc();

  console.log("Buy executed: WSOL -> tokens");

  let userTokenBalance = await provider.connection.getTokenAccountBalance(userTokenAta);
  let userWsolBalance  = await provider.connection.getTokenAccountBalance(userWsolAta);

  console.log();
  console.log("After buy");
  console.log("User token balance:", userTokenBalance.value.uiAmount, "(mint:", tokenMint.toBase58() + ")");
  console.log("User WSOL balance:", userWsolBalance.value.uiAmount, "(mint: So11111111111111111111111111111111111111112)");

  // Sell
  const sellTokenAmount = new anchor.BN(0.1 * 10 ** 8);
  await program.methods
    .sell(sellTokenAmount)
    .accounts({
      user: authority,
      tokenMint: tokenMint,
    })
    .signers([provider.wallet.payer])
    .rpc();

  console.log("Sell executed: tokens -> WSOL");


  userTokenBalance = await provider.connection.getTokenAccountBalance(userTokenAta);
  userWsolBalance  = await provider.connection.getTokenAccountBalance(userWsolAta);

  console.log();
  console.log("After sell");
  console.log("User token balance:", userTokenBalance.value.uiAmount, "(mint:", tokenMint.toBase58() + ")");
  console.log("User WSOL balance:", userWsolBalance.value.uiAmount, "(mint: So11111111111111111111111111111111111111112)");

}

main().catch(console.error);
