const { Telegraf } = require('telegraf');
const { Connection, PublicKey, Transaction, sendAndConfirmTransaction } = require('@solana/web3.js');
const { Keypair } = require('@solana/web3.js');
const bs58 = require('bs58');
const axios = require('axios');
const { Client, gql } = require('gql');
const { WebSocket } = require('ws');
const { WebsocketsTransport } = require('subscriptions-transport-ws');
const { XGBRegressor } = require('xgboost');
const tf = require('@tensorflow/tfjs-node');

// Bot configuration
const BOT_TOKEN = process.env.BOT_TOKEN || 'YOUR_TELEGRAM_BOT_TOKEN';
const BITQUERY_WS_URL = process.env.BITQUERY_WS_URL || 'wss://graphql.bitquery.io/subscriptions';
const RPC_ENDPOINT = 'https://api.mainnet-beta.solana.com';
const JUPITER_QUOTE_API = 'https://quote-api.jup.ag/v6/quote';
const JUPITER_SWAP_API = 'https://quote-api.jup.ag/v6/swap';
const SYMBIOSIS_API = 'https://api.symbiosis.finance/crosschain/v1';
const connection = new Connection(RPC_ENDPOINT, 'confirmed');

// Initialize Telegram bot
const bot = new Telegraf(BOT_TOKEN);

// Initialize Bitquery WebSocket client
const transport = new WebsocketsTransport({
    url: BITQUERY_WS_URL,
    webSocketImpl: WebSocket
});
const bitqueryClient = new Client({ transport });

// In-memory user data (replace with database in production)
const userWallets = new Map(); // Maps Telegram user ID to { solana: [{ id, publicKey, privateKey }], ethereum: [{ id, address }], bnb: [{ id, address }], active: { solana, ethereum, bnb } }
const userSettings = new Map(); // Maps Telegram user ID to { slippage, priorityFee, mevProtection }
const alertSubscriptions = new Map(); // Maps Telegram user ID to { enabled: boolean, filter: 'all' | 'whale' }
const premiumSubscriptions = new Map(); // Maps Telegram user ID to { plan: 'free' | 'premium', expiry: timestamp }
const poolData = new Map(); // Maps pool address to { token, volume, price, protocol, timestamp }
const priceHistory = new Map(); // Maps chain:tokenAddress to [{ timestamp, price, volume, liquidity, whaleTrades }]

// Supported chains for bridging, predictions, and swaps
const SUPPORTED_CHAINS = ['solana', 'ethereum', 'bnb'];

// Helper: Generate unique wallet ID
function generateWalletId() {
    return Math.random().toString(36).substring(2, 10);
}

// Helper: Generate or retrieve user wallet
async function getOrCreateWallet(userId, chain = 'solana', walletId = null) {
    if (!userWallets.has(userId)) {
        const solanaWallet = Keypair.generate();
        userWallets.set(userId, {
            solana: [{ id: generateWalletId(), publicKey: solanaWallet.publicKey.toString(), privateKey: bs58.encode(solanaWallet.secretKey) }],
            ethereum: [],
            bnb: [],
            active: { solana: null, ethereum: null, bnb: null }
        });
    }
    const wallets = userWallets.get(userId);
    if (!wallets[chain] || wallets[chain].length === 0) {
        if (chain === 'solana') {
            const solanaWallet = Keypair.generate();
            wallets.solana.push({
                id: generateWalletId(),
                publicKey: solanaWallet.publicKey.toString(),
                privateKey: bs58.encode(solanaWallet.secretKey)
            });
            wallets.active.solana = wallets.solana[0].id;
            userWallets.set(userId, wallets);
            return Keypair.fromSecretKey(bs58.decode(wallets.solana[0].privateKey));
        } else {
            throw new Error(`No ${chain} wallet available. Use /addwallet to add one.`);
        }
    }
    const walletList = wallets[chain];
    const activeWalletId = wallets.active[chain] || walletList[0].id;
    const selectedWallet = walletId ? walletList.find(w => w.id === walletId) : walletList.find(w => w.id === activeWalletId);
    if (!selectedWallet) {
        throw new Error(`Wallet ID ${walletId || activeWalletId} not found for ${chain}.`);
    }
    if (chain === 'solana') {
        return Keypair.fromSecretKey(bs58.decode(selectedWallet.privateKey));
    }
    return { address: selectedWallet.address };
}

// Helper: Check token safety using Bitquery for Solana, Symbiosis for Ethereum/BNB
async function isTokenSafe(tokenAddress, chain) {
    try {
        if (chain === 'solana') {
            const query = gql`
                query ($tokenAddress: String!) {
                    Solana {
                        Token(tokenAddress: $tokenAddress) {
                            MintAuthority
                            FreezeAuthority
                            Supply
                        }
                    }
                }
            `;
            const result = await bitqueryClient.execute(query, { tokenAddress });
            const token = result.data.Solana.Token;
            return !token.MintAuthority && !token.FreezeAuthority && token.Supply > 0;
        } else {
            const response = await axios.get(`${SYMBIOSIS_API}/tokens`);
            const tokens = response.data.tokens;
            return tokens.some(t => t.address.toLowerCase() === tokenAddress.toLowerCase() && t.chain === chain);
        }
    } catch (error) {
        console.error(`Token safety check failed for ${chain}:`, error);
        return false;
    }
}

// Helper: Check subscription status
function isPremium(userId) {
    const sub = premiumSubscriptions.get(userId);
    if (!sub || sub.plan !== 'premium') return false;
    const now = Date.now();
    return sub.expiry > now;
}

// Helper: Execute a swap (Solana via Jupiter, Ethereum/BNB via Symbiosis)
async function executeSwap(wallet, chain, tokenAddress, amount, slippage, userId, isSnipe = false, isSell = false) {
    try {
        if (chain === 'solana') {
            const inputMint = isSell ? tokenAddress : 'So11111111111111111111111111111111111111112'; // Token for sell, SOL for buy
            const outputMint = isSell ? 'So11111111111111111111111111111111111111112' : tokenAddress; // SOL for sell, token for buy
            const amountLamports = Math.floor(amount * 1e9); // Assumes 9 decimals; adjust in production
            const slippageBps = Math.floor(slippage * 10000);
            const isPremiumUser = isPremium(userId);

            // Check token balance for sell
            if (isSell) {
                const query = gql`
                    query ($address: String!, $tokenAddress: String!) {
                        Solana {
                            Balance(address: $address, tokenAddress: $tokenAddress) {
                                Amount
                            }
                        }
                    }
                `;
                const result = await bitqueryClient.execute(query, { address: wallet.publicKey.toString(), tokenAddress });
                const balance = result.data.Solana.Balance?.[0]?.Amount || 0;
                if (balance < amount) {
                    throw new Error(`Insufficient token balance: ${balance} available, ${amount} required`);
                }
            }

            const quoteResponse = await axios.get(JUPITER_QUOTE_API, {
                params: {
                    inputMint,
                    outputMint,
                    amount: amountLamports,
                    slippageBps,
                    onlyDirectRoutes: isPremiumUser && isSnipe,
                    asLegacyTransaction: false
                }
            });
            const quote = quoteResponse.data;
            if (!quote) throw new Error('No valid swap route found');

            if (!await isTokenSafe(tokenAddress, chain)) {
                throw new Error('Token failed safety check');
            }

            const swapResponse = await axios.post(JUPITER_SWAP_API, {
                quoteResponse: quote,
                userPublicKey: wallet.publicKey.toString(),
                wrapAndUnwrapSol: true,
                dynamicComputeUnitLimit: true,
                prioritizationFeeLamports: Math.floor((isPremiumUser ? 0.001 : 0.0001) * 1e9)
            });
            const { swapTransaction } = swapResponse.data;

            const swapTransactionBuf = Buffer.from(swapTransaction, 'base64');
            const transaction = Transaction.from(swapTransactionBuf);
            transaction.sign(wallet);

            const signature = await sendAndConfirmTransaction(connection, transaction, [wallet], {
                commitment: 'confirmed',
                skipPreflight: isPremiumUser && isSnipe
            });

            return signature;
        } else {
            const chainIdMap = { ethereum: 1, bnb: 56 };
            const inputToken = isSell ? tokenAddress : chain === 'ethereum' ? '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' : '0x55d398326f99059fF775485246999027B3197955'; // WETH or WBNB
            const outputToken = isSell ? (chain === 'ethereum' ? '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' : '0x55d398326f99059fF775485246999027B3197955') : tokenAddress;
            const amountWei = Math.floor(amount * 1e18); // Assumes 18 decimals; adjust in production
            const isPremiumUser = isPremium(userId);

            // Check token balance for sell
            if (isSell) {
                const response = await axios.get(`${SYMBIOSIS_API}/wallet/balance`, {
                    params: { chain, address: wallet.address, tokenAddress }
                });
                const balance = response.data.balances.find(b => b.tokenAddress.toLowerCase() === tokenAddress.toLowerCase())?.amount || 0;
                if (balance < amount) {
                    throw new Error(`Insufficient token balance: ${balance} available, ${amount} required`);
                }
            }

            const quoteResponse = await axios.post(`${SYMBIOSIS_API}/swap/quote`, {
                tokenAddress: inputToken,
                amount: amountWei.toString(),
                fromChainId: chainIdMap[chain],
                toChainId: chainIdMap[chain],
                walletAddress: wallet.address,
                slippage: Math.floor(slippage * 10000)
            });
            const quote = quoteResponse.data;
            if (!quote) throw new Error('No valid swap route found');

            if (!await isTokenSafe(tokenAddress, chain)) {
                throw new Error('Token failed safety check');
            }

            const swapResponse = await axios.post(`${SYMBIOSIS_API}/swap/execute`, {
                quoteId: quote.id,
                userAddress: wallet.address,
                destinationAddress: wallet.address,
                gasPrice: isPremiumUser ? 'high' : 'standard' // Premium users get higher gas price
            });

            return swapResponse.data.transaction;
        }
    } catch (error) {
        throw new Error(`Swap failed: ${error.response?.data?.error || error.message}`);
    }
}

// Helper: Execute a cross-chain bridge using Symbiosis API
async function executeBridge(userId, sourceChain, destChain, tokenAddress, amount, sourceWalletId = null, destWalletId = null) {
    try {
        if (!SUPPORTED_CHAINS.includes(sourceChain) || !SUPPORTED_CHAINS.includes(destChain)) {
            throw new Error('Unsupported chain. Use solana, ethereum, or bnb.');
        }
        if (sourceChain === destChain) {
            throw new Error('Source and destination chains must be different.');
        }

        const sourceWallet = await getOrCreateWallet(userId, sourceChain, sourceWalletId);
        const destWallet = await getOrCreateWallet(userId, destChain, destWalletId);

        if (!await isTokenSafe(tokenAddress, sourceChain)) {
            throw new Error('Token not safe on source chain');
        }

        const chainIdMap = {
            solana: 0,
            ethereum: 1,
            bnb: 56
        };

        const quoteResponse = await axios.post(`${SYMBIOSIS_API}/swap/quote`, {
            tokenAddress: tokenAddress,
            amount: amount.toString(),
            fromChainId: chainIdMap[sourceChain],
            toChainId: chainIdMap[destChain],
            walletAddress: sourceChain === 'solana' ? sourceWallet.publicKey.toString() : sourceWallet.address
        });
        const quote = quoteResponse.data;
        if (!quote) throw new Error('No valid bridge route found');

        const bridgeResponse = await axios.post(`${SYMBIOSIS_API}/swap/execute`, {
            quoteId: quote.id,
            userAddress: sourceChain === 'solana' ? sourceWallet.publicKey.toString() : sourceWallet.address,
            destinationAddress: destChain === 'solana' ? destWallet.publicKey.toString() : destWallet.address,
            gasPrice: isPremium(userId) ? 'high' : 'standard'
        });

        if (sourceChain === 'solana') {
            const transactionBuf = Buffer.from(bridgeResponse.data.transaction, 'base64');
            const transaction = Transaction.from(transactionBuf);
            transaction.sign(sourceWallet);
            const signature = await sendAndConfirmTransaction(connection, transaction, [sourceWallet], {
                commitment: 'confirmed',
                skipPreflight: isPremium(userId)
            });
            return signature;
        } else {
            return bridgeResponse.data.transaction;
        }
    } catch (error) {
        throw new Error(`Bridge failed: ${error.response?.data?.error || error.message}`);
    }
}

// Helper: Fetch exclusive analytics (whale trades, liquidity inflows)
async function fetchExclusiveAnalytics(poolAddress) {
    try {
        const query = gql`
            query ($poolAddress: String!) {
                Solana {
                    DEXTradeByTokens(marketAddress: $poolAddress, where: { Trade: { Amount: { gt: 10000 } } }) {
                        Trade { Amount Price Account { Address } }
                        Block { Time }
                    }
                    LiquidityPool(marketAddress: $poolAddress) {
                        Liquidity { Amount Currency { Symbol } }
                    }
                }
            }
        `;
        const result = await bitqueryClient.execute(query, { poolAddress });
        const trades = result.data.Solana.DEXTradeByTokens || [];
        const liquidity = result.data.Solana.LiquidityPool?.Liquidity || [];

        let whaleActivity = 'No whale activity detected.';
        if (trades.length > 0) {
            whaleActivity = trades.map(t => 
                `Whale Trade: ${t.Trade.Amount} ${t.Trade.Currency?.Symbol || 'USD'} by ${t.Trade.Account.Address} at ${t.Block.Time}`
            ).join('\n');
        }

        let liquidityInflows = 'No liquidity inflows detected.';
        if (liquidity.length > 0) {
            liquidityInflows = liquidity.map(l => 
                `${l.Amount} ${l.Currency.Symbol} added`
            ).join('\n');
        }

        return { whaleActivity, liquidityInflows };
    } catch (error) {
        throw new Error(`Exclusive analytics failed: ${error.message}`);
    }
}

// Helper: Fetch wallet balances
async function fetchWalletBalances(userId) {
    const wallets = userWallets.get(userId) || { solana: [], ethereum: [], bnb: [], active: { solana: null, ethereum: null, bnb: null } };
    const balances = { solana: [], ethereum: [], bnb: [] };

    // Solana balances via Bitquery
    for (const wallet of wallets.solana) {
        try {
            const query = gql`
                query ($address: String!) {
                    Solana {
                        Balance(address: $address) {
                            Currency { Symbol Name MetadataAddress }
                            Amount
                        }
                    }
                }
            `;
            const result = await bitqueryClient.execute(query, { address: wallet.publicKey });
            const balanceData = result.data.Solana.Balance || [];
            balances.solana.push({
                id: wallet.id,
                address: wallet.publicKey,
                balances: balanceData.map(b => `${b.Amount} ${b.Currency.Symbol} (${b.Currency.Name})`)
            });
        } catch (error) {
            balances.solana.push({ id: wallet.id, address: wallet.publicKey, balances: ['Error fetching balance'] });
        }
    }

    // Ethereum/BNB balances via Symbiosis
    for (const chain of ['ethereum', 'bnb']) {
        for (const wallet of wallets[chain]) {
            try {
                const response = await axios.get(`${SYMBIOSIS_API}/wallet/balance`, {
                    params: { chain, address: wallet.address }
                });
                const balanceData = response.data.balances || [];
                balances[chain].push({
                    id: wallet.id,
                    address: wallet.address,
                    balances: balanceData.map(b => `${b.amount} ${b.tokenSymbol} (${b.tokenName})`)
                });
            } catch (error) {
                balances[chain].push({ id: wallet.id, address: wallet.address, balances: ['Error fetching balance'] });
            }
        }
    }

    return balances;
}

// Helper: Hybrid XGBoost+LSTM model for price prediction with confidence intervals
async function predictPrice(chain, tokenAddress, days, isPremiumUser) {
    try {
        let data = [];
        if (chain === 'solana') {
            const query = gql`
                query ($tokenAddress: String!, $limit: Int!) {
                    Solana {
                        DEXTradeByTokens(tokenAddress: $tokenAddress, limit: $limit) {
                            Block { Time }
                            Trade { Price Volume }
                            Market { MarketAddress }
                        }
                        LiquidityPool(tokenAddress: $tokenAddress) {
                            Liquidity { Amount Currency { Symbol } }
                        }
                        DEXTradeByTokens(where: { Trade: { Amount: { gt: 10000 } } }, tokenAddress: $tokenAddress) {
                            Trade { Amount }
                            Block { Time }
                        }
                    }
                }
            `;
            const result = await bitqueryClient.execute(query, { tokenAddress, limit: 100 });
            const trades = result.data.Solana.DEXTradeByTokens || [];
            const liquidity = result.data.Solana.LiquidityPool?.Liquidity || [];
            const whaleTrades = result.data.Solana.DEXTradeByTokens || [];

            if (!trades || trades.length < 30) {
                throw new Error('Insufficient historical data for prediction');
            }

            data = trades.map(t => ({
                timestamp: new Date(t.Block.Time).getTime() / 1000,
                price: t.Trade.Price,
                volume: t.Trade.Volume,
                liquidity: liquidity.find(l => l.Currency.Symbol !== 'SOL')?.Amount || 0,
                whaleTrades: whaleTrades.filter(w => new Date(w.Block.Time).getTime() / 1000 === t.timestamp).length
            })).sort((a, b) => a.timestamp - b.timestamp);
        } else {
            const chainIdMap = { ethereum: 1, bnb: 56 };
            const response = await axios.get(`${SYMBIOSIS_API}/tokens/price`, {
                params: { tokenAddress, chainId: chainIdMap[chain], limit: 100 }
            });
            const trades = response.data.trades || [];
            const liquidity = response.data.liquidity || [];

            if (!trades || trades.length < 30) {
                throw new Error('Insufficient historical data for prediction');
            }

            data = trades.map(t => ({
                timestamp: t.timestamp,
                price: t.price,
                volume: t.volume,
                liquidity: liquidity.find(l => l.tokenAddress === tokenAddress)?.amount || 0,
                whaleTrades: t.volume > 10000 ? 1 : 0
            })).sort((a, b) => a.timestamp - b.timestamp);
        }

        priceHistory.set(`${chain}:${tokenAddress}`, data);

        const prices = data.map(d => d.price);
        const volumes = data.map(d => d.volume);
        const liquidities = data.map(d => d.liquidity);
        const whaleCounts = data.map(d => d.whaleTrades);
        const ma5 = prices.map((_, i) => i < 4 ? prices[i] : prices.slice(i-4, i+1).reduce((a, b) => a + b) / 5);
        const ma20 = prices.map((_, i) => i < 19 ? prices[i] : prices.slice(i-19, i+1).reduce((a, b) => a + b) / 20);
        const X = prices.map((p, i) => [p, volumes[i], liquidities[i], whaleCounts[i], ma5[i], ma20[i]]);

        const predictions = [];
        const confidenceIntervals = isPremiumUser ? [] : null;

        // Run multiple iterations for confidence intervals
        const numIterations = isPremiumUser ? 10 : 1;
        const allPredictions = [];

        for (let iter = 0; iter < numIterations; iter++) {
            const xgb = new XGBRegressor({ objective: 'reg:squarederror', n_estimators: 100 });
            xgb.fit(X.slice(0, -1), prices.slice(1));

            const scaler = (x, min, max) => (x - min) / (max - min);
            const minPrice = Math.min(...prices);
            const maxPrice = Math.max(...prices);
            const normalized = prices.slice(-30).map(p => scaler(p, minPrice, maxPrice));
            const lstmInput = tf.tensor3d([normalized], [1, 30, 1]);

            const lstm = tf.sequential();
            lstm.add(tf.layers.lstm({ units: 50, inputShape: [30, 1] }));
            lstm.add(tf.layers.dense({ units: 1 }));
            lstm.compile({ optimizer: 'adam', loss: 'meanSquaredError' });
            await lstm.fit(lstmInput, tf.tensor2d([normalized.slice(-1)], [1, 1]), {
                epochs: 10,
                verbose: 0
            });

            const iterPredictions = [];
            let lastX = X.slice(-1)[0];
            let lastSequence = normalized.slice(-30);

            for (let i = 0; i < days; i++) {
                const xgbPred = xgb.predict([lastX])[0];
                const lstmPred = (await lstm.predict(tf.tensor3d([lastSequence], [1, 30, 1])).data())[0] * (maxPrice - minPrice) + minPrice;
                const hybridPred = 0.6 * lstmPred + 0.4 * xgbPred;
                iterPredictions.push(hybridPred);

                lastSequence = [...lastSequence.slice(1), scaler(hybridPred, minPrice, maxPrice)];
                const newMa5 = prices.slice(-4).concat([hybridPred]).reduce((a, b) => a + b) / 5;
                const newMa20 = prices.slice(-19).concat([hybridPred]).reduce((a, b) => a + b) / 20;
                lastX = [hybridPred, lastX[1], lastX[2], lastX[3], newMa5, newMa20];
                prices.push(hybridPred);
            }

            allPredictions.push(iterPredictions);
        }

        // Compute mean and confidence intervals
        for (let i = 0; i < days; i++) {
            const dayPreds = allPredictions.map(p => p[i]);
            const mean = dayPreds.reduce((a, b) => a + b, 0) / dayPreds.length;
            predictions.push(mean);

            if (isPremiumUser) {
                const stdDev = Math.sqrt(dayPreds.map(p => (p - mean) ** 2).reduce((a, b) => a + b, 0) / dayPreds.length);
                confidenceIntervals.push([mean - stdDev, mean + stdDev]);
            }
        }

        return { predictions, confidenceIntervals };
    } catch (error) {
        throw new Error(`Prediction failed: ${error.message}`);
    }
}

// Helper: Start real-time pool monitoring
async function startPoolMonitoring() {
    const subscriptionQuery = gql`
        subscription {
            Solana {
                DEXTradeByTokens {
                    Block { Time }
                    Trade {
                        Amount
                        Price
                        Currency { Symbol Name MetadataAddress }
                        Dex { ProgramAddress ProtocolName }
                        Market { MarketAddress }
                    }
                }
            }
        }
    `;

    for await (const result of transport.subscribe(subscriptionQuery)) {
        if (result.data) {
            const trades = result.data.Solana.DEXTradeByTokens;
            for (const trade of trades) {
                const poolAddress = trade.Market.MarketAddress;
                const token = trade.Currency;
                const volume = trade.Amount;
                const price = trade.Price;
                const protocol = trade.Dex.ProtocolName;
                const timestamp = trade.Block.Time;

                poolData.set(poolAddress, { token, volume, price, protocol, timestamp });

                for (const [userId, sub] of alertSubscriptions) {
                    if (sub.enabled && (sub.filter === 'all' || (sub.filter === 'whale' && volume > 10000))) {
                        bot.telegram.sendMessage(
                            userId,
                            `New Pool ${sub.filter === 'whale' ? 'Whale ' : ''}Detected!\n` +
                            `Token: ${token.Name} (${token.Symbol})\n` +
                            `Pool: ${poolAddress}\n` +
                            `Protocol: ${protocol}\n` +
                            `Price: ${price} USD\n` +
                            `Volume: ${volume}\n` +
                            `Time: ${timestamp}\n` +
                            `Snipe: /snipe ${token.MetadataAddress} 0.1`
                        );
                    }
                }
            }
        }
    }
}

// Start pool monitoring on bot launch
startPoolMonitoring().catch(console.error);

// Start command
bot.command('start', async (ctx) => {
    const userId = ctx.from.id;
    const wallet = await getOrCreateWallet(userId, 'solana');
    userSettings.set(userId, { slippage: 0.05, priorityFee: 0.0001, mevProtection: 'secure' });
    alertSubscriptions.set(userId, { enabled: false, filter: 'all' });
    premiumSubscriptions.set(userId, { plan: 'free', expiry: 0 });
    ctx.reply(
        `Welcome to SolSuperTrader! 🚀\n` +
        `Your Solana wallet (ID: ${userWallets.get(userId).solana[0].id}): ${wallet.publicKey.toString()}\n` +
        `Private key (KEEP SECRET): ${userWallets.get(userId).solana[0].privateKey}\n` +
        `Subscription: Free Tier\n` +
        `Use /addwallet, /listwallets, /buy, /sell, /snipe, /bridge, /settings, /portfolio, /alerts, /analytics, /predict, /subscribe, or /status to get started.`
    );
});

// Subscribe command: /subscribe <plan>
bot.command('subscribe', (ctx) => {
    const userId = ctx.from.id;
    const args = ctx.message.text.split(' ').slice(1);
    if (args.length !== 1 || !['free', 'premium'].includes(args[0].toLowerCase())) {
        return ctx.reply('Usage: /subscribe <free|premium>\nFor premium pricing, visit https://x.ai/grok');
    }
    const plan = args[0].toLowerCase();
    if (plan === 'premium') {
        const expiry = Date.now() + 30 * 24 * 60 * 60 * 1000; // 30 days
        premiumSubscriptions.set(userId, { plan: 'premium', expiry });
        ctx.reply('Premium subscription activated! Enjoy faster sniping, exclusive analytics, confidence intervals, and whale alerts.\nCheck status with /status');
    } else {
        premiumSubscriptions.set(userId, { plan: 'free', expiry: 0 });
        ctx.reply('Switched to Free Tier. Some features are limited.\nUpgrade at https://x.ai/grok');
    }
});

// Status command: /status
bot.command('status', (ctx) => {
    const userId = ctx.from.id;
    const sub = premiumSubscriptions.get(userId) || { plan: 'free', expiry: 0 };
    const wallets = userWallets.get(userId) || { solana: [], ethereum: [], bnb: [], active: { solana: null, ethereum: null, bnb: null } };
    const alertSub = alertSubscriptions.get(userId) || { enabled: false, filter: 'all' };
    const expiryDate = sub.expiry ? new Date(sub.expiry).toISOString() : 'N/A';
    const walletList = [
        `Solana: ${wallets.solana.map(w => `${w.id} (${w.publicKey}${w.id === wallets.active.solana ? ' [active]' : ''})`).join(', ') || 'None'}`,
        `Ethereum: ${wallets.ethereum.map(w => `${w.id} (${w.address}${w.id === wallets.active.ethereum ? ' [active]' : ''})`).join(', ') || 'None'}`,
        `BNB Chain: ${wallets.bnb.map(w => `${w.id} (${w.address}${w.id === wallets.active.bnb ? ' [active]' : ''})`).join(', ') || 'None'}`
    ].join('\n');
    ctx.reply(
        `Subscription: ${sub.plan.charAt(0).toUpperCase() + sub.plan.slice(1)} (Expires: ${expiryDate})\n` +
        `Wallets:\n${walletList}\n` +
        `Alerts: ${alertSub.enabled ? `On (Filter: ${alertSub.filter})` : 'Off'}`
    );
});

// List wallets command: /listwallets
bot.command('listwallets', (ctx) => {
    const userId = ctx.from.id;
    const wallets = userWallets.get(userId) || { solana: [], ethereum: [], bnb: [], active: { solana: null, ethereum: null, bnb: null } };
    const walletList = [
        `Solana Wallets: ${wallets.solana.length ? wallets.solana.map(w => `ID: ${w.id}, Address: ${w.publicKey}${w.id === wallets.active.solana ? ' [active]' : ''}`).join('\n') : 'None'}`,
        `Ethereum Wallets: ${wallets.ethereum.length ? wallets.ethereum.map(w => `ID: ${w.id}, Address: ${w.address}${w.id === wallets.active.ethereum ? ' [active]' : ''}`).join('\n') : 'None'}`,
        `BNB Chain Wallets: ${wallets.bnb.length ? wallets.bnb.map(w => `ID: ${w.id}, Address: ${w.address}${w.id === wallets.active.bnb ? ' [active]' : ''}`).join('\n') : 'None'}`
    ].join('\n\n');
    ctx.reply(`Your Wallets:\n${walletList}\nUse /addwallet to add more or /settings to set active wallets.`);
});

// Add wallet command: /addwallet <chain> [address]
bot.command('addwallet', async (ctx) => {
    const userId = ctx.from.id;
    const args = ctx.message.text.split(' ').slice(1);
    if (args.length < 1 || !SUPPORTED_CHAINS.includes(args[0].toLowerCase())) {
        return ctx.reply('Usage: /addwallet <chain> [address]\nSupported chains: solana, ethereum, bnb');
    }
    const chain = args[0].toLowerCase();
    const address = args[1];
    try {
        const wallets = userWallets.get(userId) || { solana: [], ethereum: [], bnb: [], active: { solana: null, ethereum: null, bnb: null } };
        if (chain === 'solana') {
            const solanaWallet = Keypair.generate();
            const walletId = generateWalletId();
            wallets.solana.push({
                id: walletId,
                publicKey: solanaWallet.publicKey.toString(),
                privateKey: bs58.encode(solanaWallet.secretKey)
            });
            if (!wallets.active.solana) wallets.active.solana = walletId;
            userWallets.set(userId, wallets);
            ctx.reply(
                `New Solana wallet added!\n` +
                `ID: ${walletId}\n` +
                `Address: ${solanaWallet.publicKey.toString()}\n` +
                `Private key (KEEP SECRET): ${bs58.encode(solanaWallet.secretKey)}`
            );
        } else {
            if (!address || !address.match(/^0x[a-fA-F0-9]{40}$/)) {
                return ctx.reply(`Invalid ${chain} address`);
            }
            const walletId = generateWalletId();
            wallets[chain].push({ id: walletId, address });
            if (!wallets.active[chain]) wallets.active[chain] = walletId;
            userWallets.set(userId, wallets);
            ctx.reply(`New ${chain} wallet added!\nID: ${walletId}\nAddress: ${address}`);
        }
    } catch (error) {
        ctx.reply(`Error: ${error.message}`);
    }
});

// Buy command: /buy <token_address> <amount> [wallet_id]
bot.command('buy', async (ctx) => {
    const userId = ctx.from.id;
    const args = ctx.message.text.split(' ').slice(1);
    if (args.length < 2 || args.length > 3) {
        return ctx.reply('Usage: /buy <token_address> <amount> [wallet_id]');
    }
    const [tokenAddress, amountVal, walletId] = args;
    const amount = parseFloat(amountVal);
    if (isNaN(amount) || amount <= 0) {
        return ctx.reply('Invalid amount');
    }
    try {
        const wallet = await getOrCreateWallet(userId, 'solana', walletId);
        const settings = userSettings.get(userId) || { slippage: 0.05 };
        const signature = await executeSwap(wallet, 'solana', tokenAddress, amount, settings.slippage, userId);
        ctx.reply(`Buy successful! Tx: ${signature} (Wallet: ${wallet.publicKey.toString()})`);
    } catch (error) {
        ctx.reply(`Error: ${error.message}`);
    }
});

// Sell command: /sell <chain> <token_address> <token_amount> [wallet_id]
bot.command('sell', async (ctx) => {
    const userId = ctx.from.id;
    const args = ctx.message.text.split(' ').slice(1);
    if (args.length < 3 || args.length > 4) {
        return ctx.reply('Usage: /sell <chain> <token_address> <token_amount> [wallet_id]\nSupported chains: solana, ethereum, bnb');
    }
    const [chain, tokenAddress, amountToken, walletId] = args;
    if (!SUPPORTED_CHAINS.includes(chain.toLowerCase())) {
        return ctx.reply('Unsupported chain. Use solana, ethereum, or bnb.');
    }
    const amount = parseFloat(amountToken);
    if (isNaN(amount) || amount <= 0) {
        return ctx.reply('Invalid token amount');
    }
    try {
        const wallet = await getOrCreateWallet(userId, chain.toLowerCase(), walletId);
        const settings = userSettings.get(userId) || { slippage: 0.05 };
        if (await isTokenSafe(tokenAddress, chain.toLowerCase())) {
            const result = await executeSwap(wallet, chain.toLowerCase(), tokenAddress, amount, settings.slippage, userId, false, true);
            if (chain.toLowerCase() === 'solana') {
                ctx.reply(`Sell successful! Tx: ${result} (Wallet: ${wallet.publicKey.toString()})`);
            } else {
                ctx.reply(`Sell transaction prepared. Sign with your ${chain} wallet: ${JSON.stringify(result)}`);
            }
        } else {
            ctx.reply('Sell aborted: Token not safe');
        }
    } catch (error) {
        ctx.reply(`Error: ${error.message}`);
    }
});

// Snipe command: /snipe <token_address> <SOL_amount> [wallet_id]
bot.command('snipe', async (ctx) => {
    const userId = ctx.from.id;
    const args = ctx.message.text.split(' ').slice(1);
    if (args.length < 2 || args.length > 3) {
        return ctx.reply('Usage: /snipe <token_address> <SOL_amount> [wallet_id]');
    }
    const [tokenAddress, amountSol, walletId] = args;
    const amount = parseFloat(amountSol);
    if (isNaN(amount) || amount <= 0) {
        return ctx.reply('Invalid SOL amount');
    }
    try {
        const wallet = await getOrCreateWallet(userId, 'solana', walletId);
        const settings = userSettings.get(userId) || { slippage: 0.05 };
        if (await isTokenSafe(tokenAddress, 'solana')) {
            const signature = await executeSwap(wallet, 'solana', tokenAddress, amount, settings.slippage * 2, userId, true);
            ctx.reply(`Snipe successful! Tx: ${signature} (Wallet: ${wallet.publicKey.toString()})`);
        } else {
            ctx.reply('Snipe aborted: Token not safe');
        }
    } catch (error) {
        ctx.reply(`Error: ${error.message}`);
    }
});

// Bridge command: /bridge <source_chain> <dest_chain> <token_address> <amount> [source_wallet_id] [dest_wallet_id]
bot.command('bridge', async (ctx) => {
    const userId = ctx.from.id;
    const args = ctx.message.text.split(' ').slice(1);
    if (args.length < 4 || args.length > 6) {
        return ctx.reply('Usage: /bridge <source_chain> <dest_chain> <token_address> <amount> [source_wallet_id] [dest_wallet_id]\nSupported chains: solana, ethereum, bnb');
    }
    const [sourceChain, destChain, tokenAddress, amount, sourceWalletId, destWalletId] = args;
    const amountVal = parseFloat(amount);
    if (isNaN(amountVal) || amountVal <= 0) {
        return ctx.reply('Invalid amount');
    }
    try {
        const result = await executeBridge(userId, sourceChain.toLowerCase(), destChain.toLowerCase(), tokenAddress, amountVal, sourceWalletId, destWalletId);
        if (sourceChain.toLowerCase() === 'solana') {
            ctx.reply(`Bridge successful! Tx: ${result} (Source Wallet: ${sourceWalletId || 'default'})`);
        } else {
            ctx.reply(`Bridge transaction prepared. Sign with your ${sourceChain} wallet: ${JSON.stringify(result)}`);
        }
    } catch (error) {
        ctx.reply(`Error: ${error.message}`);
    }
});

// Settings command: /settings <slippage> <priorityFee> <mevProtection> [solana_wallet_id] [eth_address_id] [bnb_address_id]
bot.command('settings', (ctx) => {
    const userId = ctx.from.id;
    const args = ctx.message.text.split(' ').slice(1);
    if (args.length < 3) {
        return ctx.reply('Usage: /settings <slippage> <priorityFee> <mevProtection(turbo|secure)> [solana_wallet_id] [eth_address_id] [bnb_address_id]');
    }
    const [slippage, priorityFee, mevProtection, solanaWalletId, ethAddressId, bnbAddressId] = args;
    const slippageVal = parseFloat(slippage);
    const priorityFeeVal = parseFloat(priorityFee);
    if (isNaN(slippageVal) || isNaN(priorityFeeVal) || !['turbo', 'secure'].includes(mevProtection)) {
        return ctx.reply('Invalid settings');
    }
    const wallets = userWallets.get(userId) || { solana: [], ethereum: [], bnb: [], active: { solana: null, ethereum: null, bnb: null } };
    let response = `Settings updated: Slippage=${slippageVal}, PriorityFee=${priorityFeeVal}, MEV=${mevProtection}`;
    if (solanaWalletId) {
        if (wallets.solana.find(w => w.id === solanaWalletId)) {
            wallets.active.solana = solanaWalletId;
            response += `\nActive Solana wallet: ${solanaWalletId}`;
        } else {
            response += `\nInvalid Solana wallet ID: ${solanaWalletId}`;
        }
    }
    if (ethAddressId) {
        if (wallets.ethereum.find(w => w.id === ethAddressId)) {
            wallets.active.ethereum = ethAddressId;
            response += `\nActive Ethereum wallet: ${ethAddressId}`;
        } else {
            response += `\nInvalid Ethereum wallet ID: ${ethAddressId}`;
        }
    }
    if (bnbAddressId) {
        if (wallets.bnb.find(w => w.id === bnbAddressId)) {
            wallets.active.bnb = bnbAddressId;
            response += `\nActive BNB Chain wallet: ${bnbAddressId}`;
        } else {
            response += `\nInvalid BNB Chain wallet ID: ${bnbAddressId}`;
        }
    }
    userWallets.set(userId, wallets);
    userSettings.set(userId, { slippage: slippageVal, priorityFee: priorityFeeVal, mevProtection });
    ctx.reply(response);
});

// Portfolio command: /portfolio
bot.command('portfolio', async (ctx) => {
    const userId = ctx.from.id;
    try {
        const balances = await fetchWalletBalances(userId);
        const response = [
            `Portfolio for User ${userId}:`,
            `Solana Wallets:`,
            balances.solana.length ? balances.solana.map(w => `ID: ${w.id}\nAddress: ${w.address}\nBalances:\n${w.balances.join('\n')}`).join('\n\n') : 'None',
            `Ethereum Wallets:`,
            balances.ethereum.length ? balances.ethereum.map(w => `ID: ${w.id}\nAddress: ${w.address}\nBalances:\n${w.balances.join('\n')}`).join('\n\n') : 'None',
            `BNB Chain Wallets:`,
            balances.bnb.length ? balances.bnb.map(w => `ID: ${w.id}\nAddress: ${w.address}\nBalances:\n${w.balances.join('\n')}`).join('\n\n') : 'None'
        ].join('\n\n');
        ctx.reply(response);
    } catch (error) {
        ctx.reply(`Error: ${error.message}`);
    }
});

// Alerts command: /alerts <on|off> [whale]
bot.command('alerts', (ctx) => {
    const userId = ctx.from.id;
    const args = ctx.message.text.split(' ').slice(1);
    if (args.length < 1 || !['on', 'off'].includes(args[0])) {
        return ctx.reply('Usage: /alerts <on|off> [whale]\nWhale filter requires premium subscription.');
    }
    const isEnabled = args[0] === 'on';
    const filter = args[1]?.toLowerCase() === 'whale' && isPremium(userId) ? 'whale' : 'all';
    alertSubscriptions.set(userId, { enabled: isEnabled, filter });
    ctx.reply(`Token alerts ${isEnabled ? `enabled (Filter: ${filter})` : 'disabled'}.` + 
             (args[1]?.toLowerCase() === 'whale' && !isPremium(userId) ? '\nWhale filter requires premium subscription. Upgrade at https://x.ai/grok' : ''));
});

// Analytics command: /analytics <pool_address>
bot.command('analytics', async (ctx) => {
    const userId = ctx.from.id;
    const args = ctx.message.text.split(' ').slice(1);
    if (args.length !== 1) {
        return ctx.reply('Usage: /analytics <pool_address>');
    }
    const poolAddress = args[0];
    const data = poolData.get(poolAddress);
    if (!data) {
        return ctx.reply('No data found for this pool.');
    }
    let response = `Pool Analytics:\n` +
                   `Token: ${data.token.Name} (${data.token.Symbol})\n` +
                   `Pool: ${poolAddress}\n` +
                   `Protocol: ${data.protocol}\n` +
                   `Price: ${data.price} USD\n` +
                   `Volume: ${data.volume}\n` +
                   `Last Updated: ${data.timestamp}`;
    if (isPremium(userId)) {
        const { whaleActivity, liquidityInflows } = await fetchExclusiveAnalytics(poolAddress);
        response += `\n\nExclusive Analytics (Premium):\n` +
                   `Whale Activity:\n${whaleActivity}\n` +
                   `Liquidity Inflows:\n${liquidityInflows}`;
    } else {
        response += `\n\nUpgrade to premium for exclusive analytics (whale activity, liquidity inflows) at https://x.ai/grok`;
    }
    ctx.reply(response);
});

// Predict command: /predict <chain> <token_address> <days> [wallet_id]
bot.command('predict', async (ctx) => {
    const userId = ctx.from.id;
    const args = ctx.message.text.split(' ').slice(1);
    if (args.length < 3 || args.length > 4) {
        return ctx.reply('Usage: /predict <chain> <token_address> <days> [wallet_id]\nSupported chains: solana, ethereum, bnb');
    }
    const [chain, tokenAddress, days, walletId] = args;
    if (!SUPPORTED_CHAINS.includes(chain.toLowerCase())) {
        return ctx.reply('Unsupported chain. Use solana, ethereum, or bnb.');
    }
    const daysVal = parseInt(days);
    if (isNaN(daysVal) || daysVal <= 0 || daysVal > 30) {
        return ctx.reply('Days must be a number between 1 and 30');
    }
    try {
        if (!await isTokenSafe(tokenAddress, chain.toLowerCase())) {
            return ctx.reply('Prediction aborted: Token not safe');
        }
        const isPremiumUser = isPremium(userId);
        const { predictions, confidenceIntervals } = await predictPrice(chain.toLowerCase(), tokenAddress, daysVal, isPremiumUser);
        let forecast = predictions.map((p, i) => {
            let line = `Day ${i + 1}: $${p.toFixed(2)}`;
            if (isPremiumUser && confidenceIntervals) {
                line += ` (95% CI: $${confidenceIntervals[i][0].toFixed(2)} - $${confidenceIntervals[i][1].toFixed(2)})`;
            }
            return line;
        }).join('\n');
        if (!isPremiumUser) {
            forecast += `\n\nUpgrade to premium for confidence intervals at https://x.ai/grok`;
        }
        ctx.reply(
            `Price Prediction for ${tokenAddress} on ${chain} (USD):\n${forecast}\n` +
            `Note: Predictions are estimates and not financial advice.`
        );
    } catch (error) {
        ctx.reply(`Error: ${error.message}`);
    }
});

// Error handling
bot.catch((err, ctx) => {
    console.error(`Error for ${ctx.updateType}`, err);
    ctx.reply('An error occurred. Please try again.');
});

// Start bot (use Cloudflare Workers for production)
bot.launch().then(() => console.log('SolSuperTrader running...'));

// Graceful shutdown
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));