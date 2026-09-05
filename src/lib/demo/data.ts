export const demoOverviewStats = [
  { label: "Balance", value: "$52,480", tone: "lime" as const, helper: "Across 3 sample accounts" },
  { label: "Equity", value: "$54,120", tone: "accent" as const, helper: "Real-time demo live view" },
  { label: "Open trades", value: "7", tone: "default" as const, helper: "2 indices, 3 FX, 2 metals" },
  { label: "AI credits", value: "94", tone: "accent" as const, helper: "Demo-only summary" },
];

export const demoAccounts = [
  {
    id: "acc-growth-50k",
    name: "WSA Global Growth 50K",
    accountNumber: "****1284",
    broker: "MetaTrader 5",
    status: "CONNECTED",
    balance: "$28,400",
    equity: "$29,120",
    drawdown: "2.1%",
    leverage: "1:100",
    copyTier: "Ultra Fast",
    sync: "Synced 2m ago",
  },
  {
    id: "acc-momentum-fx",
    name: "Momentum FX",
    accountNumber: "****8812",
    broker: "MetaTrader 5",
    status: "CONNECTED",
    balance: "$17,980",
    equity: "$18,420",
    drawdown: "1.3%",
    leverage: "1:200",
    copyTier: "Normal",
    sync: "Synced 4m ago",
  },
  {
    id: "acc-eval-sprint",
    name: "Evaluation Sprint",
    accountNumber: "****4401",
    broker: "MetaTrader 5",
    status: "PENDING",
    balance: "$6,100",
    equity: "$6,580",
    drawdown: "0.8%",
    leverage: "1:50",
    copyTier: "Pending approval",
    sync: "Awaiting broker approval",
  },
];

export const demoTrades = [
  {
    ticket: "AUR-10482",
    symbol: "XAUUSD",
    side: "BUY",
    pnl: "+$420",
    status: "OPEN",
    account: "WSA Global Growth 50K",
    openedAt: "Jul 8, 2026 09:18",
    size: "0.40",
  },
  {
    ticket: "AUR-10479",
    symbol: "NAS100",
    side: "SELL",
    pnl: "+$185",
    status: "OPEN",
    account: "Momentum FX",
    openedAt: "Jul 8, 2026 08:42",
    size: "0.15",
  },
  {
    ticket: "AUR-10464",
    symbol: "EURUSD",
    side: "BUY",
    pnl: "-$74",
    status: "OPEN",
    account: "WSA Global Growth 50K",
    openedAt: "Jul 8, 2026 07:55",
    size: "0.18",
  },
  {
    ticket: "AUR-10431",
    symbol: "GBPJPY",
    side: "SELL",
    pnl: "+$512",
    status: "CLOSED",
    account: "Momentum FX",
    openedAt: "Jul 7, 2026 16:10",
    size: "0.22",
  },
  {
    ticket: "AUR-10417",
    symbol: "BTCUSD",
    side: "BUY",
    pnl: "+$860",
    status: "CLOSED",
    account: "WSA Global Growth 50K",
    openedAt: "Jul 7, 2026 13:42",
    size: "0.08",
  },
];

export const demoDashboardKpis = [
  {
    label: "Balance",
    value: "$52,480",
    helper: "Current account balance",
    tone: "accent" as const,
    status: "Good",
    statusTone: "lime" as const,
    sparkline: [22, 24, 23, 27, 29, 31, 33, 35],
  },
  {
    label: "Equity",
    value: "$54,120",
    helper: "Net equity including open trades",
    tone: "lime" as const,
    status: "Excellent",
    statusTone: "lime" as const,
    sparkline: [20, 22, 24, 26, 27, 29, 32, 36],
  },
  {
    label: "Floating PnL",
    value: "↑ $1,640",
    helper: "Unrealised gain on open positions",
    tone: "lime" as const,
    status: "Good",
    statusTone: "accent" as const,
    sparkline: [8, 9, 10, 10, 12, 13, 15, 16],
  },
];

export const demoDashboardSentiment = [
  { label: "Session", value: "London", helper: "Current market window", tone: "accent" as const },
  { label: "Trend Bias", value: "Bullish", helper: "Derived from sample performance", tone: "lime" as const },
  { label: "Volatility", value: "Moderate", helper: "Based on account drawdown", tone: "accent" as const },
  { label: "Performance Score", value: "82", helper: "Composite score from sample results", tone: "accent" as const },
];

export const demoDashboardRings = [
  { label: "Win %", value: "61.2%", status: "Excellent", statusTone: "lime" as const, progress: 0.612, tone: "yellow" as const },
  { label: "Profit Factor", value: "2.31", status: "Excellent", statusTone: "lime" as const, progress: 0.58, tone: "lime" as const },
  { label: "Win/Loss", value: "1.92", status: "Good", statusTone: "accent" as const, progress: 0.48, tone: "yellow" as const },
];

export const demoPerformanceRows = [
  { metric: "Net profit", value: "$28,740", note: "Month to date" },
  { metric: "Win rate", value: "56.8%", note: "Closed trades only" },
  { metric: "Profit factor", value: "2.31", note: "Healthy trend quality" },
  { metric: "Max drawdown", value: "3.4%", note: "Below risk threshold" },
  { metric: "Consistency", value: "74%", note: "Profitable trading days" },
];

export const demoRiskRules = [
  { name: "Daily loss limit", scope: "Platform", threshold: "5.0%", severity: "WARNING", state: "Healthy" },
  { name: "Max drawdown", scope: "Account", threshold: "8.0%", severity: "CRITICAL", state: "Healthy" },
  { name: "Open position cap", scope: "Account", threshold: "10 trades", severity: "INFO", state: "Monitoring" },
];

export const demoRiskEvents = [
  { title: "Gold exposure elevated", severity: "WARNING", detail: "XAUUSD makes up 38% of current open exposure.", raisedAt: "Jul 8, 2026 09:12" },
  { title: "Evaluation account pending review", severity: "INFO", detail: "Broker approval still pending for the Evaluation Sprint account.", raisedAt: "Jul 8, 2026 08:05" },
];

export const demoCopySubscriptions = [
  { id: "sub-1", strategyName: "Momentum FX", followerAccountName: "WSA Global Growth 50K", tier: "PREMIUM", status: "ACTIVE" },
  { id: "sub-2", strategyName: "Indices Reversal", followerAccountName: "Momentum FX", tier: "NORMAL", status: "PAUSED" },
];

export const demoCopyStrategies = [
  { name: "Momentum FX", tier: "Ultra Fast", mode: "SIMULATION", followers: 24, status: "Ready", roi: "+18.4%" },
  { name: "Indices Reversal", tier: "Normal", mode: "SIMULATION", followers: 18, status: "Pending approval", roi: "+9.7%" },
];

export const demoCopyLogs = [
  { date: "Jul 8, 2026 09:18", symbol: "XAUUSD", action: "OPEN", mode: "SIM", lot: "0.40", status: "SUCCESS" },
  { date: "Jul 8, 2026 08:42", symbol: "EURUSD", action: "CLOSE", mode: "SIM", lot: "0.18", status: "SUCCESS" },
  { date: "Jul 7, 2026 16:10", symbol: "NAS100", action: "OPEN", mode: "SIM", lot: "0.15", status: "SKIPPED" },
];

export const demoAiCards = [
  { title: "Credits remaining", value: "94", detail: "Resets monthly on the live platform." },
  { title: "Risk summary", value: "Moderate", detail: "Exposure is concentrated in gold and indices." },
  { title: "Next suggestion", value: "Reduce XAUUSD size", detail: "Keep daily risk under 1.5%." },
];

export const demoAiPrompts = [
  { title: "Pre-session plan", detail: "Summarized London and New York watchlist focus with risk caps.", status: "Ready" },
  { title: "Open exposure review", detail: "Suggested trimming gold allocation and reducing correlated index risk.", status: "Ready" },
  { title: "Post-trade journal", detail: "Structured notes for the last four closed positions.", status: "Draft" },
];

export const demoAiConversation = [
  {
    id: "ai-msg-1",
    role: "user" as const,
    content: "Summarize my current account risk.",
  },
  {
    id: "ai-msg-2",
    role: "assistant" as const,
    content:
      "Your sample portfolio is moderately risk-on. Gold and NAS100 are the largest open exposures, while overall drawdown remains contained below the internal warning threshold.",
  },
  {
    id: "ai-msg-3",
    role: "user" as const,
    content: "What should I watch before the New York session?",
  },
  {
    id: "ai-msg-4",
    role: "assistant" as const,
    content:
      "Focus on gold reaction around session highs, keep correlation risk between indices and crypto in check, and avoid increasing size if the daily risk budget moves above 60%.",
  },
];

export const demoTerminalWidgets = [
  { label: "Provider mode", value: "Demo-only feed" },
  { label: "Watchlist", value: "XAUUSD, EURUSD, NAS100, BTCUSD" },
  { label: "Depth of market", value: "Preview locked in demo mode" },
  { label: "Order ticket", value: "Read-only sample panel" },
];

export const demoBots = [
  { name: "WSA Global Scalper Pro", price: "$500", platform: "MT5", state: "Owned example" },
  { name: "Trend Matrix EA", price: "$500", platform: "MT5", state: "Pending approval example" },
  { name: "London Session Bot", price: "$500", platform: "BOTH", state: "Buy CTA example" },
];

export const demoMarketPlaceFilters: Record<string, "LOW" | "MEDIUM" | "HIGH"> = {
  "WSA Global Scalper Pro": "LOW",
  "Trend Matrix EA": "MEDIUM",
  "London Session Bot": "HIGH",
};

export const demoBotLicenses = [
  { name: "WSA Global Scalper Pro", version: "v2.4.1", license: "Active", account: "WSA Global Growth 50K" },
  { name: "Trend Matrix EA", version: "v1.9.0", license: "Pending approval", account: "Momentum FX" },
];

export const demoCourses = [
  { title: "Risk Management Fundamentals", difficulty: "BEGINNER", progress: "72%" },
  { title: "Liquidity and Session Timing", difficulty: "INTERMEDIATE", progress: "38%" },
  { title: "Institutional Execution Playbook", difficulty: "ADVANCED", progress: "0%" },
];

export const demoEvaluations = [
  { program: "25K Challenge", phase: "Phase 1", status: "In progress", progress: "61%" },
  { program: "50K Challenge", phase: "Verification", status: "Passed", progress: "100%" },
  { program: "100K Sprint", phase: "Waiting", status: "Ready to start", progress: "0%" },
];

export const demoEvaluationPrograms = [
  {
    id: "eval-25k",
    name: "25K Challenge",
    description: "Entry-level funded evaluation with conservative drawdown rules.",
    startingBalance: "$25,000",
    target: "8%",
    maxDailyDrawdown: "4%",
    maxDrawdown: "8%",
    minDays: "5",
    duration: "30 days",
    status: "ACTIVE",
    unlocked: true,
    academyProgress: "72%",
  },
  {
    id: "eval-50k",
    name: "50K Verification",
    description: "Second-stage verification after passing the primary challenge.",
    startingBalance: "$50,000",
    target: "5%",
    maxDailyDrawdown: "4%",
    maxDrawdown: "8%",
    minDays: "5",
    duration: "45 days",
    status: "PASSED",
    unlocked: true,
    academyProgress: "100%",
  },
  {
    id: "eval-100k",
    name: "100K Sprint",
    description: "Advanced evaluation unlocked after academy progression milestones.",
    startingBalance: "$100,000",
    target: "10%",
    maxDailyDrawdown: "5%",
    maxDrawdown: "10%",
    minDays: "7",
    duration: "30 days",
    status: "LOCKED",
    unlocked: false,
    academyProgress: "38%",
  },
];

export const demoBillingRows = [
  { product: "Platform subscription", status: "ACTIVE", amount: "$50 / month", detail: "Renews Jul 30, 2026" },
  { product: "Copy entitlement - WSA Global Growth 50K", status: "ACTIVE", amount: "$15 / month", detail: "Ultra Fast tier" },
  { product: "Copy entitlement - Evaluation Sprint", status: "ACTIVE", amount: "$10 / month", detail: "Auto-activated after verified payment" },
  { product: "WSA Global Scalper Pro", status: "ACTIVE", amount: "$500 one-time", detail: "Owned product" },
];

export const demoReports = [
  { name: "Monthly performance", period: "July 2026", status: "Ready", format: "PDF + Excel", trades: "18 trades" },
  { name: "Risk review", period: "Week 27", status: "Ready", format: "PDF", trades: "7 trades" },
  { name: "Challenge summary", period: "Full history", status: "Draft", format: "PDF", trades: "24 trades" },
];

export const demoSettingsGroups = [
  { title: "Profile", values: ["Trader name: Demo Trader", "Timezone: UTC+05:00", "Base currency: USD"] },
  { title: "Security", values: ["Two-factor auth: Enabled", "Login alerts: Enabled", "Session policy: Standard"] },
  { title: "Broker preferences", values: ["Default account: WSA Global Growth 50K", "Copy mode preference: Ultra Fast", "Risk alert email: Enabled"] },
];

export const demoAccountSnapshots: Record<string, Array<{ capturedAt: string; equity: string }>> = {
  "acc-growth-50k": [
    { capturedAt: "Jul 8, 2026 09:15", equity: "$29,120" },
    { capturedAt: "Jul 8, 2026 08:30", equity: "$28,960" },
    { capturedAt: "Jul 8, 2026 07:45", equity: "$28,820" },
  ],
  "acc-momentum-fx": [
    { capturedAt: "Jul 8, 2026 09:12", equity: "$18,420" },
    { capturedAt: "Jul 8, 2026 08:24", equity: "$18,355" },
    { capturedAt: "Jul 8, 2026 07:31", equity: "$18,210" },
  ],
  "acc-eval-sprint": [
    { capturedAt: "Jul 8, 2026 08:05", equity: "$6,580" },
    { capturedAt: "Jul 7, 2026 16:05", equity: "$6,520" },
  ],
};

export const demoAccountConnectionNotes: Record<string, string> = {
  "acc-growth-50k": "Connected in demo mode. Live sync and broker credential changes are disabled here.",
  "acc-momentum-fx": "Copy entitlement is active in this mock account. Execution and sync actions remain disabled in demo mode.",
  "acc-eval-sprint": "Pending broker verification example. Connect and sync actions are intentionally disabled in the public demo.",
};
