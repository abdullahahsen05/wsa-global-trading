import type { LucideIcon } from "lucide-react";
import {
  BookOpenCheck,
  Bot,
  CandlestickChart,
  LayoutDashboard,
  ListChecks,
  MessageSquare,
  Repeat,
  WalletCards,
} from "lucide-react";

export const DEMO_HOME_SECTION = "dashboard" as const;

export type DemoSectionSlug =
  | "dashboard"
  | "accounts"
  | "ai"
  | "copy-trading"
  | "marketplace"
  | "my-bots"
  | "academy"
  | "evaluations"
  | "terminal";

export interface DemoSectionConfig {
  slug: DemoSectionSlug;
  navLabel: string;
  title: string;
  description: string;
  href: string;
  group: "workspace" | "products";
  icon?: LucideIcon;
}

const DEMO_SECTIONS: DemoSectionConfig[] = [
  {
    slug: "dashboard",
    navLabel: "Dashboard",
    title: "Trading overview",
    description: "Equity, risk, and performance across connected accounts using demo sample data.",
    href: "/demo/dashboard",
    group: "workspace",
    icon: LayoutDashboard,
  },
  {
    slug: "accounts",
    navLabel: "Accounts",
    title: "Connected broker accounts",
    description: "Track broker status, equity, drawdown, and connection health with sample accounts.",
    href: "/demo/accounts",
    group: "workspace",
    icon: WalletCards,
  },
  {
    slug: "ai",
    navLabel: "AI Assistant",
    title: "WSA Assistant",
    description: "Mock account-aware prompts, chart analysis layout, and AI workflow previews.",
    href: "/demo/ai",
    group: "workspace",
    icon: MessageSquare,
  },
  {
    slug: "copy-trading",
    navLabel: "Copy Trading",
    title: "Copy Trading",
    description: "Follow strategy layouts, account entitlements, and copy logs with static sample data.",
    href: "/demo/copy-trading",
    group: "workspace",
    icon: Repeat,
  },
  {
    slug: "terminal",
    navLabel: "Terminal",
    title: "Professional Terminal",
    description: "A read-only replica of the trader terminal layout with demo market modules.",
    href: "/demo/terminal",
    group: "workspace",
    icon: CandlestickChart,
  },
  {
    slug: "marketplace",
    navLabel: "Marketplace",
    title: "Bot Marketplace",
    description: "Browse bot marketplace cards, product states, and disabled purchase actions.",
    href: "/demo/marketplace",
    group: "products",
  },
  {
    slug: "my-bots",
    navLabel: "My Bots",
    title: "My Bots",
    description: "Inspect owned bot licenses, versions, and deployment notes with mock data.",
    href: "/demo/my-bots",
    group: "products",
    icon: Bot,
  },
  {
    slug: "academy",
    navLabel: "Academy",
    title: "Trading Academy",
    description: "Preview course cards, progress tracking, and mentorship messaging with mock progress.",
    href: "/demo/academy",
    group: "products",
    icon: BookOpenCheck,
  },
  {
    slug: "evaluations",
    navLabel: "Evaluations",
    title: "Evaluation Programs",
    description: "Explore free challenge and certificate states with sample evaluation data.",
    href: "/demo/evaluations",
    group: "products",
    icon: ListChecks,
  },
];

export function listDemoSections() {
  return DEMO_SECTIONS;
}

export function getDemoSectionConfig(slug: string) {
  return DEMO_SECTIONS.find((section) => section.slug === slug) ?? null;
}

export function getDemoSectionFromPathname(pathname: string) {
  return DEMO_SECTIONS.find((section) => pathname === section.href || pathname.startsWith(`${section.href}/`)) ?? null;
}
