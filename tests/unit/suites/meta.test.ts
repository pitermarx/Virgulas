import { describe, it } from 'bun:test'
import { parseMeta, formatMeta, isOverdue, formatDueDate, advanceDueDate, isFutureDue, daysUntilDue } from '../../../source/js/meta.js'
import { assert, assertEqual } from '../testing.js'

// ─── harness ──────────────────────────────────────────────────────────────────

// ─── tests ────────────────────────────────────────────────────────────────────


describe("parseMeta", () => {

  it("extracts due:yyyy-MM-dd from end of text", () => {
      const { meta, text } = parseMeta("Buy milk due:2026-08-05")
      assertEqual(meta.due, '2026-08-05', "due should be extracted")
      assertEqual(text, 'Buy milk', "residual text should have token stripped")
  })

  it("metadata in the middle is not extracted (trailing token stops scan)", () => {
      const { meta, text } = parseMeta("Buy due:2026-08-05 milk")
      assertEqual(Object.keys(meta).length, 0, "due in middle should not be extracted")
      assertEqual(text, 'Buy due:2026-08-05 milk', "text should be unchanged")
  })

  it("text without metadata returns empty meta and unchanged text", () => {
      const { meta, text } = parseMeta("Just a note")
      assertEqual(Object.keys(meta).length, 0, "meta should be empty")
      assertEqual(text, 'Just a note', "text should be unchanged")
  })

  it("empty text returns empty meta and empty text", () => {
      const { meta, text } = parseMeta("")
      assertEqual(Object.keys(meta).length, 0, "meta should be empty")
      assertEqual(text, '', "text should be empty")
  })

  it("rejects invalid date format (due:tomorrow)", () => {
      const { meta, text } = parseMeta("Task due:tomorrow")
      assertEqual(Object.keys(meta).length, 0, "invalid due should not be extracted")
      assertEqual(text, 'Task due:tomorrow', "text should be unchanged")
  })

  it("rejects invalid date format (due:2026/08/05)", () => {
      const { meta, text } = parseMeta("Task due:2026/08/05")
      assertEqual(Object.keys(meta).length, 0, "invalid due should not be extracted")
      assertEqual(text, 'Task due:2026/08/05', "text should be unchanged")
  })

  it("rejects invalid date format (due:2026-8-5)", () => {
      const { meta, text } = parseMeta("Task due:2026-8-5")
      assertEqual(Object.keys(meta).length, 0, "invalid due should not be extracted")
      assertEqual(text, 'Task due:2026-8-5', "text should be unchanged")
  })

  it("rejects invalid calendar dates", () => {
      const { meta, text } = parseMeta("Task due:2026-02-30")
      assertEqual(Object.keys(meta).length, 0, "invalid calendar date should not be extracted")
      assertEqual(text, 'Task due:2026-02-30', "text should be unchanged")
  })

  it("first match wins — last on line wins", () => {
      const { meta, text } = parseMeta("Task due:2026-08-05 due:2026-08-06")
      assertEqual(meta.due, '2026-08-06', "last due on line should win")
      assertEqual(text, 'Task', "all extracted tokens removed from text")
  })

  it("stops at non-matching token after due", () => {
      const { meta, text } = parseMeta("Task due:2026-08-05 priority:high")
      assertEqual(Object.keys(meta).length, 0, "unregistered property stops scan before due")
      assertEqual(text, 'Task due:2026-08-05 priority:high', "text should be unchanged")
  })

  it("stops at tag after due", () => {
      const { meta, text } = parseMeta("Task due:2026-08-05 #todo")
      assertEqual(Object.keys(meta).length, 0, "tag stops scan before due")
      assertEqual(text, 'Task due:2026-08-05 #todo', "text should be unchanged")
  })

  it("stops at mention after due", () => {
      const { meta, text } = parseMeta("Task due:2026-08-05 @alice")
      assertEqual(Object.keys(meta).length, 0, "mention stops scan before due")
      assertEqual(text, 'Task due:2026-08-05 @alice', "text should be unchanged")
  })

  it("unregistered property is not extracted", () => {
      const { meta, text } = parseMeta("Task priority:low")
      assertEqual(Object.keys(meta).length, 0, "unregistered property should not be extracted")
      assertEqual(text, 'Task priority:low', "text should be unchanged")
  })

  it("due not at token boundary is not extracted", () => {
      const { meta, text } = parseMeta("Task due:2026-08-05x")
      assertEqual(Object.keys(meta).length, 0, "due with trailing chars should not be extracted")
      assertEqual(text, 'Task due:2026-08-05x', "text should be unchanged")
  })

  it("multiple due tokens all extracted, last wins", () => {
      const { meta, text } = parseMeta("Task due:2026-08-05 due:2026-08-06 due:2026-08-07")
      assertEqual(meta.due, '2026-08-07', "last due should win")
      assertEqual(text, 'Task', "all due tokens removed")
  })
})

describe("formatMeta", () => {

  it("formatMeta appends due to text", () => {
      const result = formatMeta("Buy milk", { due: '2026-08-05' })
      assertEqual(result, "Buy milk due:2026-08-05", "due should be appended")
  })

  it("formatMeta with empty meta returns text unchanged", () => {
      const result = formatMeta("Buy milk", {})
      assertEqual(result, "Buy milk", "text should be unchanged")
  })

  it("formatMeta round-trips with parseMeta", () => {
      const original = "Buy milk due:2026-08-05"
      const { meta, text } = parseMeta(original)
      assertEqual(formatMeta(text, meta), original, "round-trip should reproduce original")
  })
})

describe("isOverdue", () => {

  it("past date is overdue", () => {
      assert(isOverdue('2026-08-04', new Date('2026-08-05T12:00:00')), "yesterday should be overdue")
  })

  it("today is not overdue", () => {
      assert(!isOverdue('2026-08-05', new Date('2026-08-05T12:00:00')), "today should not be overdue")
  })

  it("future date is not overdue", () => {
      assert(!isOverdue('2026-08-06', new Date('2026-08-05T12:00:00')), "tomorrow should not be overdue")
  })

  it("invalid date is not overdue", () => {
      assert(!isOverdue('not-a-date', new Date('2026-08-05T12:00:00')), "invalid date should not be overdue")
  })
})

describe("formatDueDate", () => {

  it("formats yyyy-MM-dd to human-readable", () => {
      assertEqual(formatDueDate('2026-08-05', new Date('2026-08-05T12:00:00')), 'Aug 5', "should format to short date")
  })

  it("formats with year when not current year", () => {
      assertEqual(formatDueDate('2025-12-31', new Date('2026-08-05T12:00:00')), 'Dec 31, 2025', "should include year when different")
  })
})

describe("parseMeta — rec", () => {

  it("extracts rec:1m from end of text", () => {
      const { meta, text } = parseMeta("Pay bill due:2026-08-15 rec:1m")
      assertEqual(meta.rec, '1m', "rec should be extracted")
      assertEqual(meta.due, '2026-08-15', "due should be extracted")
      assertEqual(text, 'Pay bill', "residual text should have both tokens stripped")
  })

  it("rec before due is also extracted (order independent)", () => {
      const { meta, text } = parseMeta("Pay bill rec:1m due:2026-08-15")
      assertEqual(meta.rec, '1m', "rec should be extracted")
      assertEqual(meta.due, '2026-08-15', "due should be extracted")
      assertEqual(text, 'Pay bill', "residual text should have both tokens stripped")
  })

  it("rec without a count is valid (implicit count of 1)", () => {
      const { meta } = parseMeta("Task rec:d")
      assertEqual(meta.rec, 'd', "rec with no digits is valid")
  })

  it("rejects invalid rec unit", () => {
      const { meta, text } = parseMeta("Task rec:1x")
      assertEqual(Object.keys(meta).length, 0, "invalid unit should not be extracted")
      assertEqual(text, 'Task rec:1x', "text should be unchanged")
  })

  it("rec with no due is still parsed as metadata", () => {
      const { meta, text } = parseMeta("Task rec:1y")
      assertEqual(meta.rec, '1y', "rec should be extracted even without due")
      assertEqual(text, 'Task', "text should have rec stripped")
  })
})

describe("advanceDueDate", () => {

  it("advances by days", () => {
      assertEqual(advanceDueDate('2026-08-05', '3d'), '2026-08-08', "should add 3 days")
  })

  it("advances by weeks", () => {
      assertEqual(advanceDueDate('2026-08-05', '2w'), '2026-08-19', "should add 2 weeks")
  })

  it("advances by months, same day next month", () => {
      assertEqual(advanceDueDate('2026-08-05', '1m'), '2026-09-05', "should add 1 month, same day")
  })

  it("advances by months, clamps day overflow to last day of month", () => {
      assertEqual(advanceDueDate('2026-01-31', '1m'), '2026-02-28', "Jan 31 + 1m should clamp to Feb 28 (non-leap year)")
  })

  it("advances by months across year boundary", () => {
      assertEqual(advanceDueDate('2026-12-15', '2m'), '2027-02-15', "should roll over into next year")
  })

  it("advances by years, same day next year", () => {
      assertEqual(advanceDueDate('2026-08-05', '1y'), '2027-08-05', "should add 1 year, same day")
  })

  it("advances by years, clamps Feb 29 to Feb 28 in non-leap target year", () => {
      assertEqual(advanceDueDate('2028-02-29', '1y'), '2029-02-28', "leap day should clamp in non-leap year")
  })

  it("defaults count to 1 when omitted", () => {
      assertEqual(advanceDueDate('2026-08-05', 'm'), '2026-09-05', "rec:m should behave like rec:1m")
  })

  it("returns null for invalid due date", () => {
      assertEqual(advanceDueDate('not-a-date', '1m'), null, "invalid due should return null")
  })

  it("returns null for invalid rec string", () => {
      assertEqual(advanceDueDate('2026-08-05', '1x'), null, "invalid rec should return null")
  })
})

describe("isFutureDue", () => {

  it("true for a date after today", () => {
      assert(isFutureDue('2026-08-06', new Date('2026-08-05T12:00:00')), "tomorrow should be future")
  })

  it("false for today", () => {
      assert(!isFutureDue('2026-08-05', new Date('2026-08-05T12:00:00')), "today should not be future")
  })

  it("false for a past date", () => {
      assert(!isFutureDue('2026-08-04', new Date('2026-08-05T12:00:00')), "yesterday should not be future")
  })
})

describe("daysUntilDue", () => {

  it("returns 0 for today", () => {
      assertEqual(daysUntilDue('2026-08-05', new Date('2026-08-05T12:00:00')), 0, "today should be 0 days")
  })

  it("returns positive count for future date", () => {
      assertEqual(daysUntilDue('2026-08-08', new Date('2026-08-05T12:00:00')), 3, "3 days out")
  })

  it("returns negative count for past date", () => {
      assertEqual(daysUntilDue('2026-08-02', new Date('2026-08-05T12:00:00')), -3, "3 days overdue")
  })
})