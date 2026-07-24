/**
 * Ambient type declarations for lucide-react v1.14.0
 * This package ships without a working .d.ts file, so we declare it globally here.
 * This file must NOT have top-level imports (it must be an ambient declaration).
 */
declare module 'lucide-react' {
  import type { SVGProps, RefAttributes, ForwardRefExoticComponent } from 'react'

  export interface LucideProps extends SVGProps<SVGSVGElement> {
    size?: number | string
    absoluteStrokeWidth?: boolean
    color?: string
    strokeWidth?: number | string
  }

  export type LucideIcon = ForwardRefExoticComponent<LucideProps & RefAttributes<SVGSVGElement>>

  // Icons used in AURIX — navigation
  export const Activity: LucideIcon
  export const BadgeDollarSign: LucideIcon
  export const BarChart3: LucideIcon
  export const Bell: LucideIcon
  export const BookOpenCheck: LucideIcon
  export const CandlestickChart: LucideIcon
  export const Gauge: LucideIcon
  export const LayoutDashboard: LucideIcon
  export const ListChecks: LucideIcon
  export const Settings: LucideIcon
  export const ShieldAlert: LucideIcon
  export const Users: LucideIcon
  export const WalletCards: LucideIcon

  // Icons used in AURIX — components
  export const AlertTriangle: LucideIcon
  export const ArrowLeft: LucideIcon
  export const Mail: LucideIcon
  export const CalendarPlus: LucideIcon
  export const CheckCircle2: LucideIcon
  export const Crosshair: LucideIcon
  export const Download: LucideIcon
  export const FileSpreadsheet: LucideIcon
  export const Import: LucideIcon
  export const Info: LucideIcon
  export const Key: LucideIcon
  export const LogOut: LucideIcon
  export const Maximize2: LucideIcon
  export const Menu: LucideIcon
  export const MoveHorizontal: LucideIcon
  export const Plus: LucideIcon
  export const RefreshCcw: LucideIcon
  export const Search: LucideIcon
  export const ShieldCheck: LucideIcon
  export const BriefcaseBusiness: LucideIcon
  export const SlidersHorizontal: LucideIcon
  export const Sparkles: LucideIcon
  export const TrendingDown: LucideIcon
  export const TrendingUp: LucideIcon
  export const X: LucideIcon
  export const ZoomIn: LucideIcon

  // Icons used in AURIX — AI assistant module
  export const Bot: LucideIcon
  export const CalendarClock: LucideIcon
  export const CalendarDays: LucideIcon
  export const Clock3: LucideIcon
  export const ExternalLink: LucideIcon
  export const Eye: LucideIcon
  export const MapPin: LucideIcon
  export const ScreenShare: LucideIcon
  export const ScreenShareOff: LucideIcon
  export const Send: LucideIcon
  export const Upload: LucideIcon
  export const ImagePlus: LucideIcon
  export const Loader2: LucideIcon
  export const MessageSquare: LucideIcon
  export const Pencil: LucideIcon
  export const Trash2: LucideIcon
  export const Newspaper: LucideIcon

  // Icons used in AURIX — copy trading module
  export const Copy: LucideIcon
  export const Repeat: LucideIcon
  export const Play: LucideIcon
  export const Power: LucideIcon
  export const ShieldOff: LucideIcon
  export const Clock: LucideIcon
}
