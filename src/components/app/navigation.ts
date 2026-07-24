import type { ComponentType } from "react";
import {
  BadgeDollarSign,
  BarChart3,
  BookOpenCheck,
  Bot,
  CalendarClock,
  CandlestickChart,
  Clock,
  Copy,
  Repeat,
  Gauge,
  LayoutDashboard,
  ListChecks,
  MessageSquare,
  Settings,
  ShieldAlert,
  Sparkles,
  Users,
  WalletCards,
} from "lucide-react";
import type { UserRole } from "@/lib/domain/types";

export interface NavItem {
  href: string;
  label: string;
  role: UserRole;
  icon: ComponentType<{ className?: string }>;
}

export const navItems: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", role: "TRADER", icon: LayoutDashboard },
  { href: "/accounts", label: "Accounts", role: "TRADER", icon: WalletCards },
  { href: "/trades", label: "Trades", role: "TRADER", icon: CandlestickChart },
  { href: "/analytics", label: "Analytics", role: "TRADER", icon: BarChart3 },
  { href: "/risk", label: "Risk", role: "TRADER", icon: ShieldAlert },
  { href: "/ai", label: "AI Assistant", role: "TRADER", icon: MessageSquare },
  { href: "/copy-trading", label: "Copy Trading", role: "TRADER", icon: Repeat },
  { href: "/marketplace", label: "Marketplace", role: "TRADER", icon: Sparkles},
  { href: "/my-bots", label: "My Bots", role: "TRADER", icon: Bot },
  { href: "/academy", label: "Academy", role: "TRADER", icon: BookOpenCheck },
  { href: "/calendar", label: "Calendar", role: "TRADER", icon: CalendarClock },
  { href: "/evaluations", label: "Evaluations", role: "TRADER", icon: ListChecks },
  { href: "/terminal", label: "Terminal", role: "TRADER", icon: CandlestickChart },
  { href: "/billing", label: "Billing", role: "TRADER", icon: BadgeDollarSign },
  { href: "/reports", label: "Reports", role: "TRADER", icon: BookOpenCheck },
  { href: "/settings", label: "Settings", role: "TRADER", icon: Settings },
  { href: "/admin", label: "Overview", role: "ADMIN", icon: Gauge },
  { href: "/admin/users", label: "Users & Access", role: "ADMIN", icon: Users },
  { href: "/admin/accounts", label: "Supervision", role: "ADMIN", icon: WalletCards },
  { href: "/admin/brokers", label: "Broker Catalog", role: "ADMIN", icon: WalletCards },
  { href: "/admin/crm", label: "Trader CRM", role: "ADMIN", icon: MessageSquare },
  { href: "/admin/contact-requests", label: "Contact Requests", role: "ADMIN", icon: MessageSquare },
  { href: "/admin/risk", label: "Risk Rules", role: "ADMIN", icon: ShieldAlert },
  { href: "/admin/copy", label: "Copy Trading", role: "ADMIN", icon: Copy },
  { href: "/admin/jobs", label: "Jobs", role: "ADMIN", icon: Clock },
  { href: "/admin/ai", label: "AI Controls", role: "ADMIN", icon: MessageSquare },
  { href: "/admin/economic-calendar", label: "Calendar", role: "ADMIN", icon: CalendarClock },
  { href: "/admin/billing", label: "Billing", role: "ADMIN", icon: BadgeDollarSign },
  { href: "/admin/partners/withdrawals", label: "Partner Withdrawals", role: "ADMIN", icon: WalletCards },
  { href: "/admin/marketplace", label: "Marketplace", role: "ADMIN", icon: Sparkles},
  { href: "/admin/academy", label: "Academy", role: "ADMIN", icon: BookOpenCheck },
  { href: "/admin/evaluations", label: "Evaluations", role: "ADMIN", icon: ListChecks },
  { href: "/admin/terminal", label: "Terminal", role: "ADMIN", icon: CandlestickChart },
  { href: "/admin/audit", label: "Audit", role: "ADMIN", icon: ListChecks },
  { href: "/partner", label: "Overview", role: "PARTNER", icon: Gauge },
  { href: "/partner/traders", label: "Traders", role: "PARTNER", icon: Users },
  { href: "/partner/crm", label: "CRM", role: "PARTNER", icon: MessageSquare },
  { href: "/partner/commissions", label: "Commissions", role: "PARTNER", icon: BadgeDollarSign },
  { href: "/partner/payouts", label: "Payouts", role: "PARTNER", icon: WalletCards },
];
