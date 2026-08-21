import { z } from "zod";

export const paginationSchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const accountIdSchema = z.object({
  accountId: z.string().min(1),
});

export const brokerConnectionSchema = z
  .object({
    platform: z
      .enum(["MT5", "MT4", "mt5", "mt4"])
      .transform((value) => value.toUpperCase() as "MT4" | "MT5")
      .default("MT5"),
    login: z.string().trim().max(50).default(""),
    password: z.string().max(200).default(""),
    server: z.string().trim().max(100).default(""),
    providerAccountId: z.string().uuid("Provider account UUID is invalid").optional(),
    brokerProviderId: z.string().uuid("Broker provider is invalid").optional(),
    brokerName: z.string().trim().min(2, "Broker name is required").max(100).optional(),
    useCustomBrokerServer: z.boolean().default(false),
    connectNow: z.boolean().default(true),
  })
  .superRefine((value, context) => {
    const usesDashboardUuid = Boolean(value.providerAccountId);
    if (!usesDashboardUuid && !value.login) {
      context.addIssue({
        code: "custom",
        path: ["login"],
        message: "Login is required",
      });
    }
    if (!usesDashboardUuid && !value.password) {
      context.addIssue({
        code: "custom",
        path: ["password"],
        message: "Password is required",
      });
    }
    if (!usesDashboardUuid && !value.server) {
      context.addIssue({
        code: "custom",
        path: ["server"],
        message: "Server is required",
      });
    }
    if (!usesDashboardUuid && !value.useCustomBrokerServer && !value.brokerProviderId) {
      context.addIssue({
        code: "custom",
        path: ["brokerProviderId"],
        message: "Broker provider is required",
      });
    }
    if (!usesDashboardUuid && value.useCustomBrokerServer && !value.brokerName) {
      context.addIssue({
        code: "custom",
        path: ["brokerName"],
        message: "Broker name is required for manual entry",
      });
    }
  });

export const brokerProviderCreateSchema = z.object({
  displayName: z.string().trim().min(2).max(100),
  platformsSupported: z.array(z.enum(["MT4", "MT5"])).min(1).max(2),
});

export const brokerProviderUpdateSchema = z
  .object({
    displayName: z.string().trim().min(2).max(100).optional(),
    platformsSupported: z.array(z.enum(["MT4", "MT5"])).min(1).max(2).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((value) => Object.values(value).some((entry) => entry !== undefined), {
    message: "No changes provided",
  });

export const brokerServerCreateSchema = z.object({
  platform: z.enum(["MT4", "MT5"]),
  serverName: z.string().trim().min(2).max(100),
});

export const brokerServerUpdateSchema = z
  .object({
    serverName: z.string().trim().min(2).max(100).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((value) => Object.values(value).some((entry) => entry !== undefined), {
    message: "No changes provided",
  });

export const analyticsSummaryQuerySchema = z.object({
  accountId: z.string().min(1).default("ALL"),
  period: z.enum(["DAILY", "WEEKLY", "MONTHLY", "ALL_TIME"]).default("ALL_TIME"),
});

export const tradeQuerySchema = paginationSchema.extend({
  accountId: z.string().optional(),
  status: z.enum(["OPEN", "CLOSED"]).optional(),
  limit: z.coerce.number().int().min(1).max(10_000).default(200),
});

export const crmNoteCreateSchema = z.object({
  traderId: z.string().min(1),
  note: z.string().min(1).max(2000),
});

export const riskRuleSchema = z.object({
  name: z.string().min(1),
  scope: z.enum(["PLATFORM", "ACCOUNT"]),
  severity: z.enum(["INFO", "WARNING", "CRITICAL"]),
  metric: z.enum(["DAILY_LOSS", "MAX_DRAWDOWN", "OPEN_TRADES"]),
  threshold: z.number().positive(),
  enabled: z.boolean(),
});

// ── AI Assistant ─────────────────────────────────────────────────────────────

export const aiChatSchema = z.object({
  message: z.string().trim().min(1, "Message is required").max(4000, "Message is too long"),
  pageContext: z.string().max(64).optional(),
  accountId: z.string().uuid().optional(),
});

export const traderChartAssistantSchema = z.object({
  message: z.string().trim().min(1, "Question is required").max(2000),
  symbol: z.string().trim().min(2).max(32).default("XAUUSD"),
  timeframe: z.string().trim().min(1).max(16).default("15m"),
  accountId: z.string().uuid().optional(),
});

// Used for the optional free-text focus on chart analysis (multipart field).
export const aiChartPromptSchema = z
  .string()
  .trim()
  .max(1000, "Focus prompt is too long")
  .optional();

const impactEnum = z.enum(["LOW", "MEDIUM", "HIGH"]);

const economicEventBaseSchema = z.object({
  title: z.string().trim().min(1).max(200),
  countryCode: z.string().trim().max(8).optional().nullable(),
  currency: z.string().trim().min(2).max(8),
  impact: impactEnum,
  eventTime: z.string().datetime({ offset: true }),
  actual: z.string().trim().max(64).optional().nullable(),
  forecast: z.string().trim().max(64).optional().nullable(),
  previous: z.string().trim().max(64).optional().nullable(),
  source: z.string().trim().max(120).optional().nullable(),
  description: z.string().trim().max(1000).optional().nullable(),
  category: z.string().trim().max(64).optional().nullable(),
  endTime: z.string().datetime({ offset: true }).optional().nullable(),
  timezone: z.string().trim().min(1).max(80).default("UTC"),
  eventType: z.enum(["ECONOMIC", "WEBINAR", "ACADEMY", "PLATFORM", "OTHER"]).default("ECONOMIC"),
  locationUrl: z.string().url().max(500).optional().nullable(),
  status: z.enum(["DRAFT", "PUBLISHED", "CANCELLED"]).default("DRAFT"),
  audience: z.enum(["ALL", "TRADER"]).default("ALL"),
});

export const economicEventCreateSchema = economicEventBaseSchema.refine((value) => !value.endTime || new Date(value.endTime) >= new Date(value.eventTime), {
  message: "End time must be after the start time",
  path: ["endTime"],
});

export const economicEventUpdateSchema = economicEventBaseSchema.partial().refine(
  (value) => !value.endTime || !value.eventTime || new Date(value.endTime) >= new Date(value.eventTime),
  { message: "End time must be after the start time", path: ["endTime"] },
);

export const aiUserLimitsUpdateSchema = z
  .object({
    chatDailyLimit: z.number().int().min(0).max(10000).nullable().optional(),
    chartDailyLimit: z.number().int().min(0).max(10000).nullable().optional(),
    aiEnabled: z.boolean().optional(),
  })
  .refine(
    (v) => v.chatDailyLimit !== undefined || v.chartDailyLimit !== undefined || v.aiEnabled !== undefined,
    { message: "No changes provided" },
  );

// ── Partner Dashboard (Phase 2) ──────────────────────────────────────────────

export const partnerTraderFilterSchema = z.object({
  status: z.enum(["ALL", "ACTIVE", "AT_RISK", "RESTRICTED"]).default("ALL"),
  range: z.enum(["7D", "30D", "90D", "ALL"]).default("ALL"),
  search: z.string().trim().max(120).optional(),
});

export const partnerNoteCreateSchema = z.object({
  traderId: z.string().uuid(),
  note: z.string().trim().min(1, "Note is required").max(2000, "Note is too long"),
});

export const setUserRoleSchema = z.object({
  role: z.enum(["TRADER", "ADMIN", "PARTNER"]),
});

export const assignPartnerSchema = z.object({
  partnerId: z.string().uuid().nullable(),
});

export const commissionStatusSchema = z.object({
  status: z.enum(["PENDING", "APPROVED", "PAID", "CANCELLED"]),
});

export const commissionCreateSchema = z.object({
  traderId: z.string().uuid().nullable().optional(),
  sourceType: z.string().trim().min(1).max(40).default("ADJUSTMENT"),
  grossAmount: z.number().min(0).default(0),
  commissionPercent: z.number().min(0).max(100).default(0),
  commissionAmount: z.number().min(0),
  currency: z.string().trim().length(3).default("USD"),
  periodStart: z.string().date().nullable().optional(),
  periodEnd: z.string().date().nullable().optional(),
  note: z.string().trim().max(500).optional(),
});

export const partnerRebateCreateSchema = z.object({
  traderId: z.string().uuid().nullable().optional(),
  paymentOrderId: z.string().uuid().nullable().optional(),
  sourceType: z.string().trim().min(2).max(80).default("ADJUSTMENT"),
  amount: z.number().positive().max(1_000_000),
  currency: z.string().trim().length(3).transform((value) => value.toUpperCase()).default("USD"),
  status: z.enum(["PENDING", "APPROVED"]).default("PENDING"),
  description: z.string().trim().max(500).nullable().optional(),
});

export const partnerBrokerConfigurationSchema = z.object({
  brokerProviderId: z.string().uuid().nullable().optional(),
  modelType: z.enum(["IB", "CPA", "HYBRID"]),
  rebateRatePerLot: z.number().min(0).max(1_000_000),
  cpaQualificationLots: z.number().min(0).max(1_000_000).default(1),
  cpaTier1Deposit: z.number().min(0).max(100_000_000).default(300),
  cpaTier1Payout: z.number().min(0).max(100_000_000).default(350),
  cpaTier2Deposit: z.number().min(0).max(100_000_000).default(500),
  cpaTier2Payout: z.number().min(0).max(100_000_000).default(550),
  cpaTier3Deposit: z.number().min(0).max(100_000_000).default(1000),
  cpaTier3Payout: z.number().min(0).max(100_000_000).default(750),
  currency: z.string().trim().length(3).transform((value) => value.toUpperCase()).default("USD"),
  isActive: z.boolean().default(true),
});

export const referralClaimSchema = z.object({
  code: z.string().trim().min(2).max(40),
});

// ── Copy Trading (Phase 3) ───────────────────────────────────────────────────

const scalingModeEnum = z.enum([
  "FIXED_MULTIPLIER",
  "BALANCE_PROPORTIONAL",
  "EQUITY_PROPORTIONAL",
  "FIXED_LOT",
]);

const upperStringArray = z
  .array(z.string().trim().min(1).max(20))
  .max(100)
  .transform((arr) => arr.map((s) => s.toUpperCase()));

export const copyStrategyCreateSchema = z.object({
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(1000).optional().nullable(),
  masterAccountId: z.string().uuid(),
  riskMultiplier: z.number().positive().max(100).default(1),
  defaultScalingMode: scalingModeEnum.default("EQUITY_PROPORTIONAL"),
  maxFollowerLot: z.number().positive().max(1000).optional().nullable(),
  maxOpenCopiedTrades: z.number().int().min(0).max(10000).optional().nullable(),
  symbolAllowlist: upperStringArray.optional().nullable(),
  symbolBlocklist: upperStringArray.optional().nullable(),
  standardMonthlyPrice: z.number().positive().max(100000),
  premiumMonthlyPrice: z.number().positive().max(100000),
  currency: z.string().trim().length(3).transform((value) => value.toUpperCase()).default("USD"),
});

export const copyStrategyUpdateSchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    description: z.string().trim().max(1000).optional().nullable(),
    status: z.enum(["DRAFT", "ACTIVE", "PAUSED", "ARCHIVED"]).optional(),
    mode: z.enum(["SIMULATION", "LIVE"]).optional(),
    liveEnabled: z.boolean().optional(),
    riskMultiplier: z.number().positive().max(100).optional(),
    defaultScalingMode: scalingModeEnum.optional(),
    maxFollowerLot: z.number().positive().max(1000).optional().nullable(),
    maxOpenCopiedTrades: z.number().int().min(0).max(10000).optional().nullable(),
    symbolAllowlist: upperStringArray.optional().nullable(),
    symbolBlocklist: upperStringArray.optional().nullable(),
    standardMonthlyPrice: z.number().positive().max(100000).optional(),
    premiumMonthlyPrice: z.number().positive().max(100000).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "No changes provided" });

export const copyGlobalSettingsSchema = z
  .object({
    copyEnabled: z.boolean().optional(),
    liveCopyEnabled: z.boolean().optional(),
    emergencyStopEnabled: z.boolean().optional(),
    maxDailyLossPercent: z.number().positive().max(100).nullable().optional(),
    maxDrawdownPercent: z.number().positive().max(100).nullable().optional(),
    maxCopiedOpenPositions: z.number().int().min(0).max(10000).nullable().optional(),
    maxLotSize: z.number().positive().max(10000).nullable().optional(),
    maxSlippagePoints: z.number().positive().max(100000).nullable().optional(),
    pauseOnDisconnect: z.boolean().optional(),
  })
  .refine((value) => Object.values(value).some((entry) => entry !== undefined), {
    message: "No changes provided",
  });

const copySymbolListSchema = z
  .array(z.string().trim().min(2).max(32).transform((symbol) => symbol.toUpperCase()))
  .max(100)
  .nullable();

export const copyAccountRuleSchema = z.object({
  copyEnabled: z.boolean(),
  maxDailyLossPercent: z.number().positive().max(100).nullable(),
  maxDrawdownPercent: z.number().positive().max(100).nullable(),
  maxCopiedLots: z.number().positive().max(10000).nullable(),
  maxOpenCopiedPositions: z.number().int().min(0).max(10000).nullable(),
  stopAfterLosses: z.number().int().positive().max(1000).nullable(),
  symbolAllowlist: copySymbolListSchema,
  symbolBlocklist: copySymbolListSchema,
});

export const copyFollowSchema = z.object({
  followerAccountId: z.string().uuid(),
  tier: z.enum(["NORMAL", "PREMIUM"]),
  consentAccepted: z.literal(true),
  scalingMode: scalingModeEnum.optional(),
  riskMultiplier: z.number().positive().max(100).optional(),
  fixedLot: z.number().positive().max(1000).optional(),
  maxLot: z.number().positive().max(1000).optional(),
});

export const copySubscriptionUpdateSchema = z
  .object({
    status: z.enum(["ACTIVE", "PAUSED", "REVOKED"]).optional(),
    riskMultiplier: z.number().positive().max(100).optional(),
    maxLot: z.number().positive().max(1000).optional().nullable(),
    scalingMode: scalingModeEnum.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "No changes provided" });

const copyModeEnum = z.enum(["FIXED_LOT", "LOT_MULTIPLIER", "BALANCE_RATIO", "RISK_PERCENT"]);
const optionalCopyNumber = z.number().positive().max(10000).nullable();
const symbolMappingSchema = z
  .record(
    z.string().trim().min(2).max(32).transform((value) => value.toUpperCase()),
    z.string().trim().min(2).max(32).transform((value) => value.toUpperCase()),
  )
  .refine((mapping) => Object.keys(mapping).length <= 100, { message: "Too many symbol mappings" });

export const copyFollowerSettingsSchema = z
  .object({
    copyEnabled: z.boolean(),
    copyMode: copyModeEnum,
    fixedLot: optionalCopyNumber,
    lotMultiplier: z.number().positive().max(100).nullable(),
    minLot: optionalCopyNumber,
    maxLot: optionalCopyNumber,
    maxOpenTrades: z.number().int().positive().max(10000).nullable(),
    maxDailyLossPercent: z.number().positive().max(100).nullable(),
    maxDrawdownPercent: z.number().positive().max(100).nullable(),
    allowedSymbols: copySymbolListSchema,
    blockedSymbols: copySymbolListSchema,
    symbolMapping: symbolMappingSchema,
    copyNewTradesOnly: z.literal(true),
    reverseCopy: z.boolean(),
    pauseOnDisconnect: z.boolean(),
    emergencyStop: z.boolean(),
  })
  .superRefine((value, context) => {
    if (value.copyMode === "RISK_PERCENT") {
      context.addIssue({
        code: "custom",
        path: ["copyMode"],
        message: "Risk-percent mode is coming soon and cannot be enabled yet.",
      });
    }
    if (value.copyMode === "FIXED_LOT" && value.fixedLot === null) {
      context.addIssue({ code: "custom", path: ["fixedLot"], message: "Fixed lot is required." });
    }
    if (value.copyMode === "LOT_MULTIPLIER" && value.lotMultiplier === null) {
      context.addIssue({ code: "custom", path: ["lotMultiplier"], message: "Lot multiplier is required." });
    }
    if (value.minLot !== null && value.maxLot !== null && value.maxLot < value.minLot) {
      context.addIssue({ code: "custom", path: ["maxLot"], message: "Max lot cannot be below min lot." });
    }
    const allowed = new Set(value.allowedSymbols ?? []);
    const conflict = (value.blockedSymbols ?? []).find((symbol) => allowed.has(symbol));
    if (conflict) {
      context.addIssue({
        code: "custom",
        path: ["blockedSymbols"],
        message: `${conflict} cannot be both allowed and blocked.`,
      });
    }
  });

export const selfCopyCreateSchema = z.object({
  sourceAccountId: z.string().uuid(),
  followerAccountId: z.string().uuid(),
  copySettings: copyFollowerSettingsSchema,
});

export const selfCopyUpdateSchema = z
  .object({
    status: z.enum(["LIVE", "PAUSED", "ARCHIVED"]).optional(),
    copySettings: copyFollowerSettingsSchema.optional(),
  })
  .refine((value) => value.status !== undefined || value.copySettings !== undefined, {
    message: "No changes provided",
  });

export const contactRequestSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(254),
  subject: z.string().trim().min(3).max(160),
  message: z.string().trim().min(20).max(4000),
  type: z.enum(["MENTORSHIP", "GENERAL"]).default("MENTORSHIP"),
});

// ── Background jobs (Phase 4.6) ──────────────────────────────────────────────

const jobTypeEnum = z.enum([
  "SYNC_ACCOUNT",
  "SYNC_ALL_CONNECTED_ACCOUNTS",
  "MONITOR_COPY_STRATEGY",
  "MONITOR_ALL_ACTIVE_COPY_STRATEGIES",
  "SIMULATE_COPY_EVENT",
  "SIMULATE_COPY_STRATEGY",
  "EXECUTE_COPY_EVENT",
  "CLOSE_COPY_STRATEGY",
  "RETRY_COPY_LOG",
  "CLEANUP_STALE_JOBS",
  "SYNC_EVALUATION_ACCOUNT",
  "CHECK_EVALUATION_ATTEMPT",
  "CHECK_ALL_ACTIVE_EVALUATIONS",
]);

export const jobEnqueueSchema = z.object({
  type: jobTypeEnum,
  // Payload holds IDs only — never secrets. Bounded shape.
  payload: z
    .object({
      accountId: z.string().uuid().optional(),
      strategyId: z.string().uuid().optional(),
      masterEventId: z.string().uuid().optional(),
      copyExecutionLogId: z.string().uuid().optional(),
      attemptId: z.string().uuid().optional(),
    })
    .strict()
    .optional()
    .default({}),
});

export const jobRunSchema = z.object({
  limit: z.coerce.number().int().min(1).max(20).optional(),
  types: z.array(jobTypeEnum).max(20).optional(),
});
