import type { ComponentType, SVGProps } from 'react'
import {
  BarChart3,
  BookOpen,
  CalendarClock,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  CircleMinus,
  CircleSlash2,
  Clock3,
  Download,
  Filter,
  Focus,
  Home,
  Search,
  Settings,
  Sparkles,
  X
} from 'lucide-react'

export type IconName =
  | 'sun'
  | 'timeline'
  | 'check'
  | 'chart'
  | 'spark'
  | 'book'
  | 'settings'
  | 'help'
  | 'chevronLeft'
  | 'chevronRight'
  | 'filter'
  | 'export'
  | 'scope'
  | 'close'
  | 'focus'
  | 'neutral'
  | 'distracted'
  | 'search'

const icons: Record<IconName, ComponentType<SVGProps<SVGSVGElement>>> = {
  sun: Home,
  timeline: CalendarClock,
  check: Check,
  chart: BarChart3,
  spark: Sparkles,
  book: BookOpen,
  settings: Settings,
  help: CircleHelp,
  chevronLeft: ChevronLeft,
  chevronRight: ChevronRight,
  filter: Filter,
  export: Download,
  scope: Focus,
  close: X,
  focus: Focus,
  neutral: CircleMinus,
  distracted: CircleSlash2,
  search: Search
}

export function Icon({ name }: { name: IconName }) {
  const Component = icons[name] ?? Clock3
  return <Component className="icon" aria-hidden="true" strokeWidth={1.8} />
}

export function ChronaMark({ title }: { title?: string }) {
  return (
    <svg className="chronaMark" viewBox="0 0 32 32" role={title ? 'img' : undefined} aria-hidden={title ? undefined : true}>
      {title ? <title>{title}</title> : null}
      <path d="M23.9 7.1A11.25 11.25 0 1 0 25.8 21" />
      <path d="M16 16 23.7 10.8" />
      <circle cx="16" cy="16" r="1.5" />
    </svg>
  )
}
