// Human-readable descriptions for the schedules shown in the Tasker tab of the
// right-hand rail.
//
// Deliberately narrow: only the handful of cron shapes that actually show up in
// a user crontab are recognised. Anything else falls back to the raw schedule
// string — guessing at an exotic expression (step ranges, lists, month names)
// would show the user a confidently wrong "next run", which is worse than
// showing them the expression they already wrote. No cron parsing dependency.

/** Minimal translate seam so this module stays free of the i18n singleton. */
export type Translate = (key: string, params?: Record<string, unknown>) => string

export interface CrontabEntry {
  id: string
  name: string
  schedule: string
  schedule_kind: 'standard' | 'special' | string
  command: string
  raw: string
  enabled: boolean
}

export interface StartCalendarInterval {
  Hour?: number
  Minute?: number
  Weekday?: number
  Day?: number
  Month?: number
}

/** Which launchd directory the job was installed in. */
export type LaunchAgentScope = 'user' | 'system-agent' | 'system-daemon'

export interface LaunchAgentEntry {
  label: string
  name: string
  /** null when the agent is only known to launchctl and has no plist here. */
  plist_path: string | null
  plist_exists: boolean
  scope: LaunchAgentScope
  /** True only for ~/Library/LaunchAgents — everything else is read-only. */
  managed: boolean
  /** False when `launchctl list` cannot see this job (system daemons need
   *  root). The four runtime fields below are then null: "unknown", never
   *  "stopped". */
  runtime_known: boolean
  loaded: boolean | null
  running: boolean | null
  pid: number | null
  last_exit_code: number | null
  keep_alive: boolean | null
  run_at_load: boolean | null
  start_interval: number | null
  start_calendar: StartCalendarInterval[]
  comment: string | null
}

export interface CrontabSection {
  supported: boolean
  error: string | null
  entries: CrontabEntry[]
}

export interface LaunchAgentSection {
  supported: boolean
  error: string | null
  agents: LaunchAgentEntry[]
}

export interface ExecutionsSnapshot {
  platform: string
  scanned_at: number
  crontab: CrontabSection
  launch_agents: LaunchAgentSection
}

const SPECIAL_KEYS: Record<string, string> = {
  '@reboot': 'executions.cron.reboot',
  '@daily': 'executions.cron.daily',
  '@midnight': 'executions.cron.daily',
  '@hourly': 'executions.cron.hourly',
  '@weekly': 'executions.cron.weekly',
  '@monthly': 'executions.cron.monthly',
  '@yearly': 'executions.cron.yearly',
  '@annually': 'executions.cron.yearly',
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** Parse a plain integer field, rejecting anything with ranges/lists/steps. */
function intField(raw: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(raw)) return null
  const n = Number(raw)
  return n >= min && n <= max ? n : null
}

export function weekdayKey(day: number): string {
  // cron accepts both 0 and 7 for Sunday.
  return `executions.weekday-${day === 7 ? 0 : day}`
}

/**
 * Describe a crontab schedule field. Returns the raw string unchanged when the
 * expression is not one of the recognised shapes.
 */
export function describeCron(schedule: string, t: Translate): string {
  const s = schedule.trim()
  if (!s) return schedule

  if (s.startsWith('@')) {
    const key = SPECIAL_KEYS[s.toLowerCase()]
    return key ? t(key) : schedule
  }

  const fields = s.split(/\s+/)
  if (fields.length !== 5) return schedule
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields

  const stepped = /^\*\/(\d+)$/.exec(minute)
  if (stepped && hour === '*' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    return t('executions.cron.every-minutes', { n: Number(stepped[1]) })
  }

  // Everything below needs a concrete time-of-day and an unrestricted month.
  const m = intField(minute, 0, 59)
  const h = intField(hour, 0, 23)
  if (m === null || h === null || month !== '*') return schedule
  const time = `${pad2(h)}:${pad2(m)}`

  if (dayOfMonth === '*' && dayOfWeek === '*') {
    return t('executions.cron.daily-at', { time })
  }
  if (dayOfMonth === '*') {
    const d = intField(dayOfWeek, 0, 7)
    if (d === null) return schedule
    return t('executions.cron.weekly-at', { weekday: t(weekdayKey(d)), time })
  }
  if (dayOfWeek === '*') {
    const d = intField(dayOfMonth, 1, 31)
    if (d === null) return schedule
    return t('executions.cron.monthly-at', { day: d, time })
  }
  return schedule
}

/**
 * Describe a LaunchAgent's trigger, in the order launchd itself resolves them:
 * StartInterval → StartCalendarInterval → KeepAlive → RunAtLoad → unknown.
 */
export function describeLaunchAgentSchedule(agent: LaunchAgentEntry, t: Translate): string {
  const interval = agent.start_interval
  if (typeof interval === 'number' && interval > 0) {
    if (interval % 3600 === 0) return t('executions.agent.every-hours', { n: interval / 3600 })
    if (interval % 60 === 0) return t('executions.agent.every-minutes', { n: interval / 60 })
    return t('executions.agent.every-seconds', { n: interval })
  }

  const cal = agent.start_calendar?.[0]
  // Day/Month narrow the trigger to a date. Describing {Day:1, Hour:4} as
  // "every day at 04:00" is confidently wrong — worse than saying nothing — so
  // only the shapes we can state exactly get a description.
  if (cal && typeof cal.Day !== 'number' && typeof cal.Month !== 'number') {
    const minute = typeof cal.Minute === 'number' ? pad2(cal.Minute) : '00'
    // An absent Hour means "every hour at :MM" — say so rather than inventing 00.
    const hour = typeof cal.Hour === 'number' ? pad2(cal.Hour) : '**'
    const time = `${hour}:${minute}`
    if (typeof cal.Weekday === 'number') {
      return t('executions.agent.weekly-at', { weekday: t(weekdayKey(cal.Weekday)), time })
    }
    return t('executions.agent.daily-at', { time })
  }
  if (cal) return t('executions.agent.calendar')

  if (agent.keep_alive) return t('executions.agent.keep-alive')
  if (agent.run_at_load) return t('executions.agent.run-at-load')
  return t('executions.agent.unknown')
}
