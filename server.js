/* server.js - Swap via ParaSwap (underlying -> underlying) com logs e Swagger
   - NÃO usa aToken->aToken (isso não é o fluxo real da Aave Collateral Swap)
   - Assina transação com PRIVATE KEY (ou use o modo "unsigned" e assine no front)
*/

import "dotenv/config";
import express from "express";
import cors from "cors";
import axios from "axios";
import swaggerUi from "swagger-ui-express";
import { ethers } from "ethers";

// =========================
// Config
// =========================
const PORT = Number(process.env.PORT || 8080);
const RPC_URL = process.env.RPC_URL || "";
const PRIVATE_KEY = process.env.PRIVATE_KEY || "";

// ParaSwap v5 (mais comum). Se você já usa outro, troca aqui.
const PARASWAP_BASE = process.env.PARASWAP_BASE || "https://apiv5.paraswap.io";

// Arbitrum chainId
const CHAIN_ID = Number(process.env.CHAIN_ID || 42161);

if (!RPC_URL) {
  console.error("❌ Missing RPC_URL in env");
}
const provider = RPC_URL ? new ethers.JsonRpcProvider(RPC_URL) : null;
const signer = (provider && PRIVATE_KEY) ? new ethers.Wallet(PRIVATE_KEY, provider) : null;

// ERC20 minimal
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner,address spender) view returns (uint256)",
  "function approve(address spender,uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)"
];

// =========================
// App + middlewares
// =========================
const app = express();

// CORS (você sempre pede isso)
app.use(cors({ origin: "*", methods: ["GET", "POST", "OPTIONS"], allowedHeaders: ["Content-Type", "Authorization"] }));

// IMPORTANTÍSSIMO: JSON parse robusto (corrige seu erro "Unexpected number in JSON")
app.use(express.json({
  limit: "2mb",
  strict: true
}));

// handler de erro do JSON parse (pra voltar erro limpo)
app.use((err, req, res, next) => {
  if (err?.type === "entity.parse.failed") {
    return res.status(400).json({
      ok: false,
      error: "JSON inválido no body. Confira vírgulas, aspas e se está enviando application/json.",
      details: err.message
    });
  }
  next(err);
});

// health
app.get("/", (req, res) => res.json({ ok: true, service: "swap-aave (paraswap underlying)", chainId: CHAIN_ID }));

// =========================
// Swagger
// =========================
const swaggerDoc = {
  openapi: "3.0.0",
  info: { title: "Swap Service (ParaSwap) - Arbitrum", version: "1.0.0" },
  servers: [{ url: "/" }],
  paths: {
    "/swap": {
      post: {
        summary: "Swap token -> token via ParaSwap (assinado no servidor se PRIVATE_KEY existir)",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["wallet", "tokenFrom", "tokenTo", "amountWei", "slippageBps"],
                properties: {
                  wallet: { type: "string", example: "0x4682beffFE9d3BCDa67cC6a8aDBb437Dcc46219F" },
                  tokenFrom: { type: "string", example: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9" }, // USDT
                  tokenTo: { type: "string", example: "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f" },   // WBTC
                  amountWei: { type: "string", example: "18703660" },
                  slippageBps: { type: "integer", example: 120 },
                  excludeDexs: { type: "array", items: { type: "string" }, example: ["Dexalot"] },
                  unsignedOnly: { type: "boolean", example: false, description: "Se true, retorna txData para assinar no front (sem usar PRIVATE_KEY no servidor)." }
                }
              }
            }
          }
        },
        responses: {
          "200": { description: "Ok" },
          "400": { description: "Erro de validação / ParaSwap" },
          "500": { description: "Erro interno" }
        }
      }
    }
  }
};

app.use("/docs", swaggerUi.serve, swaggerUi.setup(swaggerDoc));

// =========================
// Helpers
// =========================
function mkLogBag() {
  const logs = [];
  const push = (tag, obj) => logs.push(`${tag} | ${JSON.stringify(obj)}`);
  return { logs, push };
}

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

function assertAddr(a, name) {
  try {
    return ethers.getAddress(a);
  } catch {
    throw badRequest(`Endereço inválido em ${name}: ${a}`);
  }
}

async function erc20(addr) {
  if (!provider) throw new Error("Provider não inicializado (RPC_URL faltando?)");
  return new ethers.Contract(addr, ERC20_ABI, provider);
}

async function ensureAllowance({ token, owner, spender, neededWei, log, useSigner }) {
  const c = new ethers.Contract(token, ERC20_ABI, useSigner);
  const allowance = await c.allowance(owner, spender);
  log("ALLOWANCE", { spender, allowance: allowance.toString(), neededWei });

  if (allowance >= BigInt(neededWei)) return { approved: false };

  log("APPROVING", { spender, amount: "MaxUint256" });
  const tx = await c.approve(spender, ethers.MaxUint256);
  log("APPROVE_SENT", { hash: tx.hash });
  const rc = await tx.wait();
  log("APPROVE_CONFIRMED", { block: rc.blockNumber });
  return { approved: true };
}

// =========================
// Main endpoint
// =========================
app.post("/swap", async (req, res) => {
  const { logs, push } = mkLogBag();

  try {
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
      throw badRequest("Body inválido. Envie JSON com wallet, tokenFrom, tokenTo, amountWei e slippageBps.");
    }

    const requiredFields = ["wallet", "tokenFrom", "tokenTo", "amountWei", "slippageBps"];
    const missing = requiredFields.filter((k) => req.body[k] === undefined || req.body[k] === null || req.body[k] === "");
    if (missing.length) {
      throw badRequest(`Campos obrigatórios ausentes: ${missing.join(", ")}`);
    }

    const wallet = assertAddr(req.body.wallet, "wallet");
    const tokenFrom = assertAddr(req.body.tokenFrom, "tokenFrom");
    const tokenTo = assertAddr(req.body.tokenTo, "tokenTo");
    const amountWei = String(req.body.amountWei || "");
    const slippageBps = Number(req.body.slippageBps || 0);
    const excludeDexs = Array.isArray(req.body.excludeDexs) ? req.body.excludeDexs : [];
    const unsignedOnly = !!req.body.unsignedOnly;

    push("WALLET", { wallet, tokenFrom, tokenTo, amountWei, slippageBps, excludeDexs, unsignedOnly });

    if (!amountWei || !/^\d+$/.test(amountWei)) {
      return res.status(400).json({ ok: false, error: "amountWei inválido (use string numérica).", logs });
    }
    if (!slippageBps || slippageBps < 1 || slippageBps > 2000) {
      return res.status(400).json({ ok: false, error: "slippageBps inválido (1..2000).", logs });
    }

    // Se for assinar no servidor, precisa signer e o wallet precisa bater com o signer
    if (!unsignedOnly) {
      if (!signer) {
        return res.status(400).json({
          ok: false,
          error: "PRIVATE_KEY não configurada no servidor. Use unsignedOnly=true ou configure PRIVATE_KEY.",
          logs
        });
      }
      const signerAddr = await signer.getAddress();
      if (signerAddr.toLowerCase() !== wallet.toLowerCase()) {
        return res.status(400).json({
          ok: false,
          error: `wallet (${wallet}) não bate com o signer do servidor (${signerAddr}).`,
          logs
        });
      }
    }

    // 1) ParaSwap /prices
    const pricesParams = {
      srcToken: tokenFrom,
      destToken: tokenTo,
      amount: amountWei,
      side: "SELL",
      network: CHAIN_ID,
      userAddress: wallet,
      // IMPORTANT: ParaSwap usa "excludeDEXS" (string CSV) em algumas rotas,
      // e "excludeDexs" em outras. Aqui passamos como CSV e também no query.
      excludeDEXS: excludeDexs.join(",") || undefined,
      // slippage em /prices é ok pra rota + destAmount estimado
      slippage: (slippageBps / 100).toFixed(4) // porcentagem
    };

    push("PARASWAP_PRICES", pricesParams);

    const priceResp = await axios.get(`${PARASWAP_BASE}/prices`, {
      params: pricesParams,
      headers: { "Accept": "application/json" }
    });

    const priceRoute = priceResp.data;
    const destAmount = priceRoute?.priceRoute?.destAmount || priceRoute?.destAmount;

    const tokenTransferProxy =
      priceRoute?.priceRoute?.tokenTransferProxy ||
      priceRoute?.tokenTransferProxy;

    if (!destAmount || !tokenTransferProxy) {
      return res.status(400).json({
        ok: false,
        error: "ParaSwap não retornou destAmount/tokenTransferProxy. Sem rota/sem liquidez.",
        raw: priceRoute,
        logs
      });
    }

    push("PRICE_OK", { destAmount: String(destAmount), tokenTransferProxy });

    // 2) Approve (se for assinar no servidor)
    if (!unsignedOnly) {
      await ensureAllowance({
        token: tokenFrom,
        owner: wallet,
        spender: tokenTransferProxy,
        neededWei: amountWei,
        log: push,
        useSigner: signer
      });
    }

    // 3) ParaSwap /transactions
    // REGRA CRÍTICA:
    // - OU você manda "slippage" (percent)
    // - OU você manda "destAmount"
    // NUNCA ambos.
    //
    // Aqui vamos mandar APENAS slippage (e NÃO destAmount),
    // porque isso evita os erros: "Cannot specify both..." e "Missing slippage..."
    const txBody = {
      priceRoute: priceRoute.priceRoute || priceRoute,
      srcToken: tokenFrom,
      destToken: tokenTo,
      srcAmount: amountWei,
      userAddress: wallet,
      // slippage em percent (ex 1.2 para 1.2%)
      slippage: Number((slippageBps / 100).toFixed(4)),
      // não enviar: skipBalanceChecks (proibido)
      // não enviar: destAmount junto com slippage
      // opcional:
      partner: process.env.PARASWAP_PARTNER || undefined
    };

    push("PARASWAP_TX_BODY", { userAddress: wallet, slippage: txBody.slippage });

    const txResp = await axios.post(`${PARASWAP_BASE}/transactions/${CHAIN_ID}`, txBody, {
      headers: { "Content-Type": "application/json", "Accept": "application/json" }
    });

    const txData = txResp.data;
    if (!txData?.to || !txData?.data) {
      return res.status(400).json({ ok: false, error: "ParaSwap não retornou tx completa.", raw: txData, logs });
    }

    push("TX_OK", { to: txData.to, value: String(txData.value || "0"), gasPrice: txData.gasPrice, gas: txData.gas });

    // Se unsignedOnly, devolve a txData pro front assinar
    if (unsignedOnly) {
      return res.json({ ok: true, mode: "unsignedOnly", txData, destAmount: String(destAmount), logs });
    }

    // 4) Send tx onchain
    const tx = await signer.sendTransaction({
      to: txData.to,
      data: txData.data,
      value: BigInt(txData.value || "0"),
      // você pode deixar o provider estimar gas; se quiser usar o do ParaSwap:
      gasLimit: txData.gas ? BigInt(txData.gas) : undefined
    });

    push("SENT", { hash: tx.hash });

    const rc = await tx.wait();
    push("CONFIRMED", { block: rc.blockNumber, status: rc.status });

    return res.json({
      ok: true,
      hash: tx.hash,
      block: rc.blockNumber,
      status: rc.status,
      destAmount: String(destAmount),
      logs
    });

  } catch (e) {
    const msg = e?.response?.data?.error || e?.message || "Erro";
    const status = e?.response?.status || e?.status || 500;
    return res.status(status).json({
      ok: false,
      error: msg,
      details: e?.response?.data || null
    });
  }
});

// =========================
function startServerWithFallback() {
  const preferred = Number.isFinite(PORT) && PORT > 0 ? PORT : 8080;
  const candidates = [...new Set([preferred, 8080, 3000])];

  const tryListen = (index) => {
    const port = candidates[index];
    if (!port) {
      console.error("❌ Não foi possível iniciar o servidor: portas testadas indisponíveis.");
      process.exit(1);
    }

    const server = app.listen(port, () => {
      console.log(`✅ Server on :${port} (docs: /docs)`);
    });

    server.on("error", (err) => {
      if (err?.code === "EADDRINUSE") {
        console.error(`⚠️ Porta ${port} em uso. Tentando próxima porta...`);
        return tryListen(index + 1);
      }
      console.error("❌ Falha ao iniciar servidor:", err);
      process.exit(1);
    });
  };

  tryListen(0);
}

startServerWithFallback();
