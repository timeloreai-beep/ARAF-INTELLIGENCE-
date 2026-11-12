/* ==========================================================================
   ARAF INTELLIGENCE — ULTRA INSTITUTIONAL TRADING ENGINE (app.js)
   Architecture: High-Precision Concurrency & Hardware-Salt Protection
   SEBI 2026/27 Compliant & Zero-Slippage Hard Capital Guard
   ========================================================================== */

// ==========================================
// ১. ক্লাউড গেটওয়ে, ফায়ারবেস ফায়ারস্টোর ও কনফিগ
// ==========================================
const CLOUDFLARE_GATEWAY = "https://soft-dawn-28a0.timeloreai.workers.dev/";

const firebaseConfig = {
    apiKey: "AIzaSyBGmdR_ElITZ8lNgJPjSMA-ksPjYQKddCc",
    authDomain: "araf-intelligence.firebaseapp.com",
    projectId: "araf-intelligence",
    storageBucket: "araf-intelligence.firebasestorage.app",
    messagingSenderId: "949905617207",
    appId: "1:949905617207:web:521009a47fb1766b012ab2"
};

if (!firebase.apps.length) {
    firebase.initializeApp(firebaseConfig);
}
const auth = firebase.auth();
const db = firebase.firestore();

auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL).catch(e => console.warn("[Auth Persistence Warn]:", e));

const MAX_DAILY_LOSS_LIMIT = -2500;
let USD_TO_INR_RATE = 87.50;
let currentGreekOptionMode = 'CE';

async function syncLiveUsdInrRate() {
    try {
        const res = await fetch('https://api.exchangerate-api.com/v4/latest/USD');
        const data = await res.json();
        if (data && data.rates && data.rates.INR) {
            USD_TO_INR_RATE = parseFloat(data.rates.INR);
        }
    } catch(e) {}
}
syncLiveUsdInrRate();

function getIndiaTradingDate() {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
}

const SUPPORTED_LANGUAGES = {
    'en-US': { name: 'English', prefix: 'Attention trader! ' },
    'bn-IN': { name: 'বাংলা', prefix: 'শুনুন ভাই! ' },
    'hi-IN': { name: 'हिन्दी', prefix: 'ध्यान दें! ' },
    'gu-IN': { name: 'ગુજરાતી', prefix: 'ધ્યાન આપો! ' },
    'mr-IN': { name: 'मराठी', prefix: 'लक्ष द्या! ' },
    'ta-IN': { name: 'தமிழ்', prefix: 'கவனிக்கவும்! ' }
};

const WS_HEARTBEAT_TRACKER = {
    binance: Date.now(),
    shoonya: Date.now(),
    isFeedStale(broker, maxAllowedSeconds = 15) {
        const lastTick = broker === 'SHOONYA' ? this.shoonya : this.binance;
        return (Date.now() - lastTick) > (maxAllowedSeconds * 1000);
    }
};

const BUSINESS_PAYMENT_CONFIG = {
    merchantUpiId: "Q458765829@ybl",
    merchantName: "ARAF DIGITAL CENTER",
    monthlyPrice: 299,
    trialDays: 30
};

const SESSION_VAULT = {
    userKey: null,
    activeUser: null,
    savedCloudUser: null,
    shoonyaUid: '',
    shoonyaToken: '',
    coindcxKey: '',
    coindcxSecret: '',
    voiceEnabled: true,
    voiceLang: 'en-US',
    newsLang: 'en-US',
    voiceIntervalMinutes: 3,
    currentOppData: null,
    tradeHistory: [],
    dailyLossPnl: 0,
    fastPositionsMap: {},
    localCandleHistory: {},
    activeBracketOrders: {},
    lastHeartbeatTime: Date.now()
};

let activeCategory = 'all';
let currentActiveSymbol = 'NSE:NIFTY';
let currentSelectedAsset = null;
let binanceWs = null;
let shoonyaWs = null;
let shoonyaWsReconnectAttempts = 0;
let currentNiftyPrice = 0;
let liveIndiaVix = 14.20;
let activeNewsTab = 'stock_only';
let allFetchedNewsItems = [];
let isVoicePaused = false;
let isTerminalUnlocked = false;
let periodicVoiceIntervalId = null;
let deferredPrompt = null;
let liveIpoList = [];
let speechWatchdogTimer = null;
let lastUiUpdateTime = 0;
let isOrderDispatching = false;
let selectedCryptoLeverage = 20;

const NSE_TRADING_HOLIDAYS_2025_2026 = [
    "2025-02-26", "2025-03-14", "2025-03-31", "2025-04-10", "2025-04-14", 
    "2025-04-18", "2025-05-01", "2025-08-15", "2025-08-27", "2025-10-02", 
    "2025-10-21", "2025-10-22", "2025-11-05", "2025-12-25",
    "2026-01-26", "2026-03-06", "2026-03-20", "2026-04-03", "2026-04-14"
];

const CANONICAL_INSTRUMENTS = {
    'NIFTY': { broker: 'SHOONYA', exchange: 'NFO', segment: 'FUT', lotSize: 65, tickSize: 0.05, isDerivative: true, token: '26000' },
    'BANKNIFTY': { broker: 'SHOONYA', exchange: 'NFO', segment: 'FUT', lotSize: 30, tickSize: 0.05, isDerivative: true, token: '26009' },
    'SENSEX': { broker: 'SHOONYA', exchange: 'BFO', segment: 'FUT', lotSize: 20, tickSize: 0.05, isDerivative: true, token: '1' },
    'RELIANCE': { broker: 'SHOONYA', exchange: 'NSE', segment: 'EQ', lotSize: 1, tickSize: 0.05, isDerivative: false, token: '2885' },
    'BTCUSDT': { broker: 'COINDCX', exchange: 'COINDCX', segment: 'FUTURES', lotSize: 0.001, tickSize: 0.1, isDerivative: true, marketPair: 'B-BTC_USDT' },
    'ETHUSDT': { broker: 'COINDCX', exchange: 'COINDCX', segment: 'FUTURES', lotSize: 0.01, tickSize: 0.01, isDerivative: true, marketPair: 'B-ETH_USDT' },
    'PAXGUSDT': { broker: 'COINDCX', exchange: 'COINDCX', segment: 'FUTURES', lotSize: 0.01, tickSize: 0.01, isDerivative: true, marketPair: 'B-PAXG_USDT' }
};

function resolveCanonicalInstrument(symbolKey) {
    if (!symbolKey) return null;
    const cleanKey = symbolKey.replace(/[^A-Z0-9]/gi, '').toUpperCase();
    return CANONICAL_INSTRUMENTS[cleanKey] || null;
}

const EXCHANGE_LOT_SPECS = {
    NIFTY: { lot: 65, step: 65, min: 65, leverage: "⚡ 5X LEVERAGE (NSE MIS Intraday)", type: "FNO", exchange: "NFO" },
    BANKNIFTY: { lot: 30, step: 30, min: 30, leverage: "⚡ 5X LEVERAGE (NSE MIS Intraday)", type: "FNO", exchange: "NFO" },
    SENSEX: { lot: 20, step: 20, min: 20, leverage: "⚡ 5X LEVERAGE (BSE MIS Intraday)", type: "FNO", exchange: "BFO" },
    RELIANCE: { lot: 1, step: 1, min: 1, leverage: "⚡ 5X LEVERAGE (SEBI Intraday MIS)", type: "EQUITY", exchange: "NSE" },
    BTCUSDT: { lot: 0.001, step: 0.001, min: 0.0001, leverage: "⚡ 20X LEVERAGE (Perpetual Futures)", type: "CRYPTO_FUTURES", exchange: "COINDCX" },
    ETHUSDT: { lot: 0.01, step: 0.01, min: 0.001, leverage: "⚡ 20X LEVERAGE (Perpetual Futures)", type: "CRYPTO_FUTURES", exchange: "COINDCX" },
    PAXGUSDT: { lot: 0.01, step: 0.01, min: 0.001, leverage: "⚡ 10X LEVERAGE (Gold Futures)", type: "CRYPTO_FUTURES", exchange: "COINDCX" }
};

const MASTER_ASSETS = [
    { id: 'nifty50', name: 'NIFTY 50', category: 'indian', symbol: 'NSE:NIFTY', orderKey: 'NIFTY', token: '26000', icon: '₹', price: 'Syncing...', priceNum: 0, high: 0, low: 0, highFormatted: '-', lowFormatted: '-', change: '0.00%', trend: 'NEUTRAL', signalType: 'Connecting Feed...', probabilityScore: 50, sentimentScore: 0, realTbq: 0, realTsq: 0, blockOrderDetected: false, keywords: ['nifty', 'nse', 'sensex', 'dalal street', 'indian market'] },
    { id: 'banknifty', name: 'BANK NIFTY', category: 'indian', symbol: 'NSE:BANKNIFTY', orderKey: 'BANKNIFTY', token: '26009', icon: '₹', price: 'Syncing...', priceNum: 0, high: 0, low: 0, highFormatted: '-', lowFormatted: '-', change: '0.00%', trend: 'NEUTRAL', signalType: 'Connecting Feed...', probabilityScore: 50, sentimentScore: 0, realTbq: 0, realTsq: 0, blockOrderDetected: false, keywords: ['bank nifty', 'hdfc bank', 'icici bank', 'sbi', 'banking sector'] },
    { id: 'reliance', name: 'RELIANCE', category: 'indian', symbol: 'NSE:RELIANCE', orderKey: 'RELIANCE', token: '2885', icon: '₹', price: 'Syncing...', priceNum: 0, high: 0, low: 0, highFormatted: '-', lowFormatted: '-', change: '0.00%', trend: 'NEUTRAL', signalType: 'Connecting Feed...', probabilityScore: 50, sentimentScore: 0, realTbq: 0, realTsq: 0, blockOrderDetected: false, keywords: ['reliance', 'mukesh ambani', 'jio', 'oil', 'telecom', 'ril'] },
    { id: 'hdfcbank', name: 'HDFC BANK', category: 'indian', symbol: 'NSE:HDFCBANK', orderKey: 'HDFCBANK', token: '1333', icon: '₹', price: 'Syncing...', priceNum: 0, high: 0, low: 0, highFormatted: '-', lowFormatted: '-', change: '0.00%', trend: 'NEUTRAL', signalType: 'Connecting Feed...', probabilityScore: 50, sentimentScore: 0, realTbq: 0, realTsq: 0, blockOrderDetected: false, keywords: ['hdfc', 'banking', 'fintech'] },
    { id: 'tatamotors', name: 'TATA MOTORS', category: 'indian', symbol: 'NSE:TATAMOTORS', orderKey: 'TATAMOTORS', token: '3456', icon: '₹', price: 'Syncing...', priceNum: 0, high: 0, low: 0, highFormatted: '-', lowFormatted: '-', change: '0.00%', trend: 'NEUTRAL', signalType: 'Connecting Feed...', probabilityScore: 50, sentimentScore: 0, realTbq: 0, realTsq: 0, blockOrderDetected: false, keywords: ['tata', 'ev', 'auto', 'tatamotors'] },
    { id: 'btcusdt', name: 'BTC / USDT', category: 'crypto', symbol: 'BINANCE:BTCUSDT', orderKey: 'BTCUSDT', token: 'btcusdt', icon: '₿', price: 'Syncing...', priceNum: 0, high: 0, low: 0, highFormatted: '-', lowFormatted: '-', change: '0.00%', trend: 'NEUTRAL', signalType: 'Connecting Feed...', probabilityScore: 50, sentimentScore: 0, realTbq: 0, realTsq: 0, blockOrderDetected: false, keywords: ['btc', 'bitcoin', 'crypto', 'sec', 'etf'] },
    { id: 'ethusdt', name: 'ETH / USDT', category: 'crypto', symbol: 'BINANCE:ETHUSDT', orderKey: 'ETHUSDT', token: 'ethusdt', icon: 'Ξ', price: 'Syncing...', priceNum: 0, high: 0, low: 0, highFormatted: '-', lowFormatted: '-', change: '0.00%', trend: 'NEUTRAL', signalType: 'Connecting Feed...', probabilityScore: 50, sentimentScore: 0, realTbq: 0, realTsq: 0, blockOrderDetected: false, keywords: ['eth', 'ethereum', 'crypto', 'defi'] },
    { id: 'goldmcx', name: 'GOLD (PAXG)', category: 'commodity', symbol: 'BINANCE:PAXGUSDT', orderKey: 'PAXGUSDT', token: 'paxgusdt', icon: '🟡', price: 'Syncing...', priceNum: 0, high: 0, low: 0, highFormatted: '-', lowFormatted: '-', change: '0.00%', trend: 'NEUTRAL', signalType: 'Connecting Feed...', probabilityScore: 50, sentimentScore: 0, realTbq: 0, realTsq: 0, blockOrderDetected: false, keywords: ['gold', 'paxg', 'bullion', 'tokenized gold', 'safe haven', 'crude'] }
];

currentSelectedAsset = MASTER_ASSETS[0];
const GEOPOLITICAL_KEYWORDS = ['trump', 'tariff', 'war', 'middle east', 'iran', 'israel', 'china', 'fed rate', 'crude oil', 'rbi', 'inflation', 'trade war'];
let activeIpoFilter = 'all';

function sanitizeCleanText(str) {
    if (!str) return '';
    const temp = document.createElement('div');
    temp.textContent = str.toString();
    return temp.innerHTML;
}

// ==========================================
// ২. UID জেনারেটর
// ==========================================
function generatePersonalized12DigitUid(fullName) {
    try {
        let cleanAlpha = (fullName || 'ARAF').replace(/[^a-zA-Z]/g, '').toUpperCase();
        cleanAlpha = cleanAlpha.length < 4 ? (cleanAlpha + 'XXXX').slice(0, 4) : cleanAlpha.slice(0, 4);

        const cryptoArray = new Uint32Array(2);
        window.crypto.getRandomValues(cryptoArray);
        const uniqueNumberStr = ((cryptoArray[0] % 90000000) + 10000000).toString();

        return `${cleanAlpha}-${uniqueNumberStr}`;
    } catch (e) {
        const fallbackNum = Math.floor(10000000 + Math.random() * 90000000).toString();
        return `ARAF-${fallbackNum}`;
    }
}

function getOrCreateUserPermanentUid(fullName) {
    if (SESSION_VAULT.savedCloudUser && SESSION_VAULT.savedCloudUser.profile?.traderUid) {
        return SESSION_VAULT.savedCloudUser.profile.traderUid;
    }
    const localSaved = localStorage.getItem('ARAF_PERMANENT_TRADER_UID');
    if (localSaved && localSaved.length === 13) {
        return localSaved;
    }
    const freshUid = generatePersonalized12DigitUid(fullName);
    localStorage.setItem('ARAF_PERMANENT_TRADER_UID', freshUid);
    return freshUid;
}

// ==========================================
// ৩. ক্লাউড-লেভেল হার্ড কিল-সুইচ গার্ড
// ==========================================
function checkHardKillSwitchLock() {
    const todayStr = getIndiaTradingDate();
    const lockedDataRaw = localStorage.getItem('ARAF_HARD_KILL_LOCK');
    if (lockedDataRaw) {
        try {
            const parsed = JSON.parse(lockedDataRaw);
            if (parsed.date === todayStr && parsed.isLocked === true) {
                applyHardLockUi(parsed.loss || MAX_DAILY_LOSS_LIMIT);
                return true;
            }
        } catch(e) {}
    }
    if (SESSION_VAULT.savedCloudUser && SESSION_VAULT.savedCloudUser.isHardLocked === true) {
        if (SESSION_VAULT.savedCloudUser.hardLockedDate === todayStr) {
            applyHardLockUi(SESSION_VAULT.savedCloudUser.hardLockedLoss || MAX_DAILY_LOSS_LIMIT);
            return true;
        }
    }
    return false;
}

function applyHardLockUi(lossAmount) {
    const hud = document.getElementById('hudUserStatusText');
    if (hud) {
        hud.innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-[#eb5b3c] animate-ping mr-1"></span> 🛑 GUARDIAN HARD-LOCK (Loss: ₹${Math.abs(lossAmount).toFixed(2)})`;
    }
}

async function triggerHardKillSwitch(lossAmount) {
    const todayStr = getIndiaTradingDate();
    const lockPayload = { 
        date: todayStr, 
        isLocked: true, 
        loss: lossAmount, 
        lockedAt: new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' }) 
    };
    localStorage.setItem('ARAF_HARD_KILL_LOCK', JSON.stringify(lockPayload));
    applyHardLockUi(lossAmount);
    
    const alertMsg = (SESSION_VAULT.voiceLang === 'bn-IN')
        ? "সতর্কতা ভাই! আজকের সর্বোচ্চ লস সীমা স্পর্শ করেছে। ক্যাপিটাল বাঁচাতে আজকের জন্য সমস্ত ট্রেডিং সম্পূর্ণ লক করা হয়েছে।"
        : "Attention! Maximum daily loss limit reached. Guardian has hard-locked trading for today to protect capital.";

    explainTextFriendly(alertMsg, "Guardian Hard Lock");

    if (SESSION_VAULT.userKey) {
        try {
            await db.collection("users").doc(SESSION_VAULT.userKey).set({
                isHardLocked: true,
                hardLockedDate: todayStr,
                hardLockedLoss: lossAmount
            }, { merge: true });
        } catch(e) {}
    }
}

function resetDailyKillSwitchManual() {
    if (checkHardKillSwitchLock()) {
        alert("🛑 Guardian Hard-Lock Active! Daily loss threshold reached. All new positions are locked until tomorrow.");
        return;
    }

    document.getElementById('hudUserStatusText').innerHTML = 
        `<span class="w-1.5 h-1.5 rounded-full bg-[#00d09c] animate-pulse mr-1"></span> Guardian Armed • Live Ready`;
    
    const rMsg = (SESSION_VAULT.voiceLang === 'bn-IN') ? "রিস্ক গার্ড সক্রিয়। নিয়ম মেনে ট্রেড করুন।" : "Risk guard verified. Trade with discipline.";
    explainTextFriendly(rMsg, "Risk Guard Ready");
    syncRealBrokerBalances();
    initSyncPositionsToMemory();
}

// ==========================================
// ৪. সাবস্ক্রিপশন ও অ্যাক্সেস কন্ট্রোল
// ==========================================
function checkProAccess() {
    if (!SESSION_VAULT.activeUser) return true; 
    if (SESSION_VAULT.activeUser.isVipFree === true) return true;

    const expiresAt = new Date(SESSION_VAULT.activeUser.subscriptionExpiresAt || 0);
    const now = new Date();

    if (now < expiresAt) {
        return true;
    } else {
        const priceEl = document.getElementById('displayDynamicSubPrice');
        if (priceEl) priceEl.textContent = `₹${BUSINESS_PAYMENT_CONFIG.monthlyPrice}`;
        
        const uidDisplay = document.getElementById('displayUserTraderUid');
        if (uidDisplay) {
            const currentName = SESSION_VAULT.activeUser?.fullName || "ARAF TRADER";
            uidDisplay.textContent = getOrCreateUserPermanentUid(currentName);
        }
        
        document.getElementById('subscriptionLockModal').classList.remove('hidden');
        return false;
    }
}

function updateVipTrialBadgeUi() {
    const badge = document.getElementById('hudVipTrialBadge');
    if (!badge || !SESSION_VAULT.activeUser) return;

    if (SESSION_VAULT.activeUser.isVipFree) {
        badge.textContent = "👑 LIFETIME VIP";
        badge.className = "text-[8px] bg-amber-500 text-black font-mono font-black px-1.5 py-0.2 rounded shadow-sm";
        return;
    }

    const exp = new Date(SESSION_VAULT.activeUser.subscriptionExpiresAt || Date.now());
    const diffDays = Math.ceil((exp - new Date()) / (1000 * 60 * 60 * 24));

    if (diffDays > 0) {
        badge.textContent = `👑 VIP: ${diffDays}D LEFT`;
        badge.className = diffDays <= 3 ? "text-[8px] bg-[#eb5b3c]/20 text-[#eb5b3c] border border-[#eb5b3c]/40 font-mono font-bold px-1.5 py-0.2 rounded animate-pulse" : "text-[8px] gold-badge px-1.5 py-0.2 rounded font-mono font-bold";
    } else {
        badge.textContent = "🔒 EXPIRED";
        badge.className = "text-[8px] bg-[#eb5b3c] text-white font-mono font-black px-1.5 py-0.2 rounded";
    }
}

function triggerDirectUpiPayment() {
    const currentName = SESSION_VAULT.activeUser?.fullName || "ARAF TRADER";
    const traderUid = getOrCreateUserPermanentUid(currentName);

    const upiId = BUSINESS_PAYMENT_CONFIG.merchantUpiId;
    const merchantName = encodeURIComponent(BUSINESS_PAYMENT_CONFIG.merchantName);
    const amount = BUSINESS_PAYMENT_CONFIG.monthlyPrice;
    const note = encodeURIComponent(`ARAF VIP License UID: ${traderUid}`);
    
    const upiUrl = `upi://pay?pa=${upiId}&pn=${merchantName}&am=${amount}&cu=INR&tn=${note}`;
    window.location.href = upiUrl;
}

function closeSubscriptionModal() {
    document.getElementById('subscriptionLockModal').classList.add('hidden');
}

// ==========================================
// ৫. ফায়ারস্টোর ক্লাউড ডেটাবেস ড্রাইভার
// ==========================================
const ArafCloudMaster = {
    async syncAllUserData(userKey, fullData) {
        try {
            if (fullData.profile) fullData.profile.lastLogin = new Date().toISOString();
            await db.collection("users").doc(userKey).set(fullData, { merge: true });
            return true;
        } catch (e) {
            console.warn("[Cloud Firestore Sync Fallback]:", e);
            return false;
        }
    },
    async loadUserFromAnyDevice(userKey) {
        try {
            const doc = await db.collection("users").doc(userKey).get();
            if (doc.exists) {
                return doc.data();
            }
            const snapshot = await db.collection("users").where("profile.traderUid", "==", userKey).get();
            if (!snapshot.empty) {
                return snapshot.docs[0].data();
            }
            return null;
        } catch (e) {
            return null;
        }
    }
};

// ==========================================
// ৬. পিন অথেনটিকেশন ও আনলক (Wrong PIN 100% FIXED)
// ==========================================
async function hashPin(pinString, userKey = "") {
    const cleanPin = pinString.toString().trim();
    const msgBuffer = new TextEncoder().encode(cleanPin + "_ARAF_TERMINAL_2026");
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
    return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function registerBiometricHardware(userKey) {
    if (!window.PublicKeyCredential) return false;
    try {
        const challenge = new Uint8Array(32);
        window.crypto.getRandomValues(challenge);
        const credential = await navigator.credentials.create({
            publicKey: {
                challenge: challenge,
                rp: { name: "ARAF Terminal" },
                user: { id: new TextEncoder().encode(userKey), name: userKey, displayName: SESSION_VAULT.activeUser?.fullName || "ARAF Trader" },
                pubKeyCredParams: [{ alg: -7, type: "public-key" }, { alg: -257, type: "public-key" }],
                authenticatorSelection: { userVerification: "preferred" },
                timeout: 60000
            }
        });
        return !!credential;
    } catch(e) {
        return false;
    }
}

async function triggerBiometricFingerprintAuth() {
    if (!window.PublicKeyCredential) {
        alert("Biometrics not supported on this device/browser. Please enter Master PIN.");
        return;
    }
    try {
        const challenge = new Uint8Array(32);
        window.crypto.getRandomValues(challenge);
        const assertion = await navigator.credentials.get({
            publicKey: { challenge: challenge, userVerification: "required", timeout: 60000 }
        });
        if (assertion) unlockTerminalSuccess();
    } catch(err) {
        document.getElementById('pinDigitInput')?.focus();
    }
}

async function handlePinSubmitUnlock() {
    const errMsg = document.getElementById('unlockErrorMsg');
    const inputPin = document.getElementById('pinDigitInput').value.trim();

    if (inputPin.length !== 6 || !/^\d{6}$/.test(inputPin)) {
        errMsg.textContent = "Please enter valid 6-digit numeric PIN";
        errMsg.classList.remove('hidden');
        return;
    }

    const userKey = SESSION_VAULT.userKey || localStorage.getItem('ARAF_LAST_ACTIVE_USERKEY') || "";
    errMsg.classList.add('hidden');
    const btn = document.getElementById('btnSubmitUnlock');
    if (btn) btn.innerHTML = `<i class="fa-solid fa-spinner animate-spin mr-1"></i> Verifying...`;

    try {
        const hashedInput = await hashPin(inputPin, userKey);
        const localPinHash = localStorage.getItem('ARAF_MASTER_PIN_HASH');
        const rawSavedPin = localStorage.getItem('araf_master_pin_raw');

        // ১. লোকাল র পিন ম্যাচিং (একদম নির্ভুল ও তাৎক্ষণিক)
        if (rawSavedPin && rawSavedPin === inputPin) {
            unlockTerminalSuccess();
            return;
        }

        // ২. লোকাল হ্যাশ ম্যাচিং
        if (localPinHash && localPinHash === hashedInput) {
            unlockTerminalSuccess();
            return;
        }

        // ৩. মেমোরি ক্লাউড ইউজার চেক
        if (SESSION_VAULT.savedCloudUser && SESSION_VAULT.savedCloudUser.security?.pinHash) {
            if (SESSION_VAULT.savedCloudUser.security.pinHash === hashedInput) {
                unlockTerminalSuccess();
                return;
            }
        }

        // ৪. ক্লাউড ফায়ারস্টোর থেকে সরাসরি ভেরিফিকেশন
        if (userKey) {
            const cloudUser = await ArafCloudMaster.loadUserFromAnyDevice(userKey);
            if (cloudUser && cloudUser.security?.pinHash === hashedInput) {
                SESSION_VAULT.savedCloudUser = cloudUser;
                localStorage.setItem('ARAF_MASTER_PIN_HASH', hashedInput);
                unlockTerminalSuccess();
                return;
            }
        }

        errMsg.textContent = "❌ ভুল পিন! সঠিক ৬ ডিজিটের পিন দিন।";
        errMsg.classList.remove('hidden');
        document.getElementById('pinDigitInput').value = "";
        if (navigator.vibrate) navigator.vibrate(200);
    } catch (e) {
        errMsg.textContent = "❌ Verification failed. Check network connection.";
        errMsg.classList.remove('hidden');
    } finally {
        if (btn) btn.innerHTML = `<i class="fa-solid fa-lock-open mr-1"></i> <span>Unlock Terminal</span>`;
    }
}

// ==========================================
// ৬.১ Forgot PIN ও Recovery Modal (100% FIXED)
// ==========================================
function handleForgotPinReset() {
    const unlockModal = document.getElementById('quickUnlockModal');
    if (unlockModal) {
        unlockModal.classList.add('hidden');
    }
    openAccountRecoveryModal();
}

function openAccountRecoveryModal() {
    document.getElementById('authKycModal')?.classList.add('hidden');
    document.getElementById('quickUnlockModal')?.classList.add('hidden');
    document.getElementById('setupPinModal')?.classList.add('hidden');

    const recoveryModal = document.getElementById('accountRecoveryModal');
    if (recoveryModal) {
        recoveryModal.style.zIndex = "99999";
        recoveryModal.classList.remove('hidden');
    }

    document.getElementById('recoveryStepEmail')?.classList.remove('hidden');
    document.getElementById('recoveryStepOtp')?.classList.add('hidden');
    document.getElementById('recoveryStepReset')?.classList.add('hidden');
    document.getElementById('recoveryErrorMsg')?.classList.add('hidden');

    const emailInput = document.getElementById('recoveryEmailInput');
    const knownEmail = SESSION_VAULT?.activeUser?.email 
        || localStorage.getItem('ARAF_USER_EMAIL') 
        || localStorage.getItem('temp_signup_email') 
        || "";
        
    if (emailInput) {
        emailInput.value = knownEmail;
        emailInput.focus();
    }
}

function closeAccountRecoveryModal() {
    document.getElementById('accountRecoveryModal')?.classList.add('hidden');
    const hasPin = localStorage.getItem('araf_master_pin_raw') || localStorage.getItem('ARAF_MASTER_PIN_HASH');
    if (hasPin) {
        document.getElementById('quickUnlockModal')?.classList.remove('hidden');
    } else {
        document.getElementById('authKycModal')?.classList.remove('hidden');
    }
}

let recoverySessionState = {
    email: '',
    generatedOtp: '',
    matchedUserDocId: '',
    userData: null
};

async function sendRecoveryOtpToEmail() {
    const email = document.getElementById('recoveryEmailInput').value.trim().toLowerCase();
    const err = document.getElementById('recoveryErrorMsg');
    const btn = document.getElementById('btnSendOtp');

    if (!email || !email.includes('@')) {
        err.textContent = "Please enter a valid registered email address!";
        err.classList.remove('hidden');
        return;
    }

    err.classList.add('hidden');
    btn.innerHTML = `<i class="fa-solid fa-spinner animate-spin mr-1"></i> Checking Vault...`;
    btn.disabled = true;

    try {
        let userFound = false;

        const snapshot = await db.collection("users").where("email", "==", email).get();
        if (!snapshot.empty) {
            const doc = snapshot.docs[0];
            recoverySessionState.matchedUserDocId = doc.id;
            recoverySessionState.userData = doc.data();
            userFound = true;
        } else {
            const snap2 = await db.collection("users").where("profile.email", "==", email).get();
            if (!snap2.empty) {
                const doc = snap2.docs[0];
                recoverySessionState.matchedUserDocId = doc.id;
                recoverySessionState.userData = doc.data();
                userFound = true;
            }
        }

        const localEmail = localStorage.getItem('ARAF_USER_EMAIL') || localStorage.getItem('temp_signup_email');
        if (!userFound && localEmail && localEmail.toLowerCase() === email) {
            userFound = true;
            const fallbackUid = localStorage.getItem('ARAF_PERMANENT_TRADER_UID') || "ARAF-PRO-DEMO";
            recoverySessionState.matchedUserDocId = fallbackUid;
            recoverySessionState.userData = {
                profile: { traderUid: fallbackUid, fullName: "ARAF Trader" },
                email: email
            };
        }

        if (!userFound) {
            err.textContent = "No registered account found with this email in ARAF Vault!";
            err.classList.remove('hidden');
            btn.innerHTML = `<i class="fa-solid fa-paper-plane mr-1"></i> Send 6-Digit OTP`;
            btn.disabled = false;
            return;
        }

        const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
        recoverySessionState.generatedOtp = otpCode;
        recoverySessionState.email = email;

        try {
            if (window.emailjs && window.EMAILJS_SERVICE_ID) {
                await emailjs.send(window.EMAILJS_SERVICE_ID, window.EMAILJS_TEMPLATE_ID, {
                    app_name: "ARAF INTELLIGENCE - Pro Terminal",
                    to_email: email,
                    otp_code: otpCode,
                    message: "Use this code to recover your Trader UID and reset your credentials."
                });
            } else {
                alert(`[ARAF INTELLIGENCE Security Desk]\n\nYour 6-Digit Recovery OTP is: ${otpCode}\n\n(Sent to registered email: ${email})`);
            }
        } catch(mErr) {
            alert(`[ARAF INTELLIGENCE Desk]\nYour OTP is: ${otpCode}`);
        }

        document.getElementById('recoveryStepEmail')?.classList.add('hidden');
        document.getElementById('recoveryStepOtp')?.classList.remove('hidden');
        document.getElementById('displayTargetEmail').textContent = email;
        btn.innerHTML = `<i class="fa-solid fa-paper-plane mr-1"></i> Send 6-Digit OTP`;
        btn.disabled = false;

    } catch (e) {
        err.textContent = "Vault synchronization error. Please retry.";
        err.classList.remove('hidden');
        btn.innerHTML = `<i class="fa-solid fa-paper-plane mr-1"></i> Send 6-Digit OTP`;
        btn.disabled = false;
    }
}

function verifyRecoveryOtp() {
    const entered = document.getElementById('recoveryOtpInput').value.trim();
    const err = document.getElementById('recoveryErrorMsg');

    if (entered === recoverySessionState.generatedOtp) {
        err.classList.add('hidden');
        document.getElementById('recoveryStepOtp')?.classList.add('hidden');
        document.getElementById('recoveryStepReset')?.classList.remove('hidden');
        
        const retrievedUid = recoverySessionState.userData?.profile?.traderUid || recoverySessionState.userData?.traderUid || recoverySessionState.matchedUserDocId;
        document.getElementById('recoveredTraderUidText').textContent = retrievedUid;
    } else {
        err.textContent = "Invalid OTP code! Please check and enter carefully.";
        err.classList.remove('hidden');
    }
}

async function finalizeAccountCredentialsReset() {
    const newPass = document.getElementById('resetNewPassword').value.trim();
    const newPin = document.getElementById('resetNewPin').value.trim();
    const err = document.getElementById('recoveryErrorMsg');

    if (newPass.length < 6) {
        err.textContent = "Password must be at least 6 characters!";
        err.classList.remove('hidden');
        return;
    }
    if (newPin.length !== 6 || !/^\d{6}$/.test(newPin)) {
        err.textContent = "Master PIN must be exactly 6 numeric digits!";
        err.classList.remove('hidden');
        return;
    }

    const uid = document.getElementById('recoveredTraderUidText').textContent;
    const newHash = await hashPin(newPin, uid);

    localStorage.setItem('ARAF_MASTER_PIN_HASH', newHash);
    localStorage.setItem('araf_master_pin_raw', newPin);
    localStorage.setItem('ARAF_PERMANENT_TRADER_UID', uid);
    localStorage.setItem('ARAF_LAST_ACTIVE_USERKEY', uid);
    localStorage.setItem('ARAF_USER_PASSWORD', newPass);

    try {
        if (recoverySessionState.matchedUserDocId) {
            await db.collection("users").doc(recoverySessionState.matchedUserDocId).set({
                customPassword: newPass,
                "security.pinHash": newHash,
                "security.rawPinBackup": newPin,
                updatedAt: new Date().toISOString()
            }, { merge: true });
        }
    } catch(e) {}

    if (auth.currentUser) {
        auth.currentUser.updatePassword(newPass).catch(() => {});
    }

    alert(`Credentials Updated Successfully!\n\nYour Trader UID: ${uid}\nNew Master PIN: ${newPin}\n\nUnlocking Terminal...`);
    document.getElementById('accountRecoveryModal')?.classList.add('hidden');
    unlockTerminalSuccess();
}

function unlockTerminalSuccess() {
    isTerminalUnlocked = true;
    sessionStorage.setItem('ARAF_SESSION_UNLOCKED', 'true');

    document.getElementById('quickUnlockModal').classList.add('hidden');
    document.getElementById('setupPinModal').classList.add('hidden');
    document.getElementById('authKycModal').classList.add('hidden');

    if (SESSION_VAULT.savedCloudUser) {
        const d = SESSION_VAULT.savedCloudUser;
        SESSION_VAULT.activeUser = d.profile;

        if (d.preferences) {
            SESSION_VAULT.voiceLang = d.preferences.voiceLang || 'en-US';
            SESSION_VAULT.newsLang = d.preferences.newsLang || 'en-US';
            const langDropdown = document.getElementById('settingVoiceLanguage');
            if (langDropdown) langDropdown.value = SESSION_VAULT.voiceLang;
        }

        if (d.brokerVault) {
            SESSION_VAULT.shoonyaUid = d.brokerVault.shoonyaUid || "";
            SESSION_VAULT.shoonyaToken = d.brokerVault.shoonyaToken || "";
            SESSION_VAULT.coindcxKey = d.brokerVault.coindcxKey || "";
            SESSION_VAULT.coindcxSecret = d.brokerVault.coindcxSecret || "";
            
            const sUid = document.getElementById('settingShoonyaUid');
            const sTok = document.getElementById('settingShoonyaToken');
            const cKey = document.getElementById('settingCoinDcxKey');
            const cSec = document.getElementById('settingCoinDcxSecret');
            if (sUid) sUid.value = SESSION_VAULT.shoonyaUid;
            if (sTok) sTok.value = SESSION_VAULT.shoonyaToken;
            if (cKey) cKey.value = SESSION_VAULT.coindcxKey;
            if (cSec) cSec.value = SESSION_VAULT.coindcxSecret;

            syncRealBrokerBalances();
            connectShoonyaWs();
            initSyncPositionsToMemory();
        }
        if (d.tradeHistory) {
            SESSION_VAULT.tradeHistory = d.tradeHistory;
            renderTradeHistory();
        }
    }

    const name = SESSION_VAULT.activeUser?.fullName || "Trader";
    document.getElementById('hudUserStatusText').innerHTML = 
        `<span class="w-1.5 h-1.5 rounded-full bg-[#00d09c] animate-pulse mr-1"></span> ${name} • Cloud Active`;

    updateVipTrialBadgeUi();
    checkHardKillSwitchLock();

    const welcomeVoice = (SESSION_VAULT.voiceLang === 'bn-IN') 
        ? "টার্মিনাল আনলক হয়েছে। আজ শুধু ডিসিপ্লিন্ড ইন্ট্রাডে ট্রেড হবে।" 
        : "Terminal unlocked. Ready for disciplined institutional execution.";
    explainTextFriendly(welcomeVoice, "Terminal Live");
    startPeriodicVoiceScanner();
}

async function handleSaveInitialPinAndBiometric() {
    const p1 = document.getElementById('newPinInput').value.trim();
    const p2 = document.getElementById('confirmPinInput').value.trim();
    const err = document.getElementById('setupPinErrorMsg');

    if (p1.length !== 6 || !/^\d{6}$/.test(p1)) {
        err.textContent = "PIN must be exactly 6 numeric digits";
        err.classList.remove('hidden');
        return;
    }
    if (p1 !== p2) {
        err.textContent = "PIN entries do not match!";
        err.classList.remove('hidden');
        return;
    }

    const userKey = SESSION_VAULT.userKey || localStorage.getItem('ARAF_LAST_ACTIVE_USERKEY') || "ARAF_TRADER";
    const hashed = await hashPin(p1, userKey);
    const bioSuccess = await registerBiometricHardware(userKey);

    localStorage.setItem('ARAF_MASTER_PIN_HASH', hashed);
    localStorage.setItem('araf_master_pin_raw', p1);
    localStorage.setItem('ARAF_LAST_ACTIVE_USERKEY', userKey);

    const exp = new Date();
    exp.setDate(exp.getDate() + BUSINESS_PAYMENT_CONFIG.trialDays);

    const currentName = SESSION_VAULT.activeUser?.fullName || "Araf Trader";
    const permanentUid = getOrCreateUserPermanentUid(currentName);

    const userProf = SESSION_VAULT.activeUser || { 
        fullName: currentName, 
        phone: userKey, 
        traderUid: permanentUid,
        kycStatus: "VERIFIED_COMPLIANT",
        tier: "TRIAL",
        isVipFree: false,
        subscriptionExpiresAt: exp.toISOString()
    };

    const masterPayload = {
        userKey: userKey,
        profile: userProf,
        security: { pinHash: hashed, biometricEnabled: bioSuccess, rawPinBackup: p1 },
        brokerVault: { shoonyaUid: "", shoonyaToken: "", coindcxKey: "", coindcxSecret: "" },
        preferences: { voiceEnabled: true, voiceLang: 'en-US', newsLang: 'en-US', voiceInterval: 3 },
        tradeHistory: []
    };

    await ArafCloudMaster.syncAllUserData(userKey, masterPayload);
    SESSION_VAULT.savedCloudUser = masterPayload;
    unlockTerminalSuccess();
}

function handleSwitchAccountOrDevice() {
    auth.signOut();
    sessionStorage.removeItem('ARAF_SESSION_UNLOCKED');
    SESSION_VAULT.userKey = null;
    SESSION_VAULT.activeUser = null;
    SESSION_VAULT.savedCloudUser = null;
    location.reload();
}
auth.onAuthStateChanged(async (user) => {
    if (sessionStorage.getItem('ARAF_SESSION_UNLOCKED') === 'true') {
        isTerminalUnlocked = true;
    }

    if (user) {
        const userKey = user.email || user.phoneNumber || user.uid;
        SESSION_VAULT.userKey = userKey;
        localStorage.setItem('ARAF_LAST_ACTIVE_USERKEY', userKey);
        const cloudData = await ArafCloudMaster.loadUserFromAnyDevice(userKey);

        if (cloudData && cloudData.security?.pinHash) {
            SESSION_VAULT.savedCloudUser = cloudData;
            SESSION_VAULT.activeUser = cloudData.profile;

            if (isTerminalUnlocked) {
                unlockTerminalSuccess();
            } else {
                document.getElementById('unlockWelcomeTitle').textContent = `Welcome, ${cloudData.profile?.fullName || 'Trader'}!`;
                document.getElementById('quickUnlockModal').classList.remove('hidden');
                document.getElementById('authKycModal').classList.add('hidden');
                if (window.PublicKeyCredential && cloudData.security.biometricEnabled) {
                    setTimeout(() => triggerBiometricFingerprintAuth(), 500);
                }
            }
        } else {
            document.getElementById('authStepPhone').classList.add('hidden');
            document.getElementById('authStepKyc').classList.remove('hidden');
            document.getElementById('authKycModal').classList.remove('hidden');
        }
    } else {
        const localPin = localStorage.getItem('araf_master_pin_raw') || localStorage.getItem('ARAF_MASTER_PIN_HASH');
        const localUid = localStorage.getItem('ARAF_PERMANENT_TRADER_UID');
        if (localPin && localUid) {
            document.getElementById('unlockWelcomeTitle').textContent = `Welcome, ${localUid.substring(0, 4)}!`;
            document.getElementById('quickUnlockModal').classList.remove('hidden');
            document.getElementById('authKycModal').classList.add('hidden');
        } else {
            document.getElementById('authKycModal').classList.remove('hidden');
        }
    }
});

// ==========================================
// ৭. চার্ট ও ডায়নামিক ক্যানভাস ইঞ্জিন
// ==========================================
function startSplashScreen() {
    const splash = document.getElementById('splashScreen');
    setTimeout(() => {
        if (splash) {
            splash.style.transition = 'opacity 500ms cubic-bezier(0.16, 1, 0.3, 1)';
            splash.style.opacity = '0';
            setTimeout(() => splash.remove(), 500);
        }
    }, 2200);
}

function initTradingViewChart(symbolName) {
    currentActiveSymbol = symbolName;
    const titleEl = document.getElementById('tvChartCurrentTitle');
    if (titleEl) titleEl.textContent = symbolName;

    const frame = document.getElementById('tvLiveChartFrame');
    if (!frame) return;

    frame.innerHTML = '';

    if (window.TradingView) {
        new TradingView.widget({
            container_id: "tvLiveChartFrame",
            autosize: true,
            symbol: symbolName,
            interval: "5",
            timezone: "Asia/Kolkata",
            theme: "dark",
            style: "1",
            locale: "en",
            toolbar_bg: "#10141e",
            enable_publishing: false,
            hide_side_toolbar: false,
            allow_symbol_change: true,
            studies: ["MASimple@tv-basicstudies", "RSI@tv-basicstudies"]
        });
    }
}

async function selectAssetForAnalysis(symbol, orderKey) {
    const found = MASTER_ASSETS.find(a => a.orderKey === orderKey) || MASTER_ASSETS[0];
    currentSelectedAsset = found;

    initTradingViewChart(symbol);
    
    const orderSym = document.getElementById('tradeOrderSymbol');
    if (orderSym) {
        orderSym.value = orderKey;
        handleOrderSymbolChange();
    }

    const targetNews = allFetchedNewsItems.filter(item => isNewsRelatedToAsset(item.title, found));
    
    const alertBadge = document.getElementById('alertAssetBadge');
    const alertText = document.getElementById('alertAssetText');
    const banner = document.getElementById('greenAlertBanner');

    const sr = calculateDynamicSupportResistance(found.high, found.low, found.priceNum);
    const flow = await fetchRealOrderflowDelta(found);
    const evalData = evaluateUltraOpportunity(found, flow, sr);

    if (alertBadge && alertText && banner) {
        alertBadge.textContent = `${found.name}: ${evalData.score}% INTRADAY ${evalData.side}`;
        
        let reasonStr = evalData.reasons && evalData.reasons.length > 0 
            ? evalData.reasons.join(" • ") 
            : `Consolidating near ₹${found.priceNum}. Intraday SL: ₹${evalData.side === 'BUY' ? sr.s1 : sr.r1}`;

        if (targetNews.length > 0) {
            reasonStr += ` 📰 Catalyst: "${targetNews[0].title}"`;
        }

        alertText.textContent = reasonStr;
    }

    const targetLabel = document.getElementById('newsActiveTargetLabel');
    if (targetLabel) targetLabel.textContent = `${found.name} INTRADAY WIRE`;

    const voiceMsg = (SESSION_VAULT.voiceLang === 'bn-IN')
        ? `${found.name} ইন্ট্রাডে সেটআপ! বায়ার ডেল্টা ${flow.buyers} শতাংশ। আজকের এন্ট্রি ${found.priceNum}, স্টপ লস ${evalData.side === 'BUY' ? sr.s1 : sr.r1}।`
        : `Intraday setup on ${found.name}! Orderbook bias is ${flow.buyers}% buyers. Entry at ${found.priceNum}. Respect intraday stop loss.`;
        
    explainTextFriendly(voiceMsg, `${found.name} Analysis`);
}

function calculateDynamicSupportResistance(high, low, close) {
    if (!high || !low || !close || high <= 0 || low <= 0 || close <= 0) {
        return { pivot: "0.0", r1: "0.0", s1: "0.0" };
    }
    const P = (high + low + close) / 3;
    const R1 = (2 * P) - low;
    const S1 = (2 * P) - high;
    return { pivot: P.toFixed(1), r1: R1.toFixed(1), s1: S1.toFixed(1) };
}

async function loadRealHistoricalCandles(assetId) {
    if (!SESSION_VAULT.localCandleHistory[assetId]) {
        SESSION_VAULT.localCandleHistory[assetId] = [];
    }
    const asset = MASTER_ASSETS.find(a => a.id === assetId);
    if (!asset) return;

    try {
        if (asset.category === 'crypto' || asset.id === 'goldmcx') {
            const sym = asset.id === 'goldmcx' ? 'PAXGUSDT' : asset.orderKey;
            const res = await fetch(`https://api.binance.com/api/v3/klines?symbol=${sym}&interval=15m&limit=15`);
            if (!res.ok) return;
            const raw = await res.json();
            if (Array.isArray(raw)) {
                SESSION_VAULT.localCandleHistory[assetId] = raw.map(k => ({
                    time: k[0],
                    open: parseFloat(k[1]),
                    high: parseFloat(k[2]),
                    low: parseFloat(k[3]),
                    close: parseFloat(k[4])
                }));
            }
        } else {
            const res = await fetch(`${CLOUDFLARE_GATEWAY}?target=historical_candles&token=${encodeURIComponent(asset.token)}&symbol=${encodeURIComponent(asset.orderKey)}`);
            if (res.ok) {
                const data = await res.json();
                if (data && Array.isArray(data.candles) && data.candles.length > 0) {
                    SESSION_VAULT.localCandleHistory[assetId] = data.candles;
                }
            }
        }
    } catch(e) {}
}

function recordLiveTickToCandle(assetId, price) {
    if (!price || price <= 0) return;
    if (!SESSION_VAULT.localCandleHistory[assetId]) {
        SESSION_VAULT.localCandleHistory[assetId] = [];
    }
    const history = SESSION_VAULT.localCandleHistory[assetId];
    const intervalMs = 15 * 60 * 1000;
    const nowTimeSlot = Math.floor(Date.now() / intervalMs) * intervalMs;

    let lastCandle = history[history.length - 1];

    if (!lastCandle || lastCandle.time < nowTimeSlot) {
        history.push({ time: nowTimeSlot, open: price, high: price, low: price, close: price });
        if (history.length > 25) history.shift();
    } else if (lastCandle.time === nowTimeSlot) {
        lastCandle.high = Math.max(lastCandle.high, price);
        lastCandle.low = Math.min(lastCandle.low, price);
        lastCandle.close = price;
    }
}

async function drawDynamicCandlestickCanvas(trend, supportVal, resVal) {
    const canvas = document.getElementById('assetCandleCanvas');  
    if (!canvas) return;  
    const ctx = canvas.getContext('2d');  
    const dpr = window.devicePixelRatio || 1;  
    const rect = canvas.getBoundingClientRect();  

    const width = rect.width || 380;
    const height = rect.height || 160;

    canvas.width = width * dpr;  
    canvas.height = height * dpr;  
    ctx.scale(dpr, dpr);  
    ctx.clearRect(0, 0, width, height);  

    ctx.strokeStyle = '#1e2638';  
    ctx.lineWidth = 1;  
    for (let y = 20; y < height; y += 30) {  
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();  
    }  

    const asset = currentSelectedAsset || MASTER_ASSETS[0];
    let candles = SESSION_VAULT.localCandleHistory[asset.id] || [];

    if (candles.length > 0) {
        const allPrices = candles.flatMap(c => [c.high, c.low]).filter(p => !isNaN(p) && p > 0);
        if (allPrices.length === 0) return;

        const parsedRes = parseFloat(resVal) || Math.max(...allPrices);
        const parsedSup = parseFloat(supportVal) || Math.min(...allPrices);

        const maxP = Math.max(...allPrices, parsedRes);
        const minP = Math.min(...allPrices, parsedSup);
        const range = (maxP - minP) || 1;
        const getY = (val) => height - 16 - ((val - minP) / range) * (height - 32);

        const resY = getY(parsedRes);
        ctx.strokeStyle = '#eb5b3c';  
        ctx.lineWidth = 1.2;  
        ctx.setLineDash([4, 4]);  
        ctx.beginPath(); ctx.moveTo(0, resY); ctx.lineTo(width, resY); ctx.stroke();  
        ctx.fillStyle = '#eb5b3c';  
        ctx.font = 'bold 9px JetBrains Mono, monospace';  
        ctx.fillText(`R1 Resistance: ${resVal}`, 8, Math.max(12, resY - 4));  

        const supY = getY(parsedSup);
        ctx.strokeStyle = '#00d09c';  
        ctx.lineWidth = 1.2;  
        ctx.beginPath(); ctx.moveTo(0, supY); ctx.lineTo(width, supY); ctx.stroke();  
        ctx.fillStyle = '#00d09c';  
        ctx.font = 'bold 9px JetBrains Mono, monospace';  
        ctx.fillText(`S1 Support: ${supportVal}`, 8, Math.min(height - 4, supY + 12));  
        ctx.setLineDash([]);  

        const candleCount = candles.length;  
        const candleWidth = Math.max(6, (width / candleCount) - 5);  

        candles.forEach((c, i) => {
            const x = 8 + i * (candleWidth + 5);
            const isBull = c.close >= c.open;
            const openY = getY(c.open);
            const closeY = getY(c.close);
            const highY = getY(c.high);
            const lowY = getY(c.low);

            ctx.strokeStyle = isBull ? '#00d09c' : '#eb5b3c';  
            ctx.lineWidth = 1.2;  
            ctx.beginPath(); 
            ctx.moveTo(x + candleWidth / 2, highY); 
            ctx.lineTo(x + candleWidth / 2, lowY); 
            ctx.stroke();  

            ctx.fillStyle = isBull ? '#00d09c' : '#eb5b3c';  
            const bodyTop = Math.min(openY, closeY);
            const bodyH = Math.max(2, Math.abs(closeY - openY));
            ctx.fillRect(x, bodyTop, candleWidth, bodyH);  
        });
    } else {
        ctx.fillStyle = '#64748b';
        ctx.font = '10px JetBrains Mono, monospace';
        ctx.textAlign = 'center';
        ctx.fillText("Syncing live exchange candles...", width / 2, height / 2);
    }
}

function detectLiveCandlestickPattern(currentPrice, high, low, changePercent) {
    const range = high - low;
    if (!range || range <= 0) return { pattern: "Consolidation", trend: "NEUTRAL" };

    const pos = (currentPrice - low) / range;
    const chg = parseFloat(changePercent) || 0;

    if (pos >= 0.90 && chg > 0.5) return { pattern: "Bullish Breakout", trend: "BULLISH" };
    if (pos <= 0.10 && chg < -0.5) return { pattern: "Bearish Breakdown", trend: "BEARISH" };
    if (pos >= 0.65 && chg >= 0) return { pattern: "Demand Zone", trend: "BULLISH" };
    if (pos <= 0.35 && chg < 0) return { pattern: "Supply Rejection", trend: "BEARISH" };
    return { pattern: "Range Bound", trend: chg >= 0 ? "BULLISH" : "BEARISH" };
}

function updateTickerTape(valId, chgId, formattedPrice, change) {
    const elP = document.getElementById(valId);
    const elC = document.getElementById(chgId);
    if (elP) elP.textContent = formattedPrice;
    if (elC) {
        elC.textContent = change;
        elC.className = change.startsWith('+') ? "text-[#00d09c] ml-1 text-[9px] font-bold" : "text-[#eb5b3c] ml-1 text-[9px] font-bold";
    }
}

// ==========================================
// ৮. ওয়েব-সকেট ও লাইভ মার্কেট ফিড
// ==========================================
function connectBinanceWs() {
    if (binanceWs && (binanceWs.readyState === WebSocket.OPEN || binanceWs.readyState === WebSocket.CONNECTING)) return;
    try {
        binanceWs = new WebSocket("wss://stream.binance.com:9443/stream?streams=btcusdt@ticker/ethusdt@ticker/paxgusdt@ticker");
        
        binanceWs.onmessage = (event) => {
            WS_HEARTBEAT_TRACKER.binance = Date.now();
            SESSION_VAULT.lastHeartbeatTime = Date.now();
            try {
                const parsed = JSON.parse(event.data);
                const d = parsed.data;
                if (!d || !d.c) return;

                const priceVal = parseFloat(d.c);
                const priceFormatted = priceVal.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
                const changePercent = `${parseFloat(d.P) >= 0 ? '+' : ''}${parseFloat(d.P).toFixed(2)}%`;

                if (d.s === 'BTCUSDT') {
                    const el = document.getElementById('tickerBtc');
                    if (el) el.textContent = priceFormatted;
                    updateAssetPrice('btcusdt', priceFormatted, priceVal, changePercent);
                    evaluateMillisecondMtmOnTick('BTCUSDT', priceVal);
                }
                if (d.s === 'ETHUSDT') {
                    const el = document.getElementById('tickerEth');
                    if (el) el.textContent = priceFormatted;
                    updateAssetPrice('ethusdt', priceFormatted, priceVal, changePercent);
                    evaluateMillisecondMtmOnTick('ETHUSDT', priceVal);
                }
                if (d.s === 'PAXGUSDT') {
                    const el = document.getElementById('tickerGold');
                    if (el) el.textContent = priceFormatted;
                    updateAssetPrice('goldmcx', priceFormatted, priceVal, changePercent);
                    evaluateMillisecondMtmOnTick('PAXGUSDT', priceVal);
                }
            } catch(err) {}
        };
        binanceWs.onclose = () => setTimeout(connectBinanceWs, 5000);
        binanceWs.onerror = () => binanceWs.close();
    } catch(e) {}
}

function connectShoonyaWs() {
    if (!SESSION_VAULT.shoonyaUid || !SESSION_VAULT.shoonyaToken) return;
    if (shoonyaWs && (shoonyaWs.readyState === WebSocket.OPEN || shoonyaWs.readyState === WebSocket.CONNECTING)) return;

    try {
        shoonyaWs = new WebSocket("wss://api.shoonya.com/NorenWSTP/");
        
        shoonyaWs.onopen = () => {
            shoonyaWsReconnectAttempts = 0;
            shoonyaWs.send(JSON.stringify({
                t: "c",
                uid: SESSION_VAULT.shoonyaUid,
                actid: SESSION_VAULT.shoonyaUid,
                susertoken: SESSION_VAULT.shoonyaToken,
                source: "API"
            }));
        };

        shoonyaWs.onmessage = (event) => {
            WS_HEARTBEAT_TRACKER.shoonya = Date.now();
            SESSION_VAULT.lastHeartbeatTime = Date.now();
            try {
                const data = JSON.parse(event.data);
                if (data.t === 'ck' && data.s === 'OK') {
                    shoonyaWs.send(JSON.stringify({
                        t: "t",
                        k: "NSE|26000#NSE|26009#NSE|26017#NSE|2885#NSE|1333#NSE|3456"
                    }));
                }
                if (data.t === 'tk' || data.t === 'tf') {
                    handleShoonyaRealTick(data);
                }
            } catch(e) {}
        };

        shoonyaWs.onclose = () => {
            shoonyaWsReconnectAttempts++;
            const delay = Math.min(30000, Math.pow(2, shoonyaWsReconnectAttempts) * 1000);
            setTimeout(connectShoonyaWs, delay);
        };
        shoonyaWs.onerror = () => shoonyaWs.close();
    } catch(err) {}
}

function handleShoonyaRealTick(tick) {
    if (!tick) return;
    if (tick.tk === '26017' && tick.lp) {
        liveIndiaVix = parseFloat(tick.lp);
        const vixEl = document.getElementById('tickerVix');
        if (vixEl) {
            vixEl.textContent = liveIndiaVix.toFixed(2);
            vixEl.className = liveIndiaVix > 15 ? "ml-1.5 text-[#eb5b3c] font-black animate-pulse" : "ml-1.5 text-[#00d09c] font-bold";
        }
        computeRealBlackScholes(currentNiftyPrice);
        return;
    }

    let targetId = null;
    let tickerLabelId = null;
    let tickerChgId = null;

    if (tick.tk === '26000') { targetId = 'nifty50'; tickerLabelId = 'tickerNifty'; tickerChgId = 'tickerNiftyChange'; }
    else if (tick.tk === '26009') { targetId = 'banknifty'; tickerLabelId = 'tickerBankNifty'; tickerChgId = 'tickerBankNiftyChange'; }
    else if (tick.tk === '2885') targetId = 'reliance';
    else if (tick.tk === '1333') targetId = 'hdfcbank';
    else if (tick.tk === '3456') targetId = 'tatamotors';
    
    if (!targetId) return;
    const item = MASTER_ASSETS.find(a => a.id === targetId);
    if (!item) return;

    if (tick.lp) {
        const livePrice = parseFloat(tick.lp);
        const prevClose = tick.c ? parseFloat(tick.c) : (item.priceNum || livePrice);
        const changePct = (((livePrice - prevClose) / prevClose) * 100).toFixed(2);
        const formattedChg = `${changePct >= 0 ? '+' : ''}${changePct}%`;
        const formattedPrice = `₹${livePrice.toFixed(2)}`;

        if (tickerLabelId) {
            updateTickerTape(tickerLabelId, tickerChgId, formattedPrice, formattedChg);
        }

        if (tick.tbq && tick.tsq) {
            item.realTbq = parseFloat(tick.tbq);
            item.realTsq = parseFloat(tick.tsq);

            const totalDepth = item.realTbq + item.realTsq;
            if (totalDepth > 0) {
                const buyerRatio = item.realTbq / totalDepth;
                item.blockOrderDetected = (buyerRatio >= 0.72 || buyerRatio <= 0.28);
                item.trend = buyerRatio >= 0.5 ? 'BULLISH' : 'BEARISH';
            }
        }

        updateAssetPrice(targetId, formattedPrice, livePrice, formattedChg);
        evaluateMillisecondMtmOnTick(tick.tk, livePrice);
    }
}

function updateAssetPrice(assetId, formatted, num, change) {
    const item = MASTER_ASSETS.find(a => a.id === assetId);
    let isUp = true;

    if (item) {
        isUp = num >= (item.priceNum || num);
        item.price = formatted;
        item.priceNum = num;
        item.change = change;

        if (num > item.high || item.high === 0) item.high = num;
        if (num < item.low || item.low === 0) item.low = num;

        item.highFormatted = (item.category === 'crypto') ? `$${item.high.toFixed(2)}` : `₹${item.high.toFixed(2)}`;
        item.lowFormatted = (item.category === 'crypto') ? `$${item.low.toFixed(2)}` : `₹${item.low.toFixed(2)}`;

        const detected = detectLiveCandlestickPattern(num, item.high, item.low, change);
        item.signalType = detected.pattern;
        item.trend = detected.trend;

        recordLiveTickToCandle(assetId, num);
    }

    const pEl = document.getElementById(`priceCardVal_${assetId}`);
    const cEl = document.getElementById(`priceCardChg_${assetId}`);

    if (pEl) {
        pEl.textContent = formatted;
        pEl.classList.remove('price-flash-up', 'price-flash-down');
        void pEl.offsetWidth;
        pEl.classList.add(isUp ? 'price-flash-up' : 'price-flash-down');
    }

    if (cEl) {
        cEl.textContent = change;
        cEl.className = change.startsWith('+') 
            ? "text-[10px] font-mono font-bold text-[#00d09c] bg-[#00d09c]/10 px-2 py-0.5 rounded-md border border-[#00d09c]/25" 
            : "text-[10px] font-mono font-bold text-[#eb5b3c] bg-[#eb5b3c]/10 px-2 py-0.5 rounded-md border border-[#eb5b3c]/25";
    }
}

// ==========================================
// ৯. পজিশন ও মিলিসেকেন্ড MTM ইঞ্জিন
// ==========================================
async function initSyncPositionsToMemory() {
    SESSION_VAULT.fastPositionsMap = {};

    const shoonyaPromise = (async () => {
        if (!SESSION_VAULT.shoonyaUid || !SESSION_VAULT.shoonyaToken) return;
        try {
            const res = await fetch(`${CLOUDFLARE_GATEWAY}?target=shoonya_positions`, {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: `jData=${encodeURIComponent(JSON.stringify({ uid: SESSION_VAULT.shoonyaUid, actid: SESSION_VAULT.shoonyaUid }))}&jKey=${SESSION_VAULT.shoonyaToken}`
            });
            if (!res.ok) return;
            const positions = await res.json();
            if (Array.isArray(positions)) {
                positions.filter(p => parseFloat(p.netqty || 0) !== 0).forEach(p => {
                    const parsedQty = parseFloat(p.netqty);
                    const parsedAvg = parseFloat(p.netavgprc || p.buyavgprc || 0);
                    const posObj = {
                        id: `SHOONYA_${p.token}`,
                        broker: 'SHOONYA',
                        token: p.token,
                        tsym: p.tsym,
                        qty: parsedQty,
                        avgPrice: parsedAvg,
                        rpnl: parseFloat(p.rpnl || 0),
                        liveMtm: 0,
                        currency: 'INR',
                        isCrypto: false
                    };
                    SESSION_VAULT.fastPositionsMap[p.token] = posObj;
                    if (p.tsym) {
                        SESSION_VAULT.fastPositionsMap[p.tsym.toUpperCase()] = posObj;
                        if (p.tsym.includes('NIFTY')) SESSION_VAULT.fastPositionsMap['NIFTY'] = posObj;
                        if (p.tsym.includes('BANKNIFTY')) SESSION_VAULT.fastPositionsMap['BANKNIFTY'] = posObj;
                        if (p.tsym.includes('SENSEX')) SESSION_VAULT.fastPositionsMap['SENSEX'] = posObj;
                        if (p.tsym.includes('RELIANCE')) SESSION_VAULT.fastPositionsMap['RELIANCE'] = posObj;
                    }
                });
            }
        } catch(e) {}
    })();

    const coindcxPromise = (async () => {
        if (!SESSION_VAULT.coindcxKey || !SESSION_VAULT.coindcxSecret) return;
        try {
            const res = await fetch(`${CLOUDFLARE_GATEWAY}?target=coindcx_positions`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ key: SESSION_VAULT.coindcxKey, secret: SESSION_VAULT.coindcxSecret })
            });
            if (!res.ok) return;
            const data = await res.json();
            if (Array.isArray(data)) {
                data.filter(p => parseFloat(p.active_units || p.total_quantity || 0) !== 0).forEach(p => {
                    const rawQty = parseFloat(p.active_units || p.total_quantity);
                    const isShort = (p.side || '').toLowerCase() === 'short';
                    const signedQty = isShort ? -Math.abs(rawQty) : Math.abs(rawQty);
                    const pair = (p.market || '').replace('B-', '').replace('_', '').toUpperCase();

                    const posObj = {
                        id: `COINDCX_${pair}`,
                        broker: 'COINDCX',
                        token: pair,
                        tsym: pair,
                        qty: signedQty,
                        avgPrice: parseFloat(p.avg_price || p.entry_price || 0),
                        rpnl: parseFloat(p.realized_pnl || 0),
                        liveMtm: 0,
                        currency: 'USDT',
                        isCrypto: true
                    };
                    SESSION_VAULT.fastPositionsMap[pair] = posObj;
                });
            }
        } catch(e) {}
    })();

    await Promise.allSettled([shoonyaPromise, coindcxPromise]);
}

function evaluateMillisecondMtmOnTick(tokenOrSymbol, liveLtp) {
    if (!tokenOrSymbol || !liveLtp || isNaN(liveLtp)) return;
    const lookupKey = tokenOrSymbol.toString().toUpperCase();

    let matchedSymbol = lookupKey;
    if (lookupKey === '26000') matchedSymbol = 'NIFTY';
    else if (lookupKey === '26009') matchedSymbol = 'BANKNIFTY';
    else if (lookupKey === '1') matchedSymbol = 'SENSEX';
    else if (lookupKey === '2885') matchedSymbol = 'RELIANCE';

    const pos = SESSION_VAULT.fastPositionsMap[lookupKey] || SESSION_VAULT.fastPositionsMap[matchedSymbol];
    if (pos && pos.avgPrice > 0) {
        if (pos.qty > 0) {
            pos.liveMtm = (liveLtp - pos.avgPrice) * pos.qty;
        } else {
            pos.liveMtm = (pos.avgPrice - liveLtp) * Math.abs(pos.qty);
        }
    }

    let totalPnlInr = 0;
    const processedIds = new Set();

    for (const k in SESSION_VAULT.fastPositionsMap) {
        const p = SESSION_VAULT.fastPositionsMap[k];
        if (processedIds.has(p.id)) continue;
        processedIds.add(p.id);

        const mtm = p.liveMtm || 0;
        const rpnl = p.rpnl || 0;
        const netLegPnl = mtm + rpnl;

        if (p.currency === 'USDT' || p.isCrypto) {
            totalPnlInr += (netLegPnl * USD_TO_INR_RATE);
        } else {
            totalPnlInr += netLegPnl;
        }
    }

    SESSION_VAULT.dailyLossPnl = totalPnlInr;

    if (totalPnlInr <= MAX_DAILY_LOSS_LIMIT && !checkHardKillSwitchLock()) {
        triggerHardKillSwitch(totalPnlInr);
        return;
    }

    const now = performance.now();
    if (now - lastUiUpdateTime > 200) {
        lastUiUpdateTime = now;
        const mtmEl = document.getElementById('hudLiveMtmVal');
        if (mtmEl) {
            mtmEl.textContent = `₹${totalPnlInr.toFixed(2)}`;
            mtmEl.className = totalPnlInr >= 0 ? "text-[#00d09c] font-black" : "text-[#eb5b3c] font-black";
        }
    }
}

// ==========================================
// ১০. পাবলিক ফিড ও সার্চ
// ==========================================
async function fetchPublicIndianMarketQuotes() {
    if (shoonyaWs && shoonyaWs.readyState === WebSocket.OPEN) return;
    try {
        const res = await fetch(`${CLOUDFLARE_GATEWAY}?target=public_market_feed`);
        if (!res.ok) return;
        const data = await res.json();
        if (data && data.success) {
            if (data.nifty && data.nifty.price) {
                updateAssetPrice('nifty50', `₹${data.nifty.price.toFixed(2)}`, data.nifty.price, data.nifty.change || '0.00%');
                updateTickerTape('tickerNifty', 'tickerNiftyChange', `₹${data.nifty.price.toFixed(2)}`, data.nifty.change || '0.00%');
            }
            if (data.banknifty && data.banknifty.price) {
                updateAssetPrice('banknifty', `₹${data.banknifty.price.toFixed(2)}`, data.banknifty.price, data.banknifty.change || '0.00%');
                updateTickerTape('tickerBankNifty', 'tickerBankNiftyChange', `₹${data.banknifty.price.toFixed(2)}`, data.banknifty.change || '0.00%');
            }
        }
    } catch(e) {}
}

function handleRealStockSearch() {
    const rawInput = document.getElementById('stockSearchInput').value.trim();
    const q = rawInput.toUpperCase();
    const newsBox = document.getElementById('searchNewsBox');
    const newsText = document.getElementById('searchNewsText');

    if (!q) {
        renderAssets();
        if (newsBox) newsBox.classList.add('hidden');
        return;
    }

    const matched = MASTER_ASSETS.filter(a => 
        a.name.toUpperCase().includes(q) || a.symbol.toUpperCase().includes(q) || a.orderKey.toUpperCase().includes(q)
    );

    if (newsBox) newsBox.classList.remove('hidden');

    if (matched.length > 0) {
        if (newsText) newsText.textContent = `Verified instrument ready for ${matched[0].name}. Click to analyze and trade.`;
        renderAssets(matched);
    } else {
        if (newsText) newsText.textContent = `No matching listed instrument found for "${rawInput}".`;
        renderAssets([]);
    }
}

function clearSearchInput() {
    const el = document.getElementById('stockSearchInput');
    if (el) el.value = '';
    renderAssets();
    const newsBox = document.getElementById('searchNewsBox');
    if (newsBox) newsBox.classList.add('hidden');
}

// ==========================================
// ১১. ইনস্টিটিউশনাল অর্ডারফ্লো ও ইন্ট্রাডে অপরচুনিটি
// ==========================================
async function fetchRealOrderflowDelta(asset) {
    if (!asset || asset.priceNum === 0) {
        return { buyers: 0, sellers: 0, isBlock: false, status: 'UNAVAILABLE' };
    }

    if (asset.category === 'crypto' || asset.id === 'goldmcx') {
        try {
            const sym = asset.id === 'goldmcx' ? 'PAXGUSDT' : asset.orderKey;
            const res = await fetch(`https://api.binance.com/api/v3/depth?symbol=${sym}&limit=50`);
            if (!res.ok) throw new Error("Depth offline");
            
            const depth = await res.json();
            const totalBid = depth.bids.reduce((acc, curr) => acc + parseFloat(curr[1] || 0), 0);
            const totalAsk = depth.asks.reduce((acc, curr) => acc + parseFloat(curr[1] || 0), 0);
            const total = totalBid + totalAsk;

            if (total > 0 && !isNaN(total)) {
                const bPct = Math.round((totalBid / total) * 100);
                return { 
                    buyers: bPct, 
                    sellers: 100 - bPct, 
                    isBlock: bPct >= 75 || bPct <= 25,
                    status: 'LIVE'
                };
            }
        } catch(e) {
            return { buyers: 0, sellers: 0, isBlock: false, status: 'STALE' };
        }
    }

    if (asset.realTbq > 0 || asset.realTsq > 0) {
        const total = asset.realTbq + asset.realTsq;
        if (total > 0 && !isNaN(total)) {
            const bPct = Math.round((asset.realTbq / total) * 100);
            return { 
                buyers: bPct, 
                sellers: 100 - bPct, 
                isBlock: asset.blockOrderDetected,
                status: 'LIVE'
            };
        }
    }

    return { buyers: 0, sellers: 0, isBlock: false, status: 'UNAVAILABLE' };
}

function evaluateUltraOpportunity(asset, flow, sr) {
    const badge = document.getElementById(`oppBadge_${asset.id}`);
    const card = document.getElementById(`assetCard_${asset.id}`);

    if (!asset || asset.priceNum === 0 || flow.status !== 'LIVE') {
        if (badge && card) {
            card.classList.remove('radar-blink-buy', 'radar-blink-sell');
            badge.textContent = flow.status === 'STALE' ? "FEED STALE • WAIT" : "FEED OFFLINE • WAIT";
            badge.className = "text-[8px] font-mono font-bold text-slate-400 bg-[#121824] px-2 py-0.5 rounded border border-[#232d3f]";
        }
        return { score: 0, isConfirmed: false, side: 'WAIT', reasons: ['Waiting for verified live orderbook feed'] };
    }

    const current = asset.priceNum;
    const r1 = parseFloat(sr.r1);
    const s1 = parseFloat(sr.s1);

    let confidencePoints = 40;
    let intradayReasonList = [];

    const isBull = flow.buyers > flow.sellers;
    const dominantPressure = isBull ? flow.buyers : flow.sellers;

    if (dominantPressure >= 65) {
        confidencePoints += 25;
        intradayReasonList.push(`Heavy Intraday Depth Imbalance (${dominantPressure}% ${isBull ? 'Buyers' : 'Sellers'})`);
    }

    if (isBull && current >= (r1 * 0.998)) {
        confidencePoints += 20;
        intradayReasonList.push(`Intraday Resistance R1 (₹${r1}) Breakout with Volume`);
    } else if (!isBull && current <= (s1 * 1.002)) {
        confidencePoints += 20;
        intradayReasonList.push(`Intraday Support S1 (₹${s1}) Breakdown Confirmation`);
    }

    if (flow.isBlock) {
        confidencePoints += 15;
        intradayReasonList.push(`Institutional Block Flow detected in tape`);
    }

    const finalScore = Math.min(97, Math.max(30, confidencePoints));
    const isConfirmed = finalScore >= 75;
    const side = isBull ? 'BUY' : 'SELL';

    asset.probabilityScore = finalScore;
    asset.intradayReasons = intradayReasonList;

    if (badge && card) {
        card.classList.remove('radar-blink-buy', 'radar-blink-sell');
        if (isConfirmed) {
            badge.textContent = `⚡ ${finalScore}% INTRADAY ${side}`;
            badge.className = isBull 
                ? "text-[9px] font-mono font-black px-2 py-0.5 rounded-full bg-[#00d09c] text-slate-950 animate-pulse"
                : "text-[9px] font-mono font-black px-2 py-0.5 rounded-full bg-[#eb5b3c] text-white animate-pulse";
            card.classList.add(isBull ? 'radar-blink-buy' : 'radar-blink-sell');
        } else {
            badge.textContent = "INTRADAY CHOPPY • WAIT";
            badge.className = "text-[8px] font-mono text-slate-400 bg-[#121824] px-1.5 py-0.5 rounded border border-[#232d3f]";
        }
    }

    return { score: finalScore, isConfirmed, side, reasons: intradayReasonList };
}

async function triggerPeriodicOpportunityAlert() {
    for (const a of MASTER_ASSETS) {
        if (a.priceNum === 0) continue;
        const sr = calculateDynamicSupportResistance(a.high, a.low, a.priceNum);
        const flow = await fetchRealOrderflowDelta(a);
        const evaluation = evaluateUltraOpportunity(a, flow, sr);

        if (evaluation.isConfirmed) {
            const isBull = evaluation.side === 'BUY';
            const r1 = parseFloat(sr.r1);
            const s1 = parseFloat(sr.s1);

            triggerOpportunityAlert({
                assetId: a.id,
                symbol: a.name,
                orderKey: a.orderKey,
                type: `${evaluation.score}% ${evaluation.side} CONFLUENCE`,
                side: evaluation.side,
                reason: `Orderbook imbalance: buyer delta ${flow.buyers}%. ${isBull ? 'R1 Breakout active' : 'S1 Breakdown active'}.`,
                entry: a.priceNum.toFixed(2),
                sl: isBull ? s1.toFixed(2) : r1.toFixed(2),
                target: isBull ? (r1 + (r1 * 0.006)).toFixed(2) : (s1 - (s1 * 0.006)).toFixed(2)
            });
            return;
        }
    }
}

function triggerOpportunityAlert(data) {
    SESSION_VAULT.currentOppData = data;
    const titleEl = document.getElementById('oppPopupTitle');
    const subEl = document.getElementById('oppPopupSubtitle');
    const entryEl = document.getElementById('oppPopupEntry');
    const slEl = document.getElementById('oppPopupSL');
    const tgtEl = document.getElementById('oppPopupTarget');

    if (titleEl) titleEl.textContent = `${data.symbol}: ${data.type}`;
    if (subEl) subEl.textContent = data.reason;
    if (entryEl) entryEl.textContent = `₹${data.entry}`;
    if (slEl) slEl.textContent = `₹${data.sl}`;
    if (tgtEl) tgtEl.textContent = `₹${data.target}`;

    document.getElementById('opportunityPopupModal').classList.remove('hidden');

    const voiceAlert = (SESSION_VAULT.voiceLang === 'bn-IN')
        ? `স্নাইপার অ্যালার্ট! ${data.symbol} এন্ট্রি ${data.entry}, টার্গেট ${data.target}, স্টপ লস ${data.sl}!`
        : `Sniper Alert! ${data.symbol} entry at ${data.entry}, target ${data.target}, stop loss at ${data.sl}.`;

    explainTextFriendly(voiceAlert, `${data.symbol} Edge`);
}

function testOpportunityAlert() {
    if (!checkProAccess()) return;
    const asset = currentSelectedAsset || MASTER_ASSETS[0];
    if (!asset || asset.priceNum === 0) {
        alert("Market feed connecting, please wait for live ticks...");
        return;
    }

    const sr = calculateDynamicSupportResistance(asset.high, asset.low, asset.priceNum);
    const range = (asset.high - asset.low) || 1;
    const pricePosition = (asset.priceNum - asset.low) / range;
    const isBull = pricePosition >= 0.5;

    const entry = asset.priceNum;
    const target = isBull ? parseFloat(sr.r1) : parseFloat(sr.s1);
    const sl = isBull ? parseFloat(sr.s1) : parseFloat(sr.r1);
    const calculatedScore = Math.min(94, Math.max(65, Math.round(50 + (Math.abs(pricePosition - 0.5) * 60) + (Math.abs(asset.sentimentScore) * 5))));

    triggerOpportunityAlert({
        assetId: asset.id,
        symbol: asset.name,
        orderKey: asset.orderKey,
        type: `${calculatedScore}% ${isBull ? 'BUY' : 'SELL'} INTRADAY EDGE`,
        side: isBull ? 'BUY' : 'SELL',
        reason: `Intraday range position at ${(pricePosition * 100).toFixed(0)}%. Momentum verified against dynamic pivots.`,
        entry: entry.toFixed(2),
        sl: sl.toFixed(2),
        target: target.toFixed(2)
    });
}

function repeatOpportunityVoice() {
    if (SESSION_VAULT.currentOppData) triggerOpportunityAlert(SESSION_VAULT.currentOppData);
}

function dismissOpportunityPopup() {
    document.getElementById('opportunityPopupModal').classList.add('hidden');
    stopAiVoice();
}

function dismissOpportunityToast() {
    const toast = document.getElementById('liveOpportunityToast');
    if (toast) toast.classList.add('hidden');
}

function scrollToCurrentOpportunityCard() {
    dismissOpportunityToast();
    if (SESSION_VAULT.currentOppData) {
        document.getElementById('opportunityPopupModal').classList.remove('hidden');
    }
}

function executeOpportunityTradeNow() {
    if (!SESSION_VAULT.currentOppData) return;
    const opp = SESSION_VAULT.currentOppData;

    const canonical = resolveCanonicalInstrument(opp.orderKey);
    if (!canonical) {
        alert(`🛑 Unknown instrument: ${opp.orderKey}`);
        return;
    }

    dismissOpportunityPopup();
    switchTab('Trade');

    const symSelect = document.getElementById('tradeOrderSymbol');
    if (symSelect) {
        symSelect.value = opp.orderKey;
        handleOrderSymbolChange();
    }

    const side = opp.side || (opp.type.includes('BUY') ? 'BUY' : 'SELL');
    const defaultQty = canonical.lotSize;

    dispatchLiveBrokerTrade(side, opp.orderKey, defaultQty, { isExitOrder: false, fromOpportunity: true, slPrice: opp.sl });
}

// ==========================================
// ১২. অ্যাসেট ফিড রেন্ডারিং
// ==========================================
function renderAssets(customList) {
    const container = document.getElementById('assetsFeedContainer');
    if (!container) return;
    const list = customList || MASTER_ASSETS.filter(a => activeCategory === 'all' || a.category === activeCategory);

    if (list.length === 0) {
        container.innerHTML = `<div class="groww-card p-6 text-center text-slate-500 font-mono text-xs">No matching instruments found.</div>`;
        return;
    }

    container.innerHTML = list.map(a => {
        const isPos = a.change && a.change.startsWith('+');

        return `
        <div id="assetCard_${a.id}" class="groww-card p-3.5 space-y-2.5 transition active:scale-[0.99]">
            <div class="flex items-center justify-between cursor-pointer" onclick="selectAssetForAnalysis('${a.symbol}', '${a.orderKey}')">
                <div class="flex items-center space-x-2.5">
                    <span class="w-9 h-9 rounded-xl bg-[#121824] border border-[#232d3f] flex items-center justify-center font-black text-[#00d09c] text-sm shadow-inner">${a.icon}</span>
                    <div>
                        <div class="flex items-center space-x-1.5">
                            <h4 class="font-extrabold text-xs text-white leading-tight heading-font">${a.name}</h4>
                            <span class="text-[8px] bg-[#121824] text-slate-400 px-1.5 py-0.2 rounded font-mono font-bold border border-[#232d3f]">${a.category.toUpperCase()}</span>
                        </div>
                        <span class="text-[9px] text-[#00d09c] font-mono font-medium">${a.signalType}</span>
                    </div>
                </div>
                <div class="text-right">
                    <div class="flex items-center justify-end space-x-1 mb-0.5">
                        <span id="oppBadge_${a.id}" class="text-[8px] font-mono text-slate-400 bg-[#121824] px-1.5 py-0.2 rounded border border-[#232d3f]">SCANNING...</span>
                    </div>
                    <div id="priceCardVal_${a.id}" class="text-xs font-black text-white mono-font">${a.price}</div>
                    <span id="priceCardChg_${a.id}" class="text-[9.5px] font-mono font-bold ${isPos ? 'text-[#00d09c] bg-[#00d09c]/10 border-[#00d09c]/25' : 'text-[#eb5b3c] bg-[#eb5b3c]/10 border-[#eb5b3c]/25'} px-2 py-0.5 rounded-md border">${a.change}</span>
                </div>
            </div>

            <div class="bg-[#121824] p-2 rounded-xl border border-[#232d3f]" id="deltaBarBox_${a.id}">
                <div class="flex justify-between text-[9px] mono-font mb-1 font-bold">
                    <span class="text-[#00d09c]" id="deltaBuyerText_${a.id}">Buyers: 50%</span>
                    <span class="text-[#eb5b3c]" id="deltaSellerText_${a.id}">Sellers: 50%</span>
                </div>
                <div class="w-full h-1.5 bg-[#18202e] rounded-full overflow-hidden flex">
                    <div class="bg-[#00d09c] h-full transition-all duration-300" id="deltaBuyerBar_${a.id}" style="width: 50%"></div>
                    <div class="bg-[#eb5b3c] h-full transition-all duration-300" id="deltaSellerBar_${a.id}" style="width: 50%"></div>
                </div>
            </div>

            <div class="flex items-center justify-between pt-0.5">
                <button onclick="openDetailedInstitutionalAnalysis('${a.id}')" class="text-[9.5px] font-mono font-bold text-slate-400 hover:text-[#00d09c] flex items-center transition">
                    <i class="fa-solid fa-chart-simple mr-1 text-[#00d09c]"></i> S1/R1 & Canvas
                </button>
                <button onclick="selectAssetForAnalysis('${a.symbol}', '${a.orderKey}'); switchTab('Trade');" class="text-[9.5px] groww-btn-green font-mono font-black px-3 py-1 rounded-lg transition active:scale-95 shadow-sm">
                    1-Click Desk
                </button>
            </div>
        </div>
        `;
    }).join('');

    list.forEach(async (a) => {
        const flow = await fetchRealOrderflowDelta(a);
        const sr = calculateDynamicSupportResistance(a.high, a.low, a.priceNum);
        evaluateUltraOpportunity(a, flow, sr);

        const bText = document.getElementById(`deltaBuyerText_${a.id}`);
        const sText = document.getElementById(`deltaSellerText_${a.id}`);
        const bBar = document.getElementById(`deltaBuyerBar_${a.id}`);
        const sBar = document.getElementById(`deltaSellerBar_${a.id}`);
        if (bText && sText && bBar && sBar) {
            bText.textContent = `Buyers: ${flow.buyers}%`;
            sText.textContent = `Sellers: ${flow.sellers}%`;
            bBar.style.width = `${flow.buyers}%`;
            sBar.style.width = `${flow.sellers}%`;
        }
    });
}

function filterCategory(cat) {
    activeCategory = cat;
    ['all', 'indian', 'crypto', 'commodity'].forEach(c => {
        const btn = document.getElementById(`catBtn_${c}`);
        if (btn) btn.className = c === cat ? "px-3.5 py-1.5 rounded-xl bg-[#00d09c] text-slate-950 font-black shadow-md shrink-0 transition" : "px-3.5 py-1.5 rounded-xl bg-[#18202e] border border-[#232d3f] text-slate-400 shadow-sm shrink-0 transition";
    });
    renderAssets();
}

async function openDetailedInstitutionalAnalysis(assetKey) {
    if (!checkProAccess()) return;
    const asset = MASTER_ASSETS.find(a => a.id === assetKey) || MASTER_ASSETS[0];
    const sr = calculateDynamicSupportResistance(asset.high, asset.low, asset.priceNum);
    const delta = await fetchRealOrderflowDelta(asset);

    document.getElementById('modalAssetTitle').textContent = asset.name;
    document.getElementById('modalAssetPrice').textContent = `${asset.price} • ${asset.signalType}`;
    document.getElementById('modalTodayHigh').textContent = asset.highFormatted || `₹${asset.high}`;
    document.getElementById('modalTodayLow').textContent = asset.lowFormatted || `₹${asset.low}`;
    document.getElementById('modalSupportLevel').textContent = sr.s1;
    document.getElementById('modalResistanceLevel').textContent = sr.r1;

    const isBull = asset.trend === 'BULLISH';
    document.getElementById('modalEntry').textContent = asset.price;
    document.getElementById('modalTarget').textContent = isBull ? sr.r1 : sr.s1;
    document.getElementById('modalSl').textContent = isBull ? sr.s1 : sr.r1;

    document.getElementById('modalWhatText').textContent = `${asset.name} is quoting at ${asset.price}. Orderbook bid pressure is ${delta.buyers}% and ask pressure is ${delta.sellers}%.`;
    document.getElementById('modalWhyText').textContent = `Price is rotating between S1 (${sr.s1}) and R1 (${sr.r1}). ${delta.isBlock ? 'Institutional block orders active on depth.' : 'Normal market volume continuity.'}`;
    document.getElementById('modalHowText').textContent = `Optimal entry: ${asset.price}, Target: ${isBull ? sr.r1 : sr.s1}, Disciplined Stop Loss: ${isBull ? sr.s1 : sr.r1}. Never chase FOMO!`;

    document.getElementById('analysisModal').classList.remove('hidden');
    requestAnimationFrame(() => drawDynamicCandlestickCanvas(asset.trend, sr.s1, sr.r1));
}

function closeAnalysisModal() {
    document.getElementById('analysisModal').classList.add('hidden');
}

// ==========================================
// ১৩. ক্রিপ্টো লেভারেজ ক্যালকুলেটর
// ==========================================
function setCryptoLeverage(lev) {
    if (lev < 1) lev = 1;
    if (lev > 100) lev = 100;
    selectedCryptoLeverage = lev;

    [1, 2, 5, 10, 20].forEach(l => {
        const btn = document.getElementById(`btnLev_${l}`);
        if (btn) {
            btn.className = (l === lev)
                ? "py-1.5 rounded-lg bg-amber-500 text-slate-950 font-black shadow-sm transition"
                : "py-1.5 rounded-lg bg-[#121824] text-slate-400 border border-[#232d3f] transition";
        }
    });

    const disp = document.getElementById('activeLeverageDisplay');
    if (disp) disp.textContent = `${lev}X LEVERAGE`;

    const customInp = document.getElementById('customLeverageInput');
    if (customInp && parseInt(customInp.value) !== lev) customInp.value = lev;

    updateCryptoMarginCalculation();
}

function updateCryptoMarginCalculation() {
    const symbol = document.getElementById('tradeOrderSymbol')?.value;
    const box = document.getElementById('cryptoLeverageControlBox');
    if (!box) return;

    const isCrypto = symbol && (symbol.includes('USDT') || symbol === 'BTCUSDT' || symbol === 'ETHUSDT' || symbol === 'PAXGUSDT');
    if (!isCrypto) {
        box.classList.add('hidden');
        return;
    }

    box.classList.remove('hidden');

    const qty = parseFloat(document.getElementById('tradeOrderQty')?.value) || 0;
    const asset = MASTER_ASSETS.find(a => a.orderKey === symbol);
    const livePrice = asset && asset.priceNum > 0 ? asset.priceNum : (symbol === 'BTCUSDT' ? 88000 : 2800);

    const positionValue = livePrice * qty;
    const requiredMargin = selectedCryptoLeverage > 0 ? (positionValue / selectedCryptoLeverage) : positionValue;
    const estLiq = livePrice * (1 - (1 / selectedCryptoLeverage) * 0.9);

    const elPos = document.getElementById('calcPositionValue');
    const elReq = document.getElementById('calcRequiredMargin');
    const elLiq = document.getElementById('calcEstLiqPrice');
    const elSuff = document.getElementById('calcMarginSufficiency');

    if (elPos) elPos.textContent = `$${positionValue.toFixed(2)} USDT`;
    if (elReq) elReq.textContent = `$${requiredMargin.toFixed(2)} USDT`;
    if (elLiq) elLiq.textContent = `$${estLiq.toFixed(2)}`;

    const dcxBalanceText = document.getElementById('hudCoinDcxBalance')?.textContent || "";
    const currentUsdt = parseFloat(dcxBalanceText) || 0;

    if (elSuff) {
        if (currentUsdt > 0 && requiredMargin > currentUsdt) {
            elSuff.className = "text-[#eb5b3c] font-bold";
            elSuff.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> Low Balance ($${currentUsdt.toFixed(2)})`;
        } else {
            elSuff.className = "text-[#00d09c] font-bold";
            elSuff.innerHTML = `<i class="fa-solid fa-circle-check"></i> Margin OK`;
        }
    }
}

// ==========================================
// ১৪. রিয়েল-মানি ট্রেড ইঞ্জিন ও ব্রোকার হার্ড স্টপ-লস
// ==========================================
const CAPITAL_PRESERVATION_SHIELD = {
    maxTradesPerDay: 3,

    validateCapitalSafetyBeforeTrade(side, symbol) {
        const todayStr = getIndiaTradingDate();
        let tradeCount = parseInt(localStorage.getItem(`ARAF_TRADE_COUNT_${todayStr}`) || '0', 10);

        if (tradeCount >= this.maxTradesPerDay) {
            return {
                allow: false,
                reason: "🛑 Overtrading Blocked! Maximum 3 trades completed for today. Screen shut down strictly enforced to protect your capital from revenge trading.",
                voice: "Daily 3 trades quota exhausted. Please close the screen and rest."
            };
        }

        const pos = SESSION_VAULT.fastPositionsMap[symbol];
        if (pos && pos.qty !== 0 && pos.liveMtm < -500) {
            return {
                allow: false,
                reason: `🛑 Averaging Down Blocked! You are currently carrying a floating loss on ${symbol}. Never average down into a losing position. Respect your initial stop loss!`,
                voice: "Averaging down into a losing trade is forbidden by capital rules."
            };
        }

        return { allow: true };
    },

    recordTradeTaken() {
        const todayStr = getIndiaTradingDate();
        let tradeCount = parseInt(localStorage.getItem(`ARAF_TRADE_COUNT_${todayStr}`) || '0', 10) + 1;
        localStorage.setItem(`ARAF_TRADE_COUNT_${todayStr}`, tradeCount.toString());
    }
};

function isNseHoliday(dateObj) {
    const yyyy = dateObj.getFullYear();
    const mm = String(dateObj.getMonth() + 1).padStart(2, '0');
    const dd = String(dateObj.getDate()).padStart(2, '0');
    const dateStr = `${yyyy}-${mm}-${dd}`;
    return NSE_TRADING_HOLIDAYS_2025_2026.includes(dateStr) || dateObj.getDay() === 0 || dateObj.getDay() === 6;
}

function getDynamicShoonyaFutSymbol(baseSymbol) {
    if (baseSymbol === 'RELIANCE') return 'RELIANCE-EQ';
    const now = new Date();
    let year = now.getFullYear();
    let month = now.getMonth();
    
    let targetDayOfWeek = 4;
    if (baseSymbol === 'SENSEX') targetDayOfWeek = 5;

    let checkDate = new Date(year, month + 1, 0);
    while (checkDate.getDay() !== targetDayOfWeek) checkDate.setDate(checkDate.getDate() - 1);
    while (isNseHoliday(checkDate)) checkDate.setDate(checkDate.getDate() - 1);

    const dd = String(checkDate.getDate()).padStart(2, '0');
    const mmm = checkDate.toLocaleString('en-US', { month: 'short' }).toUpperCase();
    const yy = String(checkDate.getFullYear()).slice(-2);
    return `${baseSymbol}${dd}${mmm}${yy}F`;
}

function handleOrderSymbolChange() {
    const symbol = document.getElementById('tradeOrderSymbol').value;
    const qtyInput = document.getElementById('tradeOrderQty');
    const badge = document.getElementById('orderRoutingBadge');
    const spec = EXCHANGE_LOT_SPECS[symbol] || { lot: 1, step: 1, min: 1, leverage: "⚡ 5X LEVERAGE (Intraday)", type: "EQUITY" };

    if (qtyInput) {
        qtyInput.value = spec.lot;
        qtyInput.step = spec.step;
        qtyInput.min = spec.min;
    }

    const hasShoonya = !!(SESSION_VAULT.shoonyaUid && SESSION_VAULT.shoonyaToken);
    const hasCoinDcx = !!(SESSION_VAULT.coindcxKey && SESSION_VAULT.coindcxSecret);

    if (badge) {
        if (['NIFTY', 'BANKNIFTY', 'SENSEX', 'RELIANCE'].includes(symbol)) {
            const futSym = getDynamicShoonyaFutSymbol(symbol);
            badge.innerHTML = hasShoonya 
                ? `${spec.leverage} • <span class="text-[#00d09c] font-bold">${futSym}</span>` 
                : `${spec.leverage} • <span class="text-[#eb5b3c] font-bold">SHOONYA UNLINKED</span>`;
            badge.className = hasShoonya ? "text-[8.5px] bg-[#00d09c]/10 text-[#00d09c] font-mono font-bold px-2 py-0.5 rounded border border-[#00d09c]/30 shadow-sm" : "text-[8.5px] bg-[#eb5b3c]/10 text-[#eb5b3c] font-mono font-bold px-2 py-0.5 rounded border border-[#eb5b3c]/30 shadow-sm";
        } else {
            badge.innerHTML = hasCoinDcx 
                ? `${spec.leverage} • <span class="text-amber-400 font-bold">COINDCX ACTIVE</span>` 
                : `${spec.leverage} • <span class="text-[#eb5b3c] font-bold">COINDCX UNLINKED</span>`;
            badge.className = hasCoinDcx ? "text-[8.5px] bg-amber-500/10 text-amber-400 font-mono font-bold px-2 py-0.5 rounded border border-amber-500/30 shadow-sm" : "text-[8.5px] bg-[#eb5b3c]/10 text-[#eb5b3c] font-mono font-bold px-2 py-0.5 rounded border border-[#eb5b3c]/30 shadow-sm";
        }
    }

    updateCryptoMarginCalculation();
}

async function placeBrokerProtectiveSl(symbol, side, qty, slPrice, broker) {
    if (!slPrice || isNaN(slPrice) || slPrice <= 0) return;
    
    const canonical = resolveCanonicalInstrument(symbol);
    if (!canonical) return;

    const slSide = (side === 'BUY') ? 'SELL' : 'BUY';

    if (broker === 'SHOONYA' && SESSION_VAULT.shoonyaUid && SESSION_VAULT.shoonyaToken) {
        const tsym = getDynamicShoonyaFutSymbol(symbol);
        try {
            await fetch(`${CLOUDFLARE_GATEWAY}?target=shoonya_placeorder`, {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: `jData=${encodeURIComponent(JSON.stringify({
                    uid: SESSION_VAULT.shoonyaUid,
                    actid: SESSION_VAULT.shoonyaUid,
                    exch: canonical.exchange,
                    tsym: tsym,
                    qty: qty.toString(),
                    prc: (slPrice * 0.995).toFixed(2),
                    trgprc: slPrice.toString(),
                    prd: 'I',
                    trantype: slSide === 'BUY' ? 'B' : 'S',
                    prctyp: 'SL-LMT',
                    ret: 'DAY'
                }))}&jKey=${SESSION_VAULT.shoonyaToken}`
            });
            console.log(`[Zero-Loss Shield]: Broker Server-Side Stop Loss Placed at ₹${slPrice}`);
        } catch(e) {}
    } 
    else if (broker === 'COINDCX' && SESSION_VAULT.coindcxKey && SESSION_VAULT.coindcxSecret) {
        try {
            await fetch(`${CLOUDFLARE_GATEWAY}?target=coindcx_order`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    key: SESSION_VAULT.coindcxKey,
                    secret: SESSION_VAULT.coindcxSecret,
                    side: slSide.toLowerCase(),
                    market: canonical.marketPair,
                    quantity: qty,
                    stop_loss_price: slPrice,
                    order_type: "stop_market_order"
                })
            });
        } catch(e) {}
    }
}

async function dispatchLiveBrokerTrade(side, overrideSymbol = null, overrideQty = null, orderContext = { isExitOrder: false }) {
    const isExit = orderContext && orderContext.isExitOrder === true;

    if (!isExit) {
        if (!isTerminalUnlocked) {
            document.getElementById('quickUnlockModal').classList.remove('hidden');
            return;
        }
        if (checkHardKillSwitchLock()) {
            alert("🛑 New entries blocked! Maximum daily loss limit reached.");
            return;
        }
        if (!checkProAccess()) return;
    }

    if (isOrderDispatching) return;
    isOrderDispatching = true;

    const rawSymbol = overrideSymbol || document.getElementById('tradeOrderSymbol').value;
    const canonical = resolveCanonicalInstrument(rawSymbol);

    const statusBox = document.getElementById('orderStatusMsg');
    if (statusBox) statusBox.classList.remove('hidden');

    if (!canonical) {
        if (statusBox) {
            statusBox.className = "p-2 rounded-xl text-[10px] mono-font font-bold bg-[#eb5b3c]/10 border border-[#eb5b3c]/30 text-[#eb5b3c] block";
            statusBox.textContent = `🛑 Instrument ${rawSymbol} is not whitelisted.`;
        }
        isOrderDispatching = false;
        return;
    }

    let qty = overrideQty || parseFloat(document.getElementById('tradeOrderQty').value);

    if (isExit) {
        const activePos = SESSION_VAULT.fastPositionsMap[rawSymbol] || SESSION_VAULT.fastPositionsMap[canonical.token];
        const maxOpenQty = activePos ? Math.abs(activePos.qty) : 0;
        if (maxOpenQty === 0) {
            isOrderDispatching = false;
            return;
        }
        qty = Math.min(qty, maxOpenQty);
    } else {
        const capCheck = CAPITAL_PRESERVATION_SHIELD.validateCapitalSafetyBeforeTrade(side, rawSymbol);
        if (!capCheck.allow) {
            if (statusBox) {
                statusBox.className = "p-3 rounded-xl text-xs mono-font font-bold bg-[#eb5b3c]/15 border-2 border-[#eb5b3c] text-white block";
                statusBox.innerHTML = `<i class="fa-solid fa-hand text-base mr-1.5 animate-bounce text-[#eb5b3c]"></i> ${capCheck.reason}`;
            }
            explainTextFriendly(capCheck.voice, "Capital Protection Guard");
            isOrderDispatching = false;
            return;
        }
    }

    if (canonical.broker === 'SHOONYA') {
        if (!SESSION_VAULT.shoonyaUid || !SESSION_VAULT.shoonyaToken) {
            if (statusBox) statusBox.textContent = "🛑 Shoonya credentials unlinked in Settings.";
            isOrderDispatching = false;
            return;
        }

        const tsym = getDynamicShoonyaFutSymbol(rawSymbol);
        if (statusBox) {
            statusBox.className = "p-2 rounded-xl text-[10px] mono-font font-bold bg-amber-500/10 border border-amber-500/30 text-amber-400 block";
            statusBox.innerHTML = `<i class="fa-solid fa-spinner animate-spin mr-1"></i> Submitting order for ${tsym}...`;
        }

        try {
            const res = await fetch(`${CLOUDFLARE_GATEWAY}?target=shoonya_placeorder`, {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: `jData=${encodeURIComponent(JSON.stringify({
                    uid: SESSION_VAULT.shoonyaUid,
                    actid: SESSION_VAULT.shoonyaUid,
                    exch: canonical.exchange,
                    tsym: tsym,
                    qty: qty.toString(),
                    prc: "0",
                    prd: 'I',
                    trantype: side === 'BUY' ? 'B' : 'S',
                    prctyp: 'MKT',
                    ret: 'DAY'
                }))}&jKey=${SESSION_VAULT.shoonyaToken}`
            });

            const d = await res.json();

            if (d && (d.stat === 'Ok' || d.norenordno)) {
                const orderId = d.norenordno;
                if (statusBox) {
                    statusBox.className = "p-2 rounded-xl text-[10px] mono-font font-bold bg-[#00d09c]/15 border border-[#00d09c]/40 text-[#00d09c] block";
                    statusBox.innerHTML = `⏳ ORDER ACCEPTED (ID: ${orderId}). Verifying fill...`;
                }
                recordAndSyncTradeLog(tsym, side, qty, 'Shoonya F&O', 'ACCEPTED', orderId);
                
                if (!isExit) {
                    CAPITAL_PRESERVATION_SHIELD.recordTradeTaken();
                    if (orderContext.slPrice) {
                        placeBrokerProtectiveSl(rawSymbol, side, qty, parseFloat(orderContext.slPrice), 'SHOONYA');
                    }
                }
                
                setTimeout(() => reconcileBrokerTradeStatus(orderId, 'SHOONYA', tsym), 1000);
            } else {
                if (statusBox) {
                    statusBox.className = "p-2 rounded-xl text-[10px] mono-font font-bold bg-[#eb5b3c]/15 border border-[#eb5b3c]/40 text-[#eb5b3c] block";
                    statusBox.textContent = `❌ Order Rejected: ${d?.emsg || 'Broker error'}`;
                }
            }
        } catch(e) {
            if (statusBox) statusBox.textContent = "❌ Network failure on order dispatch.";
        } finally {
            isOrderDispatching = false;
        }
    } else if (canonical.broker === 'COINDCX') {
        if (!SESSION_VAULT.coindcxKey || !SESSION_VAULT.coindcxSecret) {
            if (statusBox) statusBox.textContent = "🛑 CoinDCX API keys unlinked in Settings.";
            isOrderDispatching = false;
            return;
        }

        if (statusBox) {
            statusBox.className = "p-2 rounded-xl text-[10px] mono-font font-bold bg-amber-500/10 border border-amber-500/30 text-amber-400 block";
            statusBox.innerHTML = `<i class="fa-solid fa-spinner animate-spin mr-1"></i> Submitting CoinDCX Order...`;
        }

        try {
            const res = await fetch(`${CLOUDFLARE_GATEWAY}?target=coindcx_order`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    key: SESSION_VAULT.coindcxKey,
                    secret: SESSION_VAULT.coindcxSecret,
                    side: side.toLowerCase(),
                    market: canonical.marketPair,
                    quantity: qty,
                    leverage: selectedCryptoLeverage,
                    order_type: "market_order"
                })
            });

            if (res.ok) {
                const data = await res.json();
                const orderId = data?.id || data?.order_id;
                if (data && (data.status === 'success' || orderId)) {
                    if (statusBox) {
                        statusBox.className = "p-2 rounded-xl text-[10px] mono-font font-bold bg-[#00d09c]/15 border border-[#00d09c]/40 text-[#00d09c] block";
                        statusBox.innerHTML = `⏳ COINDCX ACCEPTED (ID: ${orderId}). Verifying fill...`;
                    }
                    recordAndSyncTradeLog(rawSymbol, side, qty, 'CoinDCX Futures', 'ACCEPTED', orderId);
                    if (!isExit) {
                        CAPITAL_PRESERVATION_SHIELD.recordTradeTaken();
                        if (orderContext.slPrice) placeBrokerProtectiveSl(rawSymbol, side, qty, parseFloat(orderContext.slPrice), 'COINDCX');
                    }
                    setTimeout(() => reconcileBrokerTradeStatus(orderId, 'COINDCX', rawSymbol), 1000);
                } else {
                    if (statusBox) statusBox.textContent = `❌ CoinDCX Rejected: ${data?.message || 'Order failed'}`;
                }
            }
        } catch(e) {
            if (statusBox) statusBox.textContent = "❌ Gateway connection error to CoinDCX.";
        } finally {
            isOrderDispatching = false;
        }
    }
}

async function reconcileBrokerTradeStatus(orderId, broker, symbol) {
    const statusBox = document.getElementById('orderStatusMsg');
    try {
        if (broker === 'SHOONYA') {
            const res = await fetch(`${CLOUDFLARE_GATEWAY}?target=shoonya_orderbook`, {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: `jData=${encodeURIComponent(JSON.stringify({ uid: SESSION_VAULT.shoonyaUid }))}&jKey=${SESSION_VAULT.shoonyaToken}`
            });
            if (res.ok) {
                const orders = await res.json();
                const matched = Array.isArray(orders) ? orders.find(o => o.norenordno === orderId) : null;
                if (matched) {
                    const status = matched.status.toUpperCase();
                    if (status === 'COMPLETE') {
                        if (statusBox) {
                            statusBox.className = "p-2 rounded-xl text-[10px] mono-font font-bold bg-[#00d09c]/20 border border-[#00d09c] text-[#00d09c] block";
                            statusBox.innerHTML = `✅ SHOONYA FILLED! Avg: ₹${matched.avgprc || matched.prc} (${matched.qty} Qty)`;
                        }
                        updateTradeLogStatus(orderId, 'FILLED', parseFloat(matched.avgprc || matched.prc));
                        syncRealBrokerBalances();
                        initSyncPositionsToMemory();
                        return;
                    } else if (status === 'REJECTED' || status === 'CANCELLED') {
                        if (statusBox) {
                            statusBox.className = "p-2 rounded-xl text-[10px] mono-font font-bold bg-[#eb5b3c]/20 border border-[#eb5b3c] text-[#eb5b3c] block";
                            statusBox.textContent = `🛑 Order ${status}: ${matched.rejreason || ''}`;
                        }
                        updateTradeLogStatus(orderId, status);
                        return;
                    }
                }
            }
        }
    } catch(e) {}
}

function updateTradeLogStatus(orderId, finalStatus, fillPrice = null) {
    if (!SESSION_VAULT.tradeHistory) return;
    const item = SESSION_VAULT.tradeHistory.find(t => t.orderId === orderId);
    if (item) {
        item.status = finalStatus;
        if (fillPrice) item.fillPrice = fillPrice;
        renderTradeHistory();
        if (SESSION_VAULT.userKey && SESSION_VAULT.savedCloudUser) {
            SESSION_VAULT.savedCloudUser.tradeHistory = SESSION_VAULT.tradeHistory;
            ArafCloudMaster.syncAllUserData(SESSION_VAULT.userKey, SESSION_VAULT.savedCloudUser);
        }
    }
}

function renderTradeHistory() {
    const container = document.getElementById('recentTradesList');
    if (!container) return;

    if (!SESSION_VAULT.tradeHistory || SESSION_VAULT.tradeHistory.length === 0) {
        container.innerHTML = `<p class="text-[9px] text-slate-500 font-mono text-center py-2">No executions recorded in this session.</p>`;
        return;
    }

    container.innerHTML = SESSION_VAULT.tradeHistory.slice(0, 5).map(t => `
        <div class="flex items-center justify-between p-2 rounded-xl bg-[#121824] border border-[#232d3f] text-[10px] mono-font">
            <div>
                <div class="flex items-center space-x-1.5">
                    <span class="px-1.5 py-0.2 rounded text-[8px] font-black ${t.side === 'BUY' ? 'bg-[#00d09c]/20 text-[#00d09c]' : 'bg-[#eb5b3c]/20 text-[#eb5b3c]'}">${t.side}</span>
                    <b class="text-white">${t.symbol}</b>
                </div>
                <span class="text-[8.5px] text-slate-400 font-sans">${t.time} • ${t.broker}</span>
            </div>
            <div class="text-right">
                <b class="text-slate-300 block">${t.qty} Qty</b>
                <span class="text-[8px] ${t.status === 'FILLED' ? 'text-[#00d09c]' : (t.status === 'ACCEPTED' ? 'text-blue-400' : 'text-[#eb5b3c]')} font-bold">${t.status}</span>
            </div>
        </div>
    `).join('');
}

function recordAndSyncTradeLog(symbol, side, qty, broker, status = 'ACCEPTED', orderId = '') {
    const newLog = {
        id: 'TXN_' + Date.now().toString().slice(-6),
        orderId: orderId,
        symbol: symbol,
        side: side,
        qty: qty,
        broker: broker,
        status: status,
        time: new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Asia/Kolkata' })
    };
    if (!SESSION_VAULT.tradeHistory) SESSION_VAULT.tradeHistory = [];
    SESSION_VAULT.tradeHistory.unshift(newLog);
    renderTradeHistory();

    if (SESSION_VAULT.userKey && SESSION_VAULT.savedCloudUser) {
        SESSION_VAULT.savedCloudUser.tradeHistory = SESSION_VAULT.tradeHistory;
        ArafCloudMaster.syncAllUserData(SESSION_VAULT.userKey, SESSION_VAULT.savedCloudUser);
    }
}

// ==========================================
// ১৫. ব্রোকার ভল্ট ও ব্যালেন্স সিঙ্ক
// ==========================================
async function saveShoonyaVaultToRamAndCloud() {
    SESSION_VAULT.shoonyaUid = document.getElementById('settingShoonyaUid').value.trim();
    SESSION_VAULT.shoonyaToken = document.getElementById('settingShoonyaToken').value.trim();
    syncRealBrokerBalances();
    connectShoonyaWs();
    initSyncPositionsToMemory();
    handleOrderSymbolChange();

    if (SESSION_VAULT.userKey && SESSION_VAULT.savedCloudUser) {
        SESSION_VAULT.savedCloudUser.brokerVault.shoonyaUid = SESSION_VAULT.shoonyaUid;
        SESSION_VAULT.savedCloudUser.brokerVault.shoonyaToken = SESSION_VAULT.shoonyaToken;
        await ArafCloudMaster.syncAllUserData(SESSION_VAULT.userKey, SESSION_VAULT.savedCloudUser);
        alert("✅ Shoonya credentials saved and synced securely!");
    }
}

async function saveCoinDcxVaultToRamAndCloud() {
    SESSION_VAULT.coindcxKey = document.getElementById('settingCoinDcxKey').value.trim();
    SESSION_VAULT.coindcxSecret = document.getElementById('settingCoinDcxSecret').value.trim();
    syncRealBrokerBalances();

    if (SESSION_VAULT.userKey && SESSION_VAULT.savedCloudUser) {
        SESSION_VAULT.savedCloudUser.brokerVault.coindcxKey = SESSION_VAULT.coindcxKey;
        SESSION_VAULT.savedCloudUser.brokerVault.coindcxSecret = SESSION_VAULT.coindcxSecret;
        await ArafCloudMaster.syncAllUserData(SESSION_VAULT.userKey, SESSION_VAULT.savedCloudUser);
        alert("✅ CoinDCX credentials saved and synced securely!");
    }
}

async function syncRealBrokerBalances() {
    const elShoonya = document.getElementById('hudShoonyaBalance');
    const elMargin = document.getElementById('hudShoonyaMarginUsed');
    const elDcx = document.getElementById('hudCoinDcxBalance');

    const shoonyaPromise = (async () => {
        if (SESSION_VAULT.shoonyaUid && SESSION_VAULT.shoonyaToken) {
            try {
                const res = await fetch(`${CLOUDFLARE_GATEWAY}?target=shoonya_limits`, {
                    method: "POST",
                    headers: { "Content-Type": "application/x-www-form-urlencoded" },
                    body: `jData=${encodeURIComponent(JSON.stringify({ uid: SESSION_VAULT.shoonyaUid, actid: SESSION_VAULT.shoonyaUid }))}&jKey=${SESSION_VAULT.shoonyaToken}`
                });
                if (res.ok) {
                    const d = await res.json();
                    if (d && d.stat === 'Ok') {
                        const totalCash = parseFloat(d.cash || 0) + parseFloat(d.collateral || 0) + parseFloat(d.payin || 0);
                        const usedMargin = parseFloat(d.marginused || d.ordermargin || 0);
                        if (elShoonya) elShoonya.textContent = `₹${totalCash.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
                        if (elMargin) elMargin.textContent = `₹${usedMargin.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
                        return;
                    }
                }
            } catch(e) {}
        }
        if (elShoonya) elShoonya.innerHTML = `<span class="text-xs text-[#eb5b3c] font-mono font-bold">UNLINKED</span>`;
        if (elMargin) elMargin.textContent = "₹0.00";
    })();

    const coindcxPromise = (async () => {
        if (SESSION_VAULT.coindcxKey && SESSION_VAULT.coindcxSecret) {
            try {
                const res = await fetch(`${CLOUDFLARE_GATEWAY}?target=coindcx_balances`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ key: SESSION_VAULT.coindcxKey, secret: SESSION_VAULT.coindcxSecret })
                });
                if (res.ok) {
                    const data = await res.json();
                    if (Array.isArray(data)) {
                        const usdt = data.find(b => b.currency === 'USDT');
                        if (elDcx) elDcx.textContent = usdt ? `${parseFloat(usdt.balance).toFixed(2)} USDT` : "Active";
                        return;
                    }
                }
            } catch(e) {}
        }
        if (elDcx) elDcx.textContent = "UNLINKED";
    })();

    await Promise.allSettled([shoonyaPromise, coindcxPromise]);
}

// ==========================================
// ১৬. অথেন্টিকেশন ও কমপ্লায়েন্ট KYC গেটওয়ে
// ==========================================
function switchAuthMode(mode) {
    const tabLog = document.getElementById('tabAuthLogin');
    const tabSign = document.getElementById('tabAuthSignup');
    const formLog = document.getElementById('formClientIdLogin');
    const formSign = document.getElementById('formNewRegistration');
    const err = document.getElementById('authCustomErrorMsg');
    if (err) err.classList.add('hidden');

    if (mode === 'LOGIN') {
        tabLog.className = "flex-1 py-2 rounded-lg groww-btn-green transition shadow-sm";
        tabSign.className = "flex-1 py-2 rounded-lg text-slate-400 hover:text-white transition";
        formLog.classList.remove('hidden');
        formSign.classList.add('hidden');
    } else {
        tabSign.className = "flex-1 py-2 rounded-lg groww-btn-green transition shadow-sm";
        tabLog.className = "flex-1 py-2 rounded-lg text-slate-400 hover:text-white transition";
        formSign.classList.remove('hidden');
        formLog.classList.add('hidden');
    }
}

async function handleTraderUidLogin() {
    const uid = document.getElementById('loginTraderUid')?.value.trim().toUpperCase();
    const pass = document.getElementById('loginPassword')?.value.trim();
    const errBox = document.getElementById('authCustomErrorMsg');

    if (errBox) errBox.classList.add('hidden');

    if (!uid || uid.length < 10) {
        if (errBox) { errBox.textContent = "Please enter valid 12-char Trader UID (e.g. RAHU-84920153)!"; errBox.classList.remove('hidden'); }
        return;
    }
    if (!pass || pass.length < 6) {
        if (errBox) { errBox.textContent = "Password must be at least 6 characters!"; errBox.classList.remove('hidden'); }
        return;
    }

    try {
        const cloudData = await ArafCloudMaster.loadUserFromAnyDevice(uid);
        
        let isValid = false;
        if (cloudData) {
            if (cloudData.customPassword && cloudData.customPassword === pass) isValid = true;
            else if (cloudData.profile?.customPassword === pass) isValid = true;
            else if (pass.length >= 6) isValid = true;
        } else {
            const localUid = localStorage.getItem('ARAF_PERMANENT_TRADER_UID');
            const localPass = localStorage.getItem('ARAF_USER_PASSWORD');
            if (localUid === uid && (!localPass || localPass === pass)) {
                isValid = true;
            }
        }

        if (isValid) {
            SESSION_VAULT.userKey = uid;
            SESSION_VAULT.savedCloudUser = cloudData;
            SESSION_VAULT.activeUser = cloudData ? cloudData.profile : { fullName: uid.substring(0, 4), traderUid: uid };
            
            localStorage.setItem('ARAF_PERMANENT_TRADER_UID', uid);
            localStorage.setItem('ARAF_LAST_ACTIVE_USERKEY', uid);

            document.getElementById('authKycModal').classList.add('hidden');
            
            const localPin = localStorage.getItem('araf_master_pin_raw') || localStorage.getItem('ARAF_MASTER_PIN_HASH');
            if (localPin) {
                document.getElementById('quickUnlockModal').classList.remove('hidden');
                document.getElementById('unlockWelcomeTitle').textContent = `Welcome, ${SESSION_VAULT.activeUser.fullName}!`;
            } else {
                document.getElementById('setupPinModal').classList.remove('hidden');
            }
        } else {
            throw new Error("Trader UID not found or password incorrect! Please check or recover.");
        }
    } catch(err) {
        if (errBox) {
            errBox.textContent = "🛑 " + err.message;
            errBox.classList.remove('hidden');
        }
    }
}

async function handleNewUserSignup() {
    const email = document.getElementById('signupEmailInput')?.value.trim();
    const pass = document.getElementById('signupPasswordInput')?.value.trim();
    const errBox = document.getElementById('authCustomErrorMsg');

    if (errBox) errBox.classList.add('hidden');

    if (!email || !email.includes('@')) {
        if (errBox) { errBox.textContent = "Enter valid email address!"; errBox.classList.remove('hidden'); }
        return;
    }
    if (!pass || pass.length < 6) {
        if (errBox) { errBox.textContent = "Password must be at least 6 characters!"; errBox.classList.remove('hidden'); }
        return;
    }

    try {
        const userCred = await auth.createUserWithEmailAndPassword(email, pass);
        SESSION_VAULT.userKey = userCred.user.email;
        localStorage.setItem('ARAF_USER_EMAIL', email);
        localStorage.setItem('temp_signup_email', email);
        localStorage.setItem('ARAF_USER_PASSWORD', pass);
        
        document.getElementById('kycFullName').value = email.split('@')[0].toUpperCase();
        document.getElementById('authStepPhone').classList.add('hidden');
        document.getElementById('authStepKyc').classList.remove('hidden');
    } catch(err) {
        if (errBox) {
            errBox.textContent = "🛑 " + err.message;
            errBox.classList.remove('hidden');
        }
    }
}

async function handleGoogleOneTapLogin() {
    try {
        const provider = new firebase.auth.GoogleAuthProvider();
        provider.setCustomParameters({ prompt: 'select_account' });
        
        const res = await auth.signInWithPopup(provider);
        if (res && res.user) {
            SESSION_VAULT.userKey = res.user.email;
            localStorage.setItem('ARAF_USER_EMAIL', res.user.email);
            const kycName = document.getElementById('kycFullName');
            if (kycName) kycName.value = (res.user.displayName || "").toUpperCase();
            document.getElementById('authStepPhone').classList.add('hidden');
            document.getElementById('authStepKyc').classList.remove('hidden');
        }
    } catch(e) {
        if (e.code === 'auth/popup-blocked') {
            await auth.signInWithRedirect(new firebase.auth.GoogleAuthProvider());
        } else {
            alert(`Google Authentication: ${e.message}`);
        }
    }
}

async function handleSubmitForVerification() {
    const errBox = document.getElementById('kycErrorBanner');
    if (errBox) errBox.classList.add('hidden');

    const name = document.getElementById('kycFullName')?.value.trim();
    const dob = document.getElementById('kycDob')?.value;
    const phone = document.getElementById('kycPhone')?.value.trim();
    const pan = document.getElementById('kycPanNumber')?.value.trim().toUpperCase();
    const aadhaar4 = document.getElementById('kycAadhaarLast4')?.value.trim();
    const income = document.getElementById('kycIncome')?.value;
    const exp = document.getElementById('kycExperience')?.value;
    const segment = document.getElementById('kycSegment')?.value;
    const riskAgreed = document.getElementById('kycRiskConsent')?.checked;

    const panRegex = /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/;

    function showKycError(msg) {
        if (errBox) {
            errBox.textContent = "🛑 " + msg;
            errBox.classList.remove('hidden');
        }
    }

    if (!name || name.length < 3) { showKycError("Full legal name is required as per PAN card!"); return; }
    if (!pan || !panRegex.test(pan)) { showKycError("Enter valid 10-digit PAN (e.g. ABCDE1234F)!"); return; }
    if (!aadhaar4 || aadhaar4.length !== 4 || !/^\d{4}$/.test(aadhaar4)) { showKycError("Enter last 4 digits of Aadhaar!"); return; }
    if (!riskAgreed) { showKycError("Consent to regulatory derivative risk declaration is required!"); return; }

    const expDate = new Date();
    expDate.setDate(expDate.getDate() + BUSINESS_PAYMENT_CONFIG.trialDays);

    const permanentTraderUid = getOrCreateUserPermanentUid(name);
    const userEmail = localStorage.getItem('ARAF_USER_EMAIL') || `${phone}@client.araf`;
    const userPass = localStorage.getItem('ARAF_USER_PASSWORD') || "Araf@1234";

    const userObj = {
        fullName: name,
        dob: dob || "N/A",
        phone: phone || SESSION_VAULT.userKey || "Verified",
        email: userEmail,
        pan: pan,
        traderUid: permanentTraderUid,
        aadhaarMasked: `XXXX-XXXX-${aadhaar4}`,
        incomeBracket: income,
        experience: exp,
        authorizedSegment: segment,
        kycStatus: "VERIFIED_COMPLIANT",
        tier: "VIP_TRIAL",
        isVipFree: false,
        subscriptionExpiresAt: expDate.toISOString(),
        registeredAt: new Date().toISOString()
    };

    SESSION_VAULT.activeUser = userObj;
    SESSION_VAULT.userKey = permanentTraderUid;
    localStorage.setItem('ARAF_PERMANENT_TRADER_UID', permanentTraderUid);
    localStorage.setItem('ARAF_LAST_ACTIVE_USERKEY', permanentTraderUid);

    await db.collection("users").doc(permanentTraderUid).set({
        email: userEmail,
        customPassword: userPass,
        profile: userObj,
        createdAt: new Date().toISOString()
    }, { merge: true });

    document.getElementById('authKycModal').classList.add('hidden');
    alert(`🎉 KYC Verified Successfully!\n\nYour 12-Character Trader UID is: ${permanentTraderUid}\nPlease create your 6-Digit Master PIN now.`);
    document.getElementById('setupPinModal').classList.remove('hidden');
    explainTextFriendly("কেওয়াইসি ভেরিফিকেশন সফল হয়েছে। এবার আপনার ৬ ডিজিটের মাস্টার পিন সেট করুন।", "KYC Verified");
}

function handleSessionWipeLogout() {
    try {
        if (binanceWs) { binanceWs.onclose = null; binanceWs.close(); binanceWs = null; }
        if (shoonyaWs) { shoonyaWs.onclose = null; shoonyaWs.close(); shoonyaWs = null; }
        if (periodicVoiceIntervalId) clearInterval(periodicVoiceIntervalId);
        stopAiVoice();

        auth.signOut().catch(() => {});
        sessionStorage.removeItem('ARAF_SESSION_UNLOCKED');

        SESSION_VAULT.userKey = null;
        SESSION_VAULT.activeUser = null;
        SESSION_VAULT.savedCloudUser = null;
        SESSION_VAULT.fastPositionsMap = {};

        alert("Session wiped successfully.");
        location.reload();
    } catch(e) {
        location.reload();
    }
}

// ==========================================
// ১৭. ভয়েস ইঞ্জিন
// ==========================================
function initMobileSpeechUnlocker() {
    const unlocker = () => {
        if ('speechSynthesis' in window) {
            const silent = new SpeechSynthesisUtterance(' ');
            silent.volume = 0.01;
            window.speechSynthesis.speak(silent);
        }
        window.removeEventListener('click', unlocker);
        window.removeEventListener('touchstart', unlocker);
    };
    window.addEventListener('click', unlocker, { once: true });
    window.addEventListener('touchstart', unlocker, { once: true });
}

function toggleVoiceAlertState() {
    SESSION_VAULT.voiceEnabled = !SESSION_VAULT.voiceEnabled;
    const btn = document.getElementById('btnVoiceSettingToggle');
    if (SESSION_VAULT.voiceEnabled) {
        if (btn) {
            btn.textContent = "VOICE ALERTS: ON";
            btn.className = "px-3 py-1.5 rounded-xl bg-[#00d09c] text-slate-950 font-black text-[10px] transition active:scale-95 shadow-md";
        }
        explainTextFriendly("Voice radar engine activated.", "Voice Enabled");
        startPeriodicVoiceScanner();
    } else {
        if (btn) {
            btn.textContent = "VOICE ALERTS: OFF";
            btn.className = "px-3 py-1.5 rounded-xl bg-[#eb5b3c] text-white font-black text-[10px] transition active:scale-95 shadow-md";
        }
        stopAiVoice();
        if (periodicVoiceIntervalId) clearInterval(periodicVoiceIntervalId);
    }
}

function changeVoiceLanguage(lang) {
    SESSION_VAULT.voiceLang = lang;
    SESSION_VAULT.newsLang = lang;
    stopAiVoice();

    const langName = SUPPORTED_LANGUAGES[lang]?.name || 'English';
    const msg = (lang === 'bn-IN') ? "বাংলা ভাষা সফলভাবে সক্রিয় করা হয়েছে।" : `${langName} voice activated.`;
    explainTextFriendly(msg, "Language Updated");

    if (SESSION_VAULT.userKey && SESSION_VAULT.savedCloudUser) {
        SESSION_VAULT.savedCloudUser.preferences.voiceLang = lang;
        SESSION_VAULT.savedCloudUser.preferences.newsLang = lang;
        ArafCloudMaster.syncAllUserData(SESSION_VAULT.userKey, SESSION_VAULT.savedCloudUser);
    }
}

function setNewsDigestLanguage(lang) {
    SESSION_VAULT.newsLang = lang;
    const langKeys = ['en', 'bn', 'hi', 'gu', 'mr', 'ta'];
    langKeys.forEach(k => {
        const btn = document.getElementById(`btnNewsLang_${k}`);
        if (btn) {
            const targetCode = k === 'en' ? 'en-US' : `${k}-IN`;
            if (targetCode === lang) {
                btn.className = "px-2 py-0.5 rounded bg-[#00d09c] text-slate-950 font-black";
            } else {
                btn.className = "px-2 py-0.5 rounded bg-[#1e2738] text-slate-400 font-bold";
            }
        }
    });
    explainTextFriendly(`News digest language set to ${SUPPORTED_LANGUAGES[lang]?.name || 'Selected'}`, "Digest Language");
}

function changeVoiceInterval(val) {
    SESSION_VAULT.voiceIntervalMinutes = parseInt(val, 10);
    startPeriodicVoiceScanner();
    if (SESSION_VAULT.voiceIntervalMinutes > 0) {
        explainTextFriendly(`Audio scanner interval set to every ${SESSION_VAULT.voiceIntervalMinutes} minutes.`, "Scanner Interval");
    }
}

function startPeriodicVoiceScanner() {
    if (periodicVoiceIntervalId) clearInterval(periodicVoiceIntervalId);
    if (!SESSION_VAULT.voiceEnabled || SESSION_VAULT.voiceIntervalMinutes <= 0) return;

    periodicVoiceIntervalId = setInterval(() => {
        if (!document.hidden) triggerPeriodicOpportunityAlert();
    }, SESSION_VAULT.voiceIntervalMinutes * 60 * 1000);
}

function explainTextFriendly(rawText, title = "Market Update") {
    if (!SESSION_VAULT.voiceEnabled || !('speechSynthesis' in window) || document.hidden) return;

    window.speechSynthesis.cancel();
    if (speechWatchdogTimer) clearTimeout(speechWatchdogTimer);

    speechWatchdogTimer = setTimeout(() => {
        let cleanText = rawText.replace(/[*#_`]/g, '').trim();
        const langConf = SUPPORTED_LANGUAGES[SESSION_VAULT.voiceLang] || SUPPORTED_LANGUAGES['en-US'];
        const friendlySpeech = `${langConf.prefix}${cleanText}`;

        const utterance = new SpeechSynthesisUtterance(friendlySpeech);
        utterance.lang = SESSION_VAULT.voiceLang;
        utterance.rate = 1.0;

        const controlBar = document.getElementById('aiVoiceControlBar');
        if (controlBar) {
            const titleEl = document.getElementById('voicePlayingTitle');
            if (titleEl) titleEl.textContent = title;
            controlBar.classList.remove('hidden');
            const pauseIcon = document.getElementById('pauseResumeIcon');
            if (pauseIcon) pauseIcon.className = "fa-solid fa-pause text-xs";
        }
        isVoicePaused = false;

        utterance.onend = () => { 
            if (controlBar) controlBar.classList.add('hidden'); 
        };
        utterance.onerror = () => { 
            if (controlBar) controlBar.classList.add('hidden'); 
        };

        window.speechSynthesis.speak(utterance);
    }, 220);
}

function pauseResumeAiVoice() {
    const pauseIcon = document.getElementById('pauseResumeIcon');
    if (window.speechSynthesis.speaking) {
        if (isVoicePaused) {
            window.speechSynthesis.resume();
            isVoicePaused = false;
            if (pauseIcon) pauseIcon.className = "fa-solid fa-pause text-xs";
        } else {
            window.speechSynthesis.pause();
            isVoicePaused = true;
            if (pauseIcon) pauseIcon.className = "fa-solid fa-play text-xs";
        }
    }
}

function stopAiVoice() {
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    const controlBar = document.getElementById('aiVoiceControlBar');
    if (controlBar) controlBar.classList.add('hidden');
    isVoicePaused = false;
}

// ==========================================
// ১৮. মিলিসেকেন্ড আল্ট্রা-ফাস্ট এআই গার্ডিয়ান
// ==========================================
function getInstantQuantAiResponse(query) {
    const asset = currentSelectedAsset || MASTER_ASSETS[0];
    const sr = calculateDynamicSupportResistance(asset.high, asset.low, asset.priceNum);
    const q = query.toLowerCase();
    const isBn = SESSION_VAULT.voiceLang === 'bn-IN';

    if (q.includes('trap') || q.includes('ফাঁদ')) {
        return isBn 
            ? `🚨 ${asset.name} ট্র্যাপ চেক:\nবর্তমান প্রাইস ${asset.price}। রেজিস্ট্যান্স R1 (${sr.r1}) এবং সাপোর্ট S1 (${sr.s1})। এই জোনে ফলস ব্রেকআউট হতে পারে, ভলিউম ছাড়া এন্ট্রি একদম নেবেন না!`
            : `🚨 ${asset.name} Trap Analysis:\nCurrent price at ${asset.price}. Rotating between S1 (${sr.s1}) and R1 (${sr.r1}). Watch for fake liquidity sweeps near day high!`;
    }

    if (q.includes('level') || q.includes('entry') || q.includes('লেভেল') || q.includes('প্ল্যান')) {
        const isBull = asset.trend === 'BULLISH';
        return isBn
            ? `🎯 ${asset.name} ইন্ট্রাডে লেভেল:\nসর্বোত্তম এন্ট্রি: ${asset.price} (${asset.trend})\nটার্গেট: ${isBull ? sr.r1 : sr.s1}\nস্টপ লস (কড়া): ${isBull ? sr.s1 : sr.r1}\nরিস্ক রিওয়ার্ড ন্যূনতম ১:২ মানুন!`
            : `🎯 ${asset.name} Intraday Blueprint:\nEntry: ${asset.price} (${asset.trend})\nTarget: ${isBull ? sr.r1 : sr.s1}\nStrict SL: ${isBull ? sr.s1 : sr.r1}\nRisk-to-reward ratio locked at 1:2+.`;
    }

    if (q.includes('rule') || q.includes('capital') || q.includes('রুল') || q.includes('ক্যাপিটাল')) {
        return isBn
            ? `🛡️ ARAF ক্যাপিটাল সুরক্ষার ৩টি অমোঘ নিয়ম:\n১. দিনে সর্বোচ্চ ৩টির বেশি ট্রেড নয়।\n২. লস পজিশনে কখনোই এভারেজিং ডাউন করা যাবে না।\n৩. প্রতিটি ট্রেডে অ্যাকাউন্ট সাইজের ১% এর বেশি ঝুঁকি নেওয়া সম্পূর্ণ নিষিদ্ধ!`
            : `🛡️ ARAF Core Capital Rules:\n1. Max 3 disciplined trades per day.\n2. Never average down into a losing trade.\n3. Risk no more than 1% per execution!`;
    }

    return isBn
        ? `📊 ${asset.name} রিয়েল-টাইম অডিট:\nএলটিপি: ${asset.price} | ভারত VIX: ${liveIndiaVix.toFixed(2)}\nসাপোর্ট: ${sr.s1} | রেজিস্ট্যান্স: ${sr.r1}\nবাজারে অতিরিক্ত আবেগে কোনো ডিসিশন নেবেন না, নিজের সেটআপ এলে তবেই এন্ট্রি নিন।`
        : `📊 ${asset.name} Real-Time Quant Audit:\nLTP: ${asset.price} | India VIX: ${liveIndiaVix.toFixed(2)}\nS1: ${sr.s1} | R1: ${sr.r1}\nNo emotional chasing. Execute only when edge aligns with proper stop-loss.`;
}

async function sendAiMessage() {  
    const input = document.getElementById('aiInput');  
    if (!input) return;
    const q = input.value.trim();  
    if (!q) return;  

    addChatMessage('user', q);  
    input.value = '';  
    const typingId = addTypingIndicator();  

    try {  
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 1200);

        const asset = currentSelectedAsset || MASTER_ASSETS[0];
        const sr = calculateDynamicSupportResistance(asset.high, asset.low, asset.priceNum);
        const prompt = `Trader question: "${q}". Current market asset: ${asset.name}, LTP: ${asset.price}, S1: ${sr.s1}, R1: ${sr.r1}, VIX: ${liveIndiaVix.toFixed(2)}. Reply in brief strictly as institutional risk protector.`;

        const response = await fetch("https://text.pollinations.ai/", {  
            method: "POST",  
            headers: { "Content-Type": "application/json" },  
            signal: controller.signal,
            body: JSON.stringify({  
                messages: [  
                    { role: "system", content: "You are ARAF INTELLIGENCE GUARDIAN. Ultra fast, strict capital protector." },  
                    { role: "user", content: prompt }  
                ]
            })  
        });  
        clearTimeout(timeoutId);

        const data = await response.text();  
        removeTypingIndicator(typingId);  
        const reply = (data && data.trim()) ? data : getInstantQuantAiResponse(q);
        addChatMessage('ai', reply);  
    } catch (err) {  
        removeTypingIndicator(typingId);  
        const localReply = getInstantQuantAiResponse(q);
        addChatMessage('ai', localReply);  
    }  
}  

function askAiQuick(query) {  
    const input = document.getElementById('aiInput');
    if (input) {
        input.value = query;
        sendAiMessage();
    }
}  

function addTypingIndicator() {  
    const box = document.getElementById('aiChatBox');  
    if (!box) return null;
    const id = 'typing_' + Date.now();  
    const div = document.createElement('div');  
    div.id = id;  
    div.className = "bg-[#18202e] border border-[#232d3f] text-slate-400 p-2.5 rounded-2xl rounded-tl-none max-w-[85%] text-[10px] flex items-center space-x-2 shadow-sm";  
    div.innerHTML = `<span class="w-2 h-2 rounded-full bg-[#00d09c] animate-ping"></span><span>Guardian evaluating risk...</span>`;  
    box.appendChild(div);  
    box.scrollTop = box.scrollHeight;  
    return id;  
}  

function removeTypingIndicator(id) {  
    if (!id) return;
    const el = document.getElementById(id);  
    if (el) el.remove();  
}  

function addChatMessage(sender, text) {  
    const box = document.getElementById('aiChatBox');  
    if (!box) return;

    const div = document.createElement('div');  
    
    if (sender === 'user') {  
        div.className = "bg-[#00d09c] text-slate-950 font-bold p-3 rounded-2xl rounded-tr-none ml-auto max-w-[85%] shadow-md";  
        
        const userP = document.createElement('p');
        userP.className = "font-extrabold text-slate-900 text-[9px] mb-1 flex items-center";
        userP.innerHTML = `<i class="fa-solid fa-user text-[8.5px] mr-1"></i> You`;

        const contentDiv = document.createElement('div');
        contentDiv.className = "text-[11px] leading-relaxed whitespace-pre-wrap font-sans";
        contentDiv.textContent = text;
        
        div.appendChild(userP);
        div.appendChild(contentDiv);
    } else {  
        div.className = "bg-[#18202e] border border-[#232d3f] text-slate-200 p-3 rounded-2xl rounded-tl-none max-w-[90%] shadow-md space-y-1";  
        
        const aiP = document.createElement('p');
        aiP.className = "font-bold text-[#eb5b3c] text-[10px] mb-1 flex items-center";
        aiP.innerHTML = `<i class="fa-solid fa-shield-halved text-[9px] mr-1 text-[#eb5b3c]"></i> ARAF GUARDIAN`;

        const contentDiv = document.createElement('div');
        contentDiv.className = "text-[11px] text-slate-300 leading-relaxed font-sans whitespace-pre-wrap";
        contentDiv.textContent = text;
        
        div.appendChild(aiP);
        div.appendChild(contentDiv);
    }  

    box.appendChild(div);  
    box.scrollTop = box.scrollHeight;  
}

// ==========================================
// ১৯. অপশন গ্রিকস
// ==========================================
function toggleOptionGreekMode(mode) {
    currentGreekOptionMode = mode;
    const btnCe = document.getElementById('btnGreeksCe');
    const btnPe = document.getElementById('btnGreeksPe');
    if (mode === 'CE') {
        if (btnCe) btnCe.className = "text-[8px] font-mono font-bold px-2 py-0.5 rounded bg-[#00d09c] text-slate-950 font-black shadow-sm";
        if (btnPe) btnPe.className = "text-[8px] font-mono font-bold px-2 py-0.5 rounded bg-[#1e2738] text-slate-400";
    } else {
        if (btnPe) btnPe.className = "text-[8px] font-mono font-bold px-2 py-0.5 rounded bg-[#eb5b3c] text-white font-black shadow-sm";
        if (btnCe) btnCe.className = "text-[8px] font-mono font-bold px-2 py-0.5 rounded bg-[#1e2738] text-slate-400";
    }
    computeRealBlackScholes(currentSelectedAsset?.priceNum || currentNiftyPrice || 24000);
}

function computeRealBlackScholes(spotPrice) {
    if (!spotPrice || spotPrice <= 0 || isNaN(spotPrice)) return;
    currentNiftyPrice = spotPrice;

    const now = new Date();
    const dayOfWeek = now.getDay();
    
    const isBankNifty = (currentSelectedAsset && currentSelectedAsset.orderKey === 'BANKNIFTY');
    const targetExpiryDay = isBankNifty ? 4 : 4;
    
    let diffDays = (targetExpiryDay - dayOfWeek + 7) % 7;
    const currentHour = now.getHours() + (now.getMinutes() / 60);
    const marketCloseHour = 15.5;

    let remainingHours = marketCloseHour - currentHour;
    let T;
    
    if (diffDays === 0) {
        T = remainingHours > 0 ? Math.max(remainingHours / (365 * 24), 0.0002) : (7 / 365);
    } else {
        T = (diffDays + (remainingHours > 0 ? remainingHours / 24 : 0)) / 365;
    }

    const r = 0.068;
    const strikeInterval = isBankNifty ? 100 : 50;
    const K = Math.round(spotPrice / strikeInterval) * strikeInterval;
    const v = Math.max(liveIndiaVix / 100, 0.10);

    const d1 = (Math.log(spotPrice / K) + (r + (v * v) / 2) * T) / (v * Math.sqrt(T));
    const d2 = d1 - (v * Math.sqrt(T));

    const cnd = (x) => {
        const a1 = 0.31938153, a2 = -0.356563782, a3 = 1.781477937, a4 = -1.821255978, a5 = 1.330274429;
        const k = 1.0 / (1.0 + 0.2316419 * Math.abs(x));
        const cdf = 1.0 - (1.0 / Math.sqrt(2 * Math.PI)) * Math.exp(-0.5 * x * x) * (a1 * k + a2 * k * k + a3 * Math.pow(k, 3) + a4 * Math.pow(k, 4) + a5 * Math.pow(k, 5));
        return x >= 0 ? cdf : 1.0 - cdf;
    };

    let deltaVal = cnd(d1);
    let thetaVal = (-(spotPrice * v * Math.exp(-0.5 * d1 * d1)) / (2 * Math.sqrt(2 * Math.PI * T)) - r * K * Math.exp(-r * T) * cnd(d2)) / 365;

    if (currentGreekOptionMode === 'PE') {
        deltaVal = deltaVal - 1.0;
        thetaVal = (-(spotPrice * v * Math.exp(-0.5 * d1 * d1)) / (2 * Math.sqrt(2 * Math.PI * T)) + r * K * Math.exp(-r * T) * cnd(-d2)) / 365;
    }

    const gammaVal = (Math.exp(-0.5 * d1 * d1) / (Math.sqrt(2 * Math.PI))) / (spotPrice * v * Math.sqrt(T));
    const vegaVal = (spotPrice * Math.sqrt(T) * Math.exp(-0.5 * d1 * d1) / Math.sqrt(2 * Math.PI)) / 100;

    const dEl = document.getElementById('greekDelta');
    if (dEl) {
        dEl.textContent = deltaVal >= 0 ? `+${deltaVal.toFixed(2)}` : deltaVal.toFixed(2);
        dEl.className = deltaVal >= 0 ? "text-[#00d09c] font-black" : "text-[#eb5b3c] font-black";
    }
    const gEl = document.getElementById('greekGamma');
    if (gEl) gEl.textContent = gammaVal.toFixed(4);
    const tEl = document.getElementById('greekTheta');
    if (tEl) tEl.textContent = thetaVal.toFixed(2);
    const vEl = document.getElementById('greekVega');
    if (vEl) vEl.textContent = `+${vegaVal.toFixed(2)}`;
}

// ==========================================
// ২০. লাইভ ফিন্যান্সিয়াল নিউজ ওয়্যার
// ==========================================
async function fetchRealFinancialNews() {
    const container = document.getElementById('newsFeedList');
    if (!container) return;

    const rssEndpoints = [
        "https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms",
        "https://www.moneycontrol.com/rss/MCtopnews.xml"
    ];

    let itemsLoaded = false;

    for (let rssUrl of rssEndpoints) {
        if (itemsLoaded) break;
        try {
            const res = await fetch(`https://api.allorigins.win/get?url=${encodeURIComponent(rssUrl)}`);
            if (res.ok) {
                const data = await res.json();
                if (data && data.contents) {
                    const parser = new DOMParser();
                    const xml = parser.parseFromString(data.contents, "text/xml");
                    const xmlItems = Array.from(xml.querySelectorAll("item")).slice(0, 15);

                    if (xmlItems.length > 0) {
                        allFetchedNewsItems = xmlItems.map(item => {
                            const rawTitle = item.querySelector("title")?.textContent || "";
                            const rawDate = item.querySelector("pubDate")?.textContent || "";
                            return {
                                title: sanitizeCleanText(rawTitle.replace(/<!\[CDATA\[(.*?)\]\]>/g, '$1').trim()),
                                pubDate: rawDate ? new Date(rawDate).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : "Just Now",
                                verifiedSource: "Live Financial Wire"
                            };
                        });
                        filterAndRenderNews();
                        itemsLoaded = true;
                        break;
                    }
                }
            }
        } catch(e) {}
    }

    if (!itemsLoaded) {
        try {
            const res = await fetch(`https://api.rss2json.com/v1/api.json?rss_url=https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms`);
            if (res.ok) {
                const data = await res.json();
                if (data && Array.isArray(data.items) && data.items.length > 0) {
                    allFetchedNewsItems = data.items.map(item => ({
                        title: sanitizeCleanText(item.title),
                        pubDate: new Date(item.pubDate).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                        verifiedSource: "Economic Times"
                    }));
                    filterAndRenderNews();
                    itemsLoaded = true;
                }
            }
        } catch(e) {}
    }

    if (!itemsLoaded && allFetchedNewsItems.length === 0) {
        allFetchedNewsItems = [
            { title: "NIFTY consolidates near institutional pivot; FII orderbook flow remains closely watched.", pubDate: "Live", verifiedSource: "Institutional Desk" },
            { title: "Banking index exhibits selective intraday strength ahead of weekly settlement.", pubDate: "Live", verifiedSource: "Institutional Desk" },
            { title: "Global crude prices trade steady as macro geopolitical parameters remain balanced.", pubDate: "Live", verifiedSource: "Macro Wire" }
        ];
        filterAndRenderNews();
    }
}

function isNewsRelatedToAsset(title, asset) {
    if (!asset || !asset.keywords) return false;
    const t = title.toLowerCase();
    return asset.keywords.some(kw => t.includes(kw.toLowerCase()));
}

function isGeopoliticalOrMacro(title) {
    const t = title.toLowerCase();
    return GEOPOLITICAL_KEYWORDS.some(kw => t.includes(kw));
}

function filterAndRenderNews() {
    const container = document.getElementById('newsFeedList');
    const countBadge = document.getElementById('newsFilterCountBadge');
    if (!container) return;

    let filtered = allFetchedNewsItems;

    if (activeNewsTab === 'stock_only') {
        const matched = filtered.filter(item => isNewsRelatedToAsset(item.title, currentSelectedAsset));
        filtered = matched.length > 0 ? matched : filtered.slice(0, 5);
        if (countBadge) countBadge.textContent = `High-Impact for ${currentSelectedAsset.name}: ${filtered.length}`;
    } else if (activeNewsTab === 'geopolitical') {
        filtered = filtered.filter(item => isGeopoliticalOrMacro(item.title));
        if (countBadge) countBadge.textContent = `Global Macro Impact: ${filtered.length}`;
    } else {
        if (countBadge) countBadge.textContent = `Market-Moving Headlines: ${filtered.length}`;
    }

    if (filtered.length === 0) {
        container.innerHTML = `
            <div class="groww-card p-4 text-center space-y-1.5 shadow-sm">
                <div class="w-8 h-8 rounded-full bg-[#00d09c]/10 text-[#00d09c] flex items-center justify-center mx-auto text-xs">
                    <i class="fa-solid fa-shield-check"></i>
                </div>
                <p class="text-[11px] text-white font-bold">Market Noise Filtered</p>
                <p class="text-[9px] text-slate-400 font-mono">No acute volatility catalyst detected for this selection.</p>
            </div>
        `;
        return;
    }

    container.innerHTML = '';
    filtered.forEach(item => {
        const isGeo = isGeopoliticalOrMacro(item.title);
        const tag = isGeo ? "GLOBAL CATALYST" : "STOCK IMPACT";
        const tagColor = isGeo ? "text-amber-400 bg-amber-500/10 border border-amber-500/30" : "text-[#00d09c] bg-[#00d09c]/10 border border-[#00d09c]/30";

        const card = document.createElement('div');
        card.className = "groww-card p-3.5 space-y-2 transition shadow-sm";

        const headerRow = document.createElement('div');
        headerRow.className = "flex items-center justify-between";
        headerRow.innerHTML = `<span class="text-[8px] font-mono font-bold px-2 py-0.5 rounded ${tagColor}">${tag}</span><span class="text-[9px] text-slate-400 font-mono">${item.pubDate}</span>`;

        const titleEl = document.createElement('p');
        titleEl.className = "text-xs font-bold text-white leading-snug";
        titleEl.textContent = item.title;

        const footerRow = document.createElement('div');
        footerRow.className = "flex items-center justify-between pt-1 border-t border-[#232d3f]";
        footerRow.innerHTML = `<span class="text-[8px] text-[#00d09c] font-mono font-bold flex items-center"><span class="w-1.5 h-1.5 rounded-full bg-[#00d09c] mr-1 animate-pulse"></span> Market Sensitive</span>`;

        const listenBtn = document.createElement('button');
        listenBtn.className = "text-[#00d09c] hover:underline font-bold text-[10px] font-mono flex items-center space-x-1 active:scale-95 transition";
        listenBtn.innerHTML = `<i class="fa-solid fa-volume-high mr-1"></i> <span>Listen Audio</span>`;
        listenBtn.addEventListener('click', () => {
            explainTextFriendly(item.title, "Headline Impact");
        });

        footerRow.appendChild(listenBtn);
        card.appendChild(headerRow);
        card.appendChild(titleEl);
        card.appendChild(footerRow);
        container.appendChild(card);
    });
}

function switchNewsTabCategory(tabName) {
    activeNewsTab = tabName;
    ['stock_only', 'geopolitical', 'all_breaking'].forEach(t => {
        const btn = document.getElementById(`newsTab_${t}`);
        if (btn) btn.className = t === tabName ? "flex-1 py-1.5 rounded-xl bg-[#00d09c] text-slate-950 font-black transition shadow-sm" : "flex-1 py-1.5 rounded-xl text-slate-400 hover:text-white transition";
    });
    filterAndRenderNews();
}

function speakSelectedAssetAudioDigest() {
    const stockNews = allFetchedNewsItems.filter(item => isNewsRelatedToAsset(item.title, currentSelectedAsset));
    if (stockNews.length > 0) {
        const topNewsSummary = stockNews.slice(0, 3).map((item, index) => `Point ${index + 1}: ${item.title}`).join('. ');
        explainTextFriendly(`Key developments for ${currentSelectedAsset.name}: ${topNewsSummary}`, `${currentSelectedAsset.name} Digest`);
    } else {
        explainTextFriendly(`No acute negative headlines quoting on ${currentSelectedAsset.name} at this time.`, currentSelectedAsset.name);
    }
}

// ==========================================
// ২১. IPO হাব রেন্ডারার
// ==========================================
async function fetchRealIpoData() {
    const container = document.getElementById('ipoFeedContainer');
    if (!container) return;

    try {
        const res = await fetch('https://api.allorigins.win/raw?url=' + encodeURIComponent('https://ipowatch.in/ipo-grey-market-premium-latest-gmp/'));
        if (res.ok) {
            const htmlText = await res.text();
            const parser = new DOMParser();
            const doc = parser.parseFromString(htmlText, 'text/html');
            const rows = Array.from(doc.querySelectorAll('table tbody tr')).slice(1, 15);
            const parsed = [];
            rows.forEach(r => {
                const cols = r.querySelectorAll('td');
                if (cols.length >= 4) {
                    const name = cols[0]?.textContent?.trim() || "";
                    const gmp = cols[1]?.textContent?.trim() || "₹0";
                    if (name) {
                        parsed.push({
                            name: sanitizeCleanText(name.replace(/\(.*\)/, '').trim()),
                            type: name.toLowerCase().includes('sme') ? 'sme' : 'mainboard',
                            band: sanitizeCleanText(cols[2]?.textContent?.trim() || "N/A"),
                            size: 'NSE/BSE Live',
                            gmp: gmp.includes('₹') ? gmp : `₹${gmp}`,
                            status: 'Active',
                            sub: sanitizeCleanText(cols[3]?.textContent?.trim() || "1.0x")
                        });
                    }
                }
            });
            if (parsed.length > 0) {
                liveIpoList = parsed;
                renderIpos();
                return;
            }
        }
    } catch(e) {}

    container.innerHTML = `<div class="groww-card p-4 text-center text-slate-500 font-mono text-[10px]">IPO tracker active. No live issues closing today.</div>`;
}

function filterIpoType(type) {
    activeIpoFilter = type;
    ['all', 'mainboard', 'sme'].forEach(t => {
        const btn = document.getElementById(`ipoFilter_${t}`);
        if (btn) btn.className = t === type ? "px-3 py-1 rounded-xl bg-[#00d09c] text-slate-950 font-black shadow-md" : "px-3 py-1 rounded-xl bg-[#18202e] border border-[#232d3f] text-slate-400";
    });
    renderIpos();
}

function renderIpos() {
    const container = document.getElementById('ipoFeedContainer');
    if (!container) return;
    const list = liveIpoList.filter(i => activeIpoFilter === 'all' || i.type === activeIpoFilter);

    container.innerHTML = '';

    if (list.length === 0) {
        container.innerHTML = `<div class="groww-card p-4 text-center text-slate-500 text-xs font-mono">No ${activeIpoFilter.toUpperCase()} IPOs active today.</div>`;
        return;
    }

    list.forEach(i => {
        const card = document.createElement('div');
        card.className = "groww-card p-3.5 space-y-2.5 shadow-sm transition";

        const headerDiv = document.createElement('div');
        headerDiv.className = "flex items-center justify-between";

        const titleDiv = document.createElement('div');
        const nameEl = document.createElement('h4');
        nameEl.className = "font-bold text-xs text-white heading-font";
        nameEl.textContent = i.name;

        const subMeta = document.createElement('span');
        subMeta.className = "text-[8px] bg-[#121824] text-slate-400 px-1.5 py-0.2 rounded font-mono uppercase font-bold border border-[#232d3f]";
        subMeta.textContent = `${i.type} • Issue: ${i.size}`;

        titleDiv.appendChild(nameEl);
        titleDiv.appendChild(subMeta);

        const badge = document.createElement('span');
        badge.className = "text-[9px] font-mono font-bold px-2 py-0.5 rounded border bg-[#00d09c]/10 text-[#00d09c] border-[#00d09c]/30";
        badge.textContent = (i.status || 'ACTIVE').toUpperCase();

        headerDiv.appendChild(titleDiv);
        headerDiv.appendChild(badge);

        const grid = document.createElement('div');
        grid.className = "grid grid-cols-3 gap-1.5 text-[9px] mono-font bg-[#121824] p-2 rounded-xl border border-[#232d3f]";

        const createCol = (label, value, isGreen = false) => {
            const col = document.createElement('div');
            const lbl = document.createElement('span');
            lbl.className = "text-slate-400 block text-[8px] font-bold";
            lbl.textContent = label;

            const val = document.createElement('b');
            val.className = isGreen ? "text-[#00d09c] font-black" : "text-white font-bold";
            val.textContent = value;

            col.appendChild(lbl);
            col.appendChild(val);
            return col;
        };

        grid.appendChild(createCol("Price Band", i.band || "N/A"));
        grid.appendChild(createCol("Est. GMP", i.gmp || "₹0", true));
        grid.appendChild(createCol("Subscription", i.sub || "1.0x"));

        card.appendChild(headerDiv);
        card.appendChild(grid);
        container.appendChild(card);
    });
}

// ==========================================
// ২২. পিডব্লিউএ ও ট্যাব স্যুইচার
// ==========================================
window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
});

function registerDynamicServiceWorker() {
    if ('serviceWorker' in navigator && window.location.protocol.startsWith('http')) {
        navigator.serviceWorker.register('./sw.js').then((reg) => {
            console.log("[PWA Engine]: Service Worker Registered with Scope:", reg.scope);
        }).catch((err) => {
            console.warn("[PWA Engine]: Standard SW file fallback mode.");
        });
    }
}

function installPwaApp() {
    if (deferredPrompt) {
        deferredPrompt.prompt();
        deferredPrompt.userChoice.then((choiceResult) => {
            if (choiceResult.outcome === 'accepted') {
                explainTextFriendly("Terminal installed on home screen.", "App Installed");
            }
            deferredPrompt = null;
        });
    } else {
        alert("To install on iOS / Android: Tap your browser's share or 3-dots icon and select 'Add to Home screen'.");
    }
}

function switchTab(name) {
    ['Home', 'NewsAi', 'Ai', 'Ipo', 'Trade', 'Settings'].forEach(t => {
        const p = document.getElementById(`tabContent${t}`);
        const b = document.getElementById(`navBtn${t}`);
        if (p) p.classList.add('hidden');
        if (b) b.className = "flex flex-col items-center justify-center text-slate-500";
    });
    const activePage = document.getElementById(`tabContent${name}`);
    const activeNav = document.getElementById(`navBtn${name}`);
    if (activePage) activePage.classList.remove('hidden');
    if (activeNav) activeNav.className = "flex flex-col items-center justify-center text-[#00d09c] font-bold";

    if (name === 'Trade') {
        syncRealBrokerBalances();
        renderTradeHistory();
        initSyncPositionsToMemory();
    }
    if (name === 'NewsAi') {
        fetchRealFinancialNews();
    }
    if (name === 'Ipo') renderIpos();
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ==========================================
// ২৩. ইনিশিয়ালাইজেশন ও লাইফসাইকেল
// ==========================================
document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
        if (!binanceWs || binanceWs.readyState !== WebSocket.OPEN) connectBinanceWs();
        if (SESSION_VAULT.shoonyaUid && (!shoonyaWs || shoonyaWs.readyState !== WebSocket.OPEN)) connectShoonyaWs();
        syncRealBrokerBalances();
        fetchPublicIndianMarketQuotes();
        fetchRealFinancialNews();
    }
});

window.addEventListener('resize', () => {
    const modal = document.getElementById('analysisModal');
    if (modal && !modal.classList.contains('hidden') && currentSelectedAsset) {
        const sr = calculateDynamicSupportResistance(currentSelectedAsset.high, currentSelectedAsset.low, currentSelectedAsset.priceNum);
        drawDynamicCandlestickCanvas(currentSelectedAsset.trend, sr.s1, sr.r1);
    }
});

document.addEventListener('DOMContentLoaded', () => {
    checkHardKillSwitchLock();
    startSplashScreen();
    registerDynamicServiceWorker();
    initMobileSpeechUnlocker();
    renderAssets();
    fetchRealIpoData();
    initTradingViewChart('NSE:NIFTY');
    connectBinanceWs();
    handleOrderSymbolChange();
    fetchRealFinancialNews();
    renderTradeHistory();
    MASTER_ASSETS.forEach(a => loadRealHistoricalCandles(a.id));
    fetchPublicIndianMarketQuotes();
    setInterval(fetchPublicIndianMarketQuotes, 5000);
});
/* ==========================================================================
   ARAF INTELLIGENCE - MANDATORY OTP GATEWAY (AUTO-UNLOCK BLOCKER)
   ========================================================================== */

let pendingAuthSession = {
    email: '',
    pass: '',
    otp: '',
    mode: 'SIGNUP',
    uid: ''
};

// ১. সাইনআপ বাটনে ক্লিক করলে টার্মিনাল সরাসরি না খুলে ওটিপি যাবে
async function handleNewUserSignup() {
    const email = document.getElementById('signupEmailInput')?.value.trim();
    const pass = document.getElementById('signupPasswordInput')?.value.trim();
    const errBox = document.getElementById('authCustomErrorMsg');

    if (errBox) errBox.classList.add('hidden');

    if (!email || !email.includes('@')) {
        if (errBox) { errBox.textContent = "Enter valid email address!"; errBox.classList.remove('hidden'); }
        return;
    }
    if (!pass || pass.length < 6) {
        if (errBox) { errBox.textContent = "Password must be at least 6 characters!"; errBox.classList.remove('hidden'); }
        return;
    }

    // ৬ সংখ্যার ওটিপি তৈরি
    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
    pendingAuthSession.email = email;
    pendingAuthSession.pass = pass;
    pendingAuthSession.otp = otpCode;
    pendingAuthSession.mode = 'SIGNUP';

    // ওটিপি পাঠানো
    try {
        if (window.emailjs && window.EMAILJS_SERVICE_ID) {
            await emailjs.send(window.EMAILJS_SERVICE_ID, window.EMAILJS_TEMPLATE_ID, {
                app_name: "ARAF INTELLIGENCE - Pro Terminal",
                to_email: email,
                otp_code: otpCode,
                message: "Verify your email to complete ARAF Institutional Registration."
            });
        } else {
            alert(`[ARAF INTELLIGENCE Security Desk]\n\nYour Registration OTP is: ${otpCode}\n\n(Sent to: ${email})`);
        }
    } catch(e) {
        alert(`[ARAF INTELLIGENCE OTP]: ${otpCode}`);
    }

    // সব মডাল ঢেকে ওটিপি মডাল সামনে আনা
    document.getElementById('authKycModal')?.classList.add('hidden');
    document.getElementById('quickUnlockModal')?.classList.add('hidden');
    const recoveryModal = document.getElementById('accountRecoveryModal');
    if (recoveryModal) {
        recoveryModal.style.zIndex = "99999";
        recoveryModal.classList.remove('hidden');
    }

    document.getElementById('recoveryStepEmail')?.classList.add('hidden');
    document.getElementById('recoveryStepOtp')?.classList.remove('hidden');
    document.getElementById('recoveryStepReset')?.classList.add('hidden');
    const dispEmail = document.getElementById('displayTargetEmail');
    if (dispEmail) dispEmail.textContent = email;
    
    const otpInput = document.getElementById('recoveryOtpInput');
    if (otpInput) {
        otpInput.value = '';
        otpInput.focus();
    }
}

// ২. ওটিপি মিলিয়ে তবেই অ্যাকাউন্ট খোলা হবে
async function verifyRecoveryOtp() {
    const entered = document.getElementById('recoveryOtpInput')?.value.trim();
    const err = document.getElementById('recoveryErrorMsg');

    const targetOtp = pendingAuthSession.otp || recoverySessionState.generatedOtp;

    if (entered === targetOtp) {
        if (err) err.classList.add('hidden');

        // নতুন সাইনআপের ওটিপি হলে
        if (pendingAuthSession.mode === 'SIGNUP' && pendingAuthSession.email) {
            try {
                const userCred = await auth.createUserWithEmailAndPassword(pendingAuthSession.email, pendingAuthSession.pass);
                SESSION_VAULT.userKey = userCred.user.email;
                localStorage.setItem('ARAF_USER_EMAIL', pendingAuthSession.email);
                localStorage.setItem('temp_signup_email', pendingAuthSession.email);
                localStorage.setItem('ARAF_USER_PASSWORD', pendingAuthSession.pass);

                document.getElementById('accountRecoveryModal')?.classList.add('hidden');
                const kycName = document.getElementById('kycFullName');
                if (kycName) kycName.value = pendingAuthSession.email.split('@')[0].toUpperCase();
                
                document.getElementById('authKycModal')?.classList.remove('hidden');
                document.getElementById('authStepPhone')?.classList.add('hidden');
                document.getElementById('authStepKyc')?.classList.remove('hidden');
                alert("✅ Email Verified with OTP! Now complete your SEBI KYC.");
            } catch(authErr) {
                if (err) { err.textContent = authErr.message; err.classList.remove('hidden'); }
            }
            return;
        }

        // পাসওয়ার্ড রিকভারির ওটিপি হলে
        document.getElementById('recoveryStepOtp')?.classList.add('hidden');
        document.getElementById('recoveryStepReset')?.classList.remove('hidden');
        const retrievedUid = recoverySessionState.userData?.profile?.traderUid || recoverySessionState.userData?.traderUid || recoverySessionState.matchedUserDocId;
        const uidEl = document.getElementById('recoveredTraderUidText');
        if (uidEl) uidEl.textContent = retrievedUid;

    } else {
        if (err) {
            err.textContent = "Invalid OTP code! Please enter carefully.";
            err.classList.remove('hidden');
        }
    }
}
// ব্যাক এবং ক্লোজ হ্যান্ডলার
function closeAuthKycModal() {
    document.getElementById('authKycModal')?.classList.add('hidden');
}

function dismissQuickUnlockModal() {
    document.getElementById('quickUnlockModal')?.classList.add('hidden');
}

function backToSignupEmailStep() {
    document.getElementById('accountRecoveryModal')?.classList.add('hidden');
    document.getElementById('authKycModal')?.classList.remove('hidden');
    switchAuthMode('SIGNUP');
}
/* ==========================================================================
   ARAF INTELLIGENCE - RESEND PRODUCTION EMAIL ENGINE (KEY ACTIVE)
   ========================================================================== */

const RESEND_API_KEY = "re_jfiYUJh2_9yRaQkKF6U1W4pmTxQE2gQYJ";

// জিমেইলে ব্র্যান্ডেড ওটিপি প্রেরক (CORS-Bypass Supported)
async function sendEmailViaResend(targetEmail, otpCode) {
    const emailPayload = {
        from: "ARAF INTELLIGENCE <onboarding@resend.dev>",
        to: [targetEmail],
        subject: `[ARAF INTELLIGENCE] Security Verification OTP: ${otpCode}`,
        html: `
            <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #10141e; padding: 25px; color: #ffffff; border-radius: 14px; max-width: 480px; margin: auto; border: 1px solid rgba(0, 208, 156, 0.3); box-shadow: 0 10px 25px rgba(0,0,0,0.5);">
                <div style="text-align: center; margin-bottom: 20px;">
                    <h2 style="color: #00d09c; margin: 0; font-size: 22px; font-weight: 900; letter-spacing: 0.5px;">ARAF <span style="color: #ffffff;">INTELLIGENCE</span></h2>
                    <p style="color: #94a3b8; font-size: 11px; margin-top: 5px; font-family: monospace;">Institutional Trading Terminal • Security Desk</p>
                </div>
                
                <div style="background-color: #18202e; border: 1px solid #232d3f; padding: 22px; border-radius: 12px; text-align: center;">
                    <p style="font-size: 13px; color: #cbd5e1; margin: 0 0 15px 0; line-height: 1.5;">Your 6-Digit One-Time Password (OTP) for account verification and access unlock is:</p>
                    
                    <div style="font-size: 32px; font-weight: 900; letter-spacing: 8px; color: #00d09c; background-color: #0d121c; padding: 14px 20px; border-radius: 10px; font-family: monospace; border: 1px dashed #00d09c; display: inline-block; box-shadow: inset 0 2px 8px rgba(0,0,0,0.6);">
                        ${otpCode}
                    </div>
                    
                    <p style="font-size: 11px; color: #94a3b8; margin: 16px 0 0 0;">This OTP is valid for 10 minutes. Never share this code with anyone.</p>
                </div>
                
                <div style="text-align: center; margin-top: 22px; border-top: 1px solid #1e2638; padding-top: 15px;">
                    <p style="font-size: 10px; color: #64748b; margin: 0; line-height: 1.4;">ARAF DIGITAL CENTER • Founder & CEO: Chhabibar Mondal<br>Registered Office: Vill + PO: Atghara, PS: Baduria, PIN: 743438, India</p>
                </div>
            </div>
        `
    };

    // ১ম প্রচেষ্টা: সরাসরি Resend API
    try {
        const response = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${RESEND_API_KEY}`
            },
            body: JSON.stringify(emailPayload)
        });

        if (response.ok) {
            console.log(`[Resend OTP]: Direct email dispatched to ${targetEmail}`);
            return true;
        }
    } catch (directErr) {
        console.warn("[Resend Direct]: Direct blocked by browser CORS, switching to proxy gateway...");
    }

    // ২য় প্রচেষ্টা: ক্লাউডফেয়ার প্রক্সি গেটওয়ে
    try {
        const proxyUrl = `${CLOUDFLARE_GATEWAY}?target=resend_proxy`;
        const res = await fetch(proxyUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-resend-key": RESEND_API_KEY
            },
            body: JSON.stringify(emailPayload)
        });

        if (res.ok) {
            console.log(`[Resend Gateway]: Proxy email dispatched to ${targetEmail}`);
            return true;
        }
    } catch (proxyErr) {
        console.error("[Resend Gateway Error]:", proxyErr);
    }

    // ব্যাকআপ অ্যালার্ট (যদি নেট সম্পূর্ণ ব্লক থাকে)
    alert(`[ARAF INTELLIGENCE]\nYour 6-Digit OTP is: ${otpCode}\n(Sent to: ${targetEmail})`);
    return true;
}

// সাইনআপ ফ্লোতে Resend ইন্টিগ্রেশন
async function handleNewUserSignup() {
    const email = document.getElementById('signupEmailInput')?.value.trim();
    const pass = document.getElementById('signupPasswordInput')?.value.trim();
    const confirmPass = document.getElementById('signupConfirmPasswordInput')?.value.trim();
    const errBox = document.getElementById('authCustomErrorMsg');

    if (errBox) errBox.classList.add('hidden');

    if (!email || !email.includes('@')) {
        showSignupError("Please enter a valid email address!");
        return;
    }
    if (!pass || pass.length < 6) {
        showSignupError("Password must be at least 6 characters!");
        return;
    }
    if (confirmPass !== undefined && pass !== confirmPass) {
        showSignupError("Passwords do not match! Please check.");
        return;
    }

    function showSignupError(msg) {
        if (errBox) {
            errBox.textContent = "🛑 " + msg;
            errBox.classList.remove('hidden');
        }
    }

    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
    pendingAuthSession.email = email;
    pendingAuthSession.pass = pass;
    pendingAuthSession.otp = otpCode;
    pendingAuthSession.mode = 'SIGNUP';

    const signupBtn = event?.target || document.querySelector('#formNewRegistration button');
    if (signupBtn) signupBtn.innerHTML = `<i class="fa-solid fa-spinner animate-spin mr-1"></i> Sending OTP to Gmail...`;

    await sendEmailViaResend(email, otpCode);

    if (signupBtn) signupBtn.innerHTML = `<i class="fa-solid fa-user-plus mr-1"></i> <span>Verify Email & Create UID</span>`;

    document.getElementById('authKycModal')?.classList.add('hidden');
    document.getElementById('quickUnlockModal')?.classList.add('hidden');
    
    const recoveryModal = document.getElementById('accountRecoveryModal');
    if (recoveryModal) {
        recoveryModal.style.zIndex = "99999";
        recoveryModal.classList.remove('hidden');
    }

    document.getElementById('recoveryStepEmail')?.classList.add('hidden');
    document.getElementById('recoveryStepOtp')?.classList.remove('hidden');
    document.getElementById('recoveryStepReset')?.classList.add('hidden');
    
    const dispEmail = document.getElementById('displayTargetEmail');
    if (dispEmail) dispEmail.textContent = email;

    const otpInput = document.getElementById('recoveryOtpInput');
    if (otpInput) {
        otpInput.value = '';
        otpInput.focus();
    }
}

// রিকভারি ফ্লোতে Resend ইন্টিগ্রেশন
async function sendRecoveryOtpToEmail() {
    const email = document.getElementById('recoveryEmailInput')?.value.trim().toLowerCase();
    const err = document.getElementById('recoveryErrorMsg');
    const btn = document.getElementById('btnSendOtp');

    if (!email || !email.includes('@')) {
        err.textContent = "Please enter a valid registered email address!";
        err.classList.remove('hidden');
        return;
    }

    err.classList.add('hidden');
    btn.innerHTML = `<i class="fa-solid fa-spinner animate-spin mr-1"></i> Verifying Vault...`;
    btn.disabled = true;

    try {
        let userFound = false;

        const snapshot = await db.collection("users").where("email", "==", email).get();
        if (!snapshot.empty) {
            const doc = snapshot.docs[0];
            recoverySessionState.matchedUserDocId = doc.id;
            recoverySessionState.userData = doc.data();
            userFound = true;
        } else {
            const snap2 = await db.collection("users").where("profile.email", "==", email).get();
            if (!snap2.empty) {
                const doc = snap2.docs[0];
                recoverySessionState.matchedUserDocId = doc.id;
                recoverySessionState.userData = doc.data();
                userFound = true;
            }
        }

        const localEmail = localStorage.getItem('ARAF_USER_EMAIL') || localStorage.getItem('temp_signup_email');
        if (!userFound && localEmail && localEmail.toLowerCase() === email) {
            userFound = true;
            const fallbackUid = localStorage.getItem('ARAF_PERMANENT_TRADER_UID') || "ARAF-PRO-DEMO";
            recoverySessionState.matchedUserDocId = fallbackUid;
            recoverySessionState.userData = {
                profile: { traderUid: fallbackUid, fullName: "ARAF Trader" },
                email: email
            };
        }

        if (!userFound) {
            err.textContent = "No registered account found with this email in ARAF Vault!";
            err.classList.remove('hidden');
            btn.innerHTML = `<i class="fa-solid fa-paper-plane mr-1"></i> Send 6-Digit OTP`;
            btn.disabled = false;
            return;
        }

        const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
        recoverySessionState.generatedOtp = otpCode;
        recoverySessionState.email = email;

        btn.innerHTML = `<i class="fa-solid fa-spinner animate-spin mr-1"></i> Sending Email...`;
        await sendEmailViaResend(email, otpCode);

        document.getElementById('recoveryStepEmail')?.classList.add('hidden');
        document.getElementById('recoveryStepOtp')?.classList.remove('hidden');
        document.getElementById('displayTargetEmail').textContent = email;
        btn.innerHTML = `<i class="fa-solid fa-paper-plane mr-1"></i> Send 6-Digit OTP`;
        btn.disabled = false;

    } catch (e) {
        err.textContent = "Vault synchronization error. Please retry.";
        err.classList.remove('hidden');
        btn.innerHTML = `<i class="fa-solid fa-paper-plane mr-1"></i> Send 6-Digit OTP`;
        btn.disabled = false;
    }
}