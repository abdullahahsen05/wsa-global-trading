export type UserRole = "TRADER" | "PARTNER" | "ADMIN" | "SUPER_ADMIN";
export type AccountStatus =
  | "PENDING"
  | "CONNECTED"
  | "SYNCING"
  | "DISCONNECTED"
  | "RESTRICTED"
  | "INACTIVE";
export type TradeStatus = "OPEN" | "CLOSED";
export type TradeSide = "BUY" | "SELL";
export type RiskSeverity = "INFO" | "WARNING" | "CRITICAL";
export type RiskRuleAction = "WARN" | "LIMIT" | "RESTRICT";

export interface MoneyValue {
  amount: number;
  currency: string;
}

export interface TraderAccountSummary {
  accountId: string;
  accountName: string;
  brokerName: string;
  serverName: string | null;
  platform: "MT4" | "MT5" | null;
  status: AccountStatus;
  balance: MoneyValue;
  equity: MoneyValue;
  floatingPnl: MoneyValue;
  openTradeCount: number;
  drawdownPercent: number;
  updatedAt: string;
}

export interface AdminTradingAccountSummary extends TraderAccountSummary {
  traderId: string;
  traderName: string;
  traderEmail: string;
}

export interface TradeDto {
  id: string;
  shortTradeId: string;
  accountId: string;
  symbol: string;
  side: TradeSide;
  status: TradeStatus;
  volume: number;
  openPrice: number;
  closePrice: number | null;
  profit: MoneyValue;
  openedAt: string;
  closedAt: string | null;
  copyStrategyName?: string | null;
  copySyncPending?: boolean;
}

export interface AnalyticsSummary {
  accountId: string;
  totalProfit: MoneyValue;
  winRatePercent: number;
  maxDrawdownPercent: number;
  riskRewardRatio: number;
  consistencyScore: number;
  profitFactor: number;
  averageWin: MoneyValue;
  averageLoss: MoneyValue;
  winningTradeCount: number;
  losingTradeCount: number;
  tradeCount: number;
  period: "DAILY" | "WEEKLY" | "MONTHLY" | "ALL_TIME";
}

export interface EquityPoint {
  capturedAt: string;
  balance: number;
  equity: number;
}

export interface RiskRuleDto {
  id: string;
  accountId: string | null;
  scope: "PLATFORM" | "ACCOUNT";
  name: string;
  severity: RiskSeverity;
  action: RiskRuleAction;
  metric: "DAILY_LOSS" | "MAX_DRAWDOWN" | "OPEN_TRADES";
  threshold: number;
  enabled: boolean;
}

export interface RiskEnforcementStateDto {
  accountId: string;
  blockedNewTrades: boolean;
  restricted: boolean;
  breachedRules: Array<{
    ruleId: string;
    name: string;
    metric: RiskRuleDto["metric"];
    action: RiskRuleAction;
    threshold: number;
  }>;
  source: "SYNC" | "METAAPI_STREAM" | "COPY_PREFLIGHT";
  lastEvaluatedAt: string;
}

export interface RiskEventDto {
  id: string;
  accountId: string;
  ruleId?: string;
  action?: RiskRuleAction;
  ruleName: string;
  severity: RiskSeverity;
  message: string;
  createdAt: string;
}

export interface NotificationDto {
  id: string;
  accountId: string | null;
  type: string | null;
  title: string;
  message: string;
  readAt: string | null;
  createdAt: string;
}

export interface CrmNoteDto {
  id: string;
  traderId: string;
  authorName: string;
  note: string;
  createdAt: string;
}

export interface TraderProfileDto {
  traderId: string;
  name: string;
  email: string;
  segment: "EVALUATION" | "FUNDED" | "AT_RISK" | "VIP";
  accountCount: number;
  totalEquity: MoneyValue;
  lastActivityAt: string;
}

export interface DirectoryPaginationDto {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface AdminUserDirectoryItemDto {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  status: "ACTIVE" | "SUSPENDED" | "PENDING";
  partnerId: string | null;
  joinedAt: string;
}

export interface AdminUserDirectoryDto {
  items: AdminUserDirectoryItemDto[];
  pagination: DirectoryPaginationDto;
  counts: {
    total: number;
    traders: number;
    admins: number;
    partners: number;
    pending: number;
    suspended: number;
  };
}

export interface TraderCrmAccountDto {
  id: string;
  name: string;
  brokerName: string;
  brokerAccountId: string | null;
  status: AccountStatus;
  currency: string;
  equity: MoneyValue | null;
  floatingPnl: MoneyValue | null;
  lastSyncedAt: string | null;
}

export interface TraderCrmSubscriptionDto {
  name: string;
  status: string;
  currentPeriodEnd: string | null;
}

export interface TraderCrmItemDto {
  traderId: string;
  userId: string;
  name: string;
  email: string;
  profileStatus: "ACTIVE" | "SUSPENDED" | "PENDING";
  segment: "EVALUATION" | "FUNDED" | "AT_RISK" | "VIP";
  joinedAt: string;
  partner: {
    id: string;
    name: string;
    email: string;
  } | null;
  accounts: TraderCrmAccountDto[];
  connectedAccountCount: number;
  totalEquity: MoneyValue | null;
  floatingPnl: MoneyValue | null;
  openRiskEventCount: number;
  highestRiskSeverity: RiskSeverity | null;
  evaluationStatus: string | null;
  subscription: TraderCrmSubscriptionDto | null;
  noteCount: number;
  lastActivityAt: string | null;
}

export interface TraderCrmDirectoryDto {
  items: TraderCrmItemDto[];
  pagination: DirectoryPaginationDto;
  counts: {
    total: number;
    funded: number;
    evaluation: number;
    atRisk: number;
    vip: number;
    openRiskEvents: number;
    activeSubscriptions: number;
  };
}

export interface AdminSummaryDto {
  activeTraders: number;
  connectedAccounts: number;
  openRiskEvents: number;
  monthlyRecurringRevenue: MoneyValue;
}

export interface AdminEquityTimelineDto {
  points: EquityPoint[];
  currency: string | null;
  mixedCurrencies: boolean;
  capturedAt: string | null;
}

export type SubscriptionStatus = "ACTIVE" | "PAUSED" | "TRIAL" | "CANCELLED";

export interface SubscriptionDto {
  id: string;
  traderProfileId: string;
  traderName: string;
  traderEmail: string;
  planName: string;
  status: SubscriptionStatus;
  startedAt: string;
  endsAt: string | null;
  createdAt: string;
}

export interface ApiSuccess<T> {
  ok: true;
  data: T;
}

export interface ApiFailure {
  ok: false;
  error: {
    code: string;
    message: string;
  };
}

export type ApiEnvelope<T> = ApiSuccess<T> | ApiFailure;

// ── Bot Marketplace ───────────────────────────────────────────────────────────

export type BotPlatform = "MT5" | "MT4" | "BOTH";
export type BotStatus = "DRAFT" | "PUBLISHED" | "ARCHIVED";
export type BotDifficulty = "BEGINNER" | "INTERMEDIATE" | "ADVANCED";
export type BotRiskLevel = "LOW" | "MEDIUM" | "HIGH";
export type BotAccessStatus = "REQUESTED" | "ACTIVE" | "SUSPENDED" | "REVOKED" | "EXPIRED";
export type BotLicenseStatus = "ACTIVE" | "REVOKED" | "SUSPENDED" | "EXPIRED";
export type BotReleaseStatus = "DRAFT" | "PUBLISHED" | "RETIRED";

export interface BotProductDto {
  id: string;
  slug: string;
  name: string;
  shortDescription: string | null;
  description: string | null;
  features: string[];
  platform: BotPlatform;
  status: BotStatus;
  priceAmount: number | null;
  priceCurrency: string;
  pricingLabel: string | null;
  difficulty: BotDifficulty | null;
  riskLevel: BotRiskLevel | null;
  screenshotUrls: string[];
  videoUrl: string | null;
  downloadUrl: string | null;
  version: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BotAccessRecordDto {
  id: string;
  productId: string;
  productName: string;
  productSlug: string;
  userId: string;
  status: BotAccessStatus;
  source: "REQUEST" | "MANUAL" | "FUTURE_PAYMENT";
  grantedAt: string | null;
  expiresAt: string | null;
  hasPublishedRelease: boolean;
  releaseVersion: string | null;
  releaseFileName: string | null;
  createdAt: string;
}

export interface BotReleaseDto {
  id: string;
  productId: string;
  version: string;
  platform: Exclude<BotPlatform, "BOTH">;
  status: BotReleaseStatus;
  originalFileName: string;
  fileSize: number;
  checksumSha256: string;
  releaseNotes: string | null;
  publishedAt: string | null;
  createdAt: string;
}

// ── Academy ───────────────────────────────────────────────────────────────────

export type AcademyStatus = "DRAFT" | "PUBLISHED" | "ARCHIVED";
export type LessonType = "VIDEO" | "TEXT" | "RESOURCE" | "WEBINAR_REPLAY";
export type LessonProgressStatus = "IN_PROGRESS" | "COMPLETED";
export type QuestionStatus = "OPEN" | "ANSWERED" | "HIDDEN";
export type WebinarStatus = "SCHEDULED" | "LIVE" | "COMPLETED" | "CANCELLED";

export interface AcademyCourseDto {
  id: string;
  slug: string;
  title: string;
  shortDescription: string | null;
  description: string | null;
  difficulty: "BEGINNER" | "INTERMEDIATE" | "ADVANCED" | null;
  estimatedMinutes: number | null;
  status: AcademyStatus;
  coverImageUrl: string | null;
  moduleCount: number;
  lessonCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface AcademyModuleDto {
  id: string;
  courseId: string;
  title: string;
  description: string | null;
  sortOrder: number;
  status: AcademyStatus;
  lessons: AcademyLessonSummaryDto[];
}

export interface AcademyLessonSummaryDto {
  id: string;
  slug: string;
  title: string;
  lessonType: LessonType;
  durationMinutes: number | null;
  sortOrder: number;
  status: AcademyStatus;
  progressStatus: LessonProgressStatus | null;
}

export interface AcademyLessonDto {
  id: string;
  courseId: string;
  moduleId: string;
  courseSlug: string;
  slug: string;
  title: string;
  summary: string | null;
  content: string | null;
  lessonType: LessonType;
  videoUrl: string | null;
  embedUrl: string | null;
  durationMinutes: number | null;
  sortOrder: number;
  status: AcademyStatus;
  progressStatus: LessonProgressStatus | null;
  watchedSeconds: number;
  remarks: AcademyRemarkDto[];
  materials: AcademyMaterialDto[];
  questions: AcademyQuestionDto[];
  note: string | null;
  noteSavedAt: string | null;
}

export interface AcademyRemarkDto {
  id: string;
  lessonId: string;
  authorName: string | null;
  title: string | null;
  body: string;
  pinned: boolean;
  createdAt: string;
}

export interface AcademyMaterialDto {
  id: string;
  lessonId: string;
  title: string;
  materialUrl: string;
  materialType: string | null;
  sortOrder: number;
}

export interface AcademyQuestionDto {
  id: string;
  lessonId: string;
  userId: string;
  question: string;
  answer: string | null;
  answeredAt: string | null;
  status: QuestionStatus;
  createdAt: string;
}

export interface CourseProgressDto {
  courseId: string;
  completedLessons: number;
  totalLessons: number;
  progressPercent: number;
  lastLessonId: string | null;
  lastLessonSlug: string | null;
  lastCourseSlug: string | null;
}

export type AcademyProgressLabel = "BAD" | "GOOD" | "EXCELLENT";

export interface AcademyProgressSummaryDto {
  userId: string;
  traderName: string | null;
  traderEmail: string | null;
  courseId: string;
  courseTitle: string;
  courseSlug: string;
  completedLessons: number;
  totalLessons: number;
  completionPercent: number;
  label: AcademyProgressLabel;
  lastActivityAt: string | null;
}

export interface MyAcademyProgressDto {
  completionPercent: number;
  label: AcademyProgressLabel;
  completedLessons: number;
  totalLessons: number;
  courses: AcademyProgressSummaryDto[];
}

export interface AcademyWebinarDto {
  id: string;
  courseId: string | null;
  courseTitle: string | null;
  title: string;
  description: string | null;
  startTime: string;
  endTime: string | null;
  timezone: string | null;
  joinUrl: string | null;
  replayUrl: string | null;
  zoomMeetingId: string | null;
  status: WebinarStatus;
  attended: boolean;
  createdAt: string;
}

export interface BotLicenseDto {
  id: string;
  productId: string;
  productName: string;
  accessRecordId: string;
  mt5AccountNumber: string;
  platform: string;
  licenseKeyLast4: string;
  /** Only populated on issue/reissue — shown once, then never returned */
  licenseKeyPlaintext?: string;
  status: BotLicenseStatus;
  issuedAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}
