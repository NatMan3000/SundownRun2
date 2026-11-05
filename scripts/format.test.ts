import { expect, test } from 'bun:test'
import { formatTimeOfDay, timeOfDayClock } from '../src/ui/format'

test('time of day is a clock time, never the 0 to 1 number', () => {
  expect(timeOfDayClock(0)).toBe('6:00 pm')
  expect(timeOfDayClock(0.5)).toBe('9:00 pm')
  expect(timeOfDayClock(1)).toBe('12:00 am')
  expect(formatTimeOfDay(0.25)).toBe('Dusk, 7:30 pm')
  expect(formatTimeOfDay(0)).toBe('Sundown, 6:00 pm')
  expect(formatTimeOfDay(1)).toBe('Night, 12:00 am')
  expect(formatTimeOfDay(0.37)).not.toMatch(/0\.37/)
})
