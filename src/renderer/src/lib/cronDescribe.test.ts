import { describe, expect, it } from 'vitest'
import {
  describeCron,
  describeLaunchAgentSchedule,
  weekdayKey,
  type LaunchAgentEntry,
  type Translate,
} from './cronDescribe'

// Render key + params verbatim so each assertion pins the branch that was taken,
// independent of the locale wording.
const t: Translate = (key, params) =>
  params && Object.keys(params).length
    ? `${key}(${Object.entries(params)
        .map(([k, v]) => `${k}=${String(v)}`)
        .join(',')})`
    : key

function agent(over: Partial<LaunchAgentEntry> = {}): LaunchAgentEntry {
  return {
    label: 'local.test',
    name: 'Test',
    plist_path: '/Users/t/Library/LaunchAgents/local.test.plist',
    plist_exists: true,
    scope: 'user',
    managed: true,
    runtime_known: true,
    loaded: true,
    running: false,
    pid: null,
    last_exit_code: null,
    keep_alive: false,
    run_at_load: false,
    start_interval: null,
    start_calendar: [],
    comment: null,
    ...over,
  }
}

describe('describeCron', () => {
  it('describes the @-prefixed special schedules', () => {
    expect(describeCron('@reboot', t)).toBe('executions.cron.reboot')
    expect(describeCron('@daily', t)).toBe('executions.cron.daily')
    expect(describeCron('@midnight', t)).toBe('executions.cron.daily')
    expect(describeCron('@hourly', t)).toBe('executions.cron.hourly')
    expect(describeCron('@weekly', t)).toBe('executions.cron.weekly')
    expect(describeCron('@monthly', t)).toBe('executions.cron.monthly')
    expect(describeCron('@yearly', t)).toBe('executions.cron.yearly')
    expect(describeCron('@annually', t)).toBe('executions.cron.yearly')
  })

  it('falls back to the raw string for unknown @-schedules', () => {
    expect(describeCron('@every_minute', t)).toBe('@every_minute')
  })

  it('describes a daily time', () => {
    expect(describeCron('30 2 * * *', t)).toBe('executions.cron.daily-at(time=02:30)')
    expect(describeCron('0 0 * * *', t)).toBe('executions.cron.daily-at(time=00:00)')
  })

  it('describes a minute step', () => {
    expect(describeCron('*/15 * * * *', t)).toBe('executions.cron.every-minutes(n=15)')
  })

  it('describes a weekday, treating 7 as Sunday', () => {
    expect(describeCron('0 9 * * 1', t)).toBe(
      'executions.cron.weekly-at(weekday=executions.weekday-1,time=09:00)'
    )
    expect(describeCron('0 9 * * 7', t)).toBe(
      'executions.cron.weekly-at(weekday=executions.weekday-0,time=09:00)'
    )
    expect(weekdayKey(7)).toBe('executions.weekday-0')
  })

  it('describes a day of month', () => {
    expect(describeCron('5 4 1 * *', t)).toBe('executions.cron.monthly-at(day=1,time=04:05)')
  })

  it('tolerates irregular whitespace between fields', () => {
    expect(describeCron('  30   2  *  *  * ', t)).toBe('executions.cron.daily-at(time=02:30)')
  })

  it('returns the raw string for shapes it does not recognise', () => {
    // A restricted month is outside the recognised set.
    expect(describeCron('0 0 1 6 *', t)).toBe('0 0 1 6 *')
    // Day-of-month AND day-of-week both restricted — cron ORs them; don't guess.
    expect(describeCron('0 0 1 * 1', t)).toBe('0 0 1 * 1')
    // Lists, ranges and steps in the hour field.
    expect(describeCron('0 9-17 * * *', t)).toBe('0 9-17 * * *')
    expect(describeCron('0 1,13 * * *', t)).toBe('0 1,13 * * *')
    expect(describeCron('0 */2 * * *', t)).toBe('0 */2 * * *')
    // Out-of-range numbers.
    expect(describeCron('0 25 * * *', t)).toBe('0 25 * * *')
    // Wrong field count.
    expect(describeCron('30 2 * *', t)).toBe('30 2 * *')
    expect(describeCron('30 2 * * * extra', t)).toBe('30 2 * * * extra')
    expect(describeCron('', t)).toBe('')
  })
})

describe('describeLaunchAgentSchedule', () => {
  it('prefers StartInterval and picks the coarsest exact unit', () => {
    expect(describeLaunchAgentSchedule(agent({ start_interval: 86400 }), t)).toBe(
      'executions.agent.every-hours(n=24)'
    )
    expect(describeLaunchAgentSchedule(agent({ start_interval: 300 }), t)).toBe(
      'executions.agent.every-minutes(n=5)'
    )
    expect(describeLaunchAgentSchedule(agent({ start_interval: 90 }), t)).toBe(
      'executions.agent.every-seconds(n=90)'
    )
  })

  it('falls through to StartCalendarInterval', () => {
    expect(
      describeLaunchAgentSchedule(agent({ start_calendar: [{ Hour: 3, Minute: 0 }] }), t)
    ).toBe('executions.agent.daily-at(time=03:00)')
    expect(
      describeLaunchAgentSchedule(agent({ start_calendar: [{ Hour: 9, Minute: 30, Weekday: 2 }] }), t)
    ).toBe('executions.agent.weekly-at(weekday=executions.weekday-2,time=09:30)')
  })

  it('marks an absent Hour rather than inventing midnight', () => {
    expect(describeLaunchAgentSchedule(agent({ start_calendar: [{ Minute: 15 }] }), t)).toBe(
      'executions.agent.daily-at(time=**:15)'
    )
  })

  it('falls through to KeepAlive, then RunAtLoad, then unknown', () => {
    expect(describeLaunchAgentSchedule(agent({ keep_alive: true, run_at_load: true }), t)).toBe(
      'executions.agent.keep-alive'
    )
    expect(describeLaunchAgentSchedule(agent({ run_at_load: true }), t)).toBe(
      'executions.agent.run-at-load'
    )
    expect(describeLaunchAgentSchedule(agent(), t)).toBe('executions.agent.unknown')
  })
})

describe('describeLaunchAgentSchedule — date-narrowed calendars', () => {
  // Saying "every day at 04:00" for a job that runs on the 1st of the month is
  // confidently wrong, which this module exists to avoid.
  it('does not claim "daily" when StartCalendarInterval pins a Day', () => {
    expect(
      describeLaunchAgentSchedule(agent({ start_calendar: [{ Day: 1, Hour: 4 }] }), t)
    ).toBe('executions.agent.calendar')
  })

  it('does not claim "daily" when StartCalendarInterval pins a Month', () => {
    expect(
      describeLaunchAgentSchedule(agent({ start_calendar: [{ Month: 1, Hour: 4 }] }), t)
    ).toBe('executions.agent.calendar')
  })

  it('still describes the Hour/Minute-only shape exactly', () => {
    expect(
      describeLaunchAgentSchedule(agent({ start_calendar: [{ Hour: 3, Minute: 5 }] }), t)
    ).toBe('executions.agent.daily-at(time=03:05)')
  })
})
