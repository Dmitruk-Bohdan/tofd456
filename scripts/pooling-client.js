"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
const anchor = __importStar(require("@coral-xyz/anchor"));
const web3_js_1 = require("@solana/web3.js");
const spl_token_1 = require("@solana/spl-token");
const PROGRAM_ID = new web3_js_1.PublicKey("DmEwwQX5n6mt2Hgv923xmVLDQpWWcvYmTcm3yJbZ5xRr");
function main() {
    return __awaiter(this, void 0, void 0, function* () {
        const provider = anchor.AnchorProvider.env();
        anchor.setProvider(provider);
        const program = anchor.workspace.pooling;
        const tokenMint = new web3_js_1.PublicKey("FnAm65TW1YzAsdc8TKonKm25vahE31HHM7QZzWuZsku8");
        const authority = provider.wallet.publicKey;
        const [poolPDA, poolBump] = web3_js_1.PublicKey.findProgramAddressSync([Buffer.from("pool"), tokenMint.toBuffer()], PROGRAM_ID);
        console.log("Pool PDA:", poolPDA.toBase58());
        // users ATA
        const authorityTokenAta = yield (0, spl_token_1.getAssociatedTokenAddress)(tokenMint, authority);
        const authorityWsolAta = yield (0, spl_token_1.getAssociatedTokenAddress)(spl_token_1.NATIVE_MINT, authority);
        console.log("Authority token ATA:", authorityTokenAta.toBase58());
        console.log("Authority WSOL ATA:", authorityWsolAta.toBase58());
        // Initialize pool
        const tokenAmount = new anchor.BN(10 * Math.pow(10, 8));
        const wsolAmount = new anchor.BN(0.01 * web3_js_1.LAMPORTS_PER_SOL);
        try {
            yield program.methods
                .initialize(tokenAmount, wsolAmount)
                .accounts({
                authority: authority,
                tokenMint: tokenMint,
            })
                .rpc();
            console.log("Pool initialized with liquidity");
        }
        catch (e) {
            console.log("Pool may already exist");
        }
        yield new Promise((resolve) => setTimeout(resolve, 2000));
        const userTokenAta = yield (0, spl_token_1.getAssociatedTokenAddress)(tokenMint, authority);
        const userWsolAta = yield (0, spl_token_1.getAssociatedTokenAddress)(spl_token_1.NATIVE_MINT, authority);
        const beforeTokenBalance = yield provider.connection.getTokenAccountBalance(authorityTokenAta);
        const beforeWsolBalance = yield provider.connection.getTokenAccountBalance(authorityWsolAta);
        console.log();
        console.log("Before buy");
        console.log("User token balance:", beforeTokenBalance.value.uiAmount, "(mint:", tokenMint.toBase58() + ")");
        console.log("User WSOL balance:", beforeWsolBalance.value.uiAmount, "(mint: So11111111111111111111111111111111111111112)");
        // Buy
        const buyWsolAmount = new anchor.BN(0.0001 * web3_js_1.LAMPORTS_PER_SOL);
        yield program.methods
            .buy(buyWsolAmount)
            .accounts({
            user: authority,
            tokenMint: tokenMint,
        })
            .signers([provider.wallet.payer])
            .rpc();
        console.log("Buy executed: WSOL -> tokens");
        let userTokenBalance = yield provider.connection.getTokenAccountBalance(userTokenAta);
        let userWsolBalance = yield provider.connection.getTokenAccountBalance(userWsolAta);
        console.log();
        console.log("After buy");
        console.log("User token balance:", userTokenBalance.value.uiAmount, "(mint:", tokenMint.toBase58() + ")");
        console.log("User WSOL balance:", userWsolBalance.value.uiAmount, "(mint: So11111111111111111111111111111111111111112)");
        // Sell
        const sellTokenAmount = new anchor.BN(0.1 * Math.pow(10, 8));
        yield program.methods
            .sell(sellTokenAmount)
            .accounts({
            user: authority,
            tokenMint: tokenMint,
        })
            .signers([provider.wallet.payer])
            .rpc();
        console.log("Sell executed: tokens -> WSOL");
        userTokenBalance = yield provider.connection.getTokenAccountBalance(userTokenAta);
        userWsolBalance = yield provider.connection.getTokenAccountBalance(userWsolAta);
        console.log();
        console.log("After sell");
        console.log("User token balance:", userTokenBalance.value.uiAmount, "(mint:", tokenMint.toBase58() + ")");
        console.log("User WSOL balance:", userWsolBalance.value.uiAmount, "(mint: So11111111111111111111111111111111111111112)");
    });
}
main().catch(console.error);
