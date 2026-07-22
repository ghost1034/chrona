#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const APP_DATA = process.env.CHRONA_APP_DATA || path.join(os.homedir(), 'Library', 'Application Support', 'chrona')
const DEMO_DAY = process.env.CHRONA_DEMO_DAY || new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Los_Angeles',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
}).format(new Date())
const DEMO_TAG = 'chrona-accountant-demo'

const settingsPath = path.join(APP_DATA, 'settings.json')
const dbPath = path.join(APP_DATA, 'db', 'chrona.sqlite')

for (const requiredPath of [settingsPath, dbPath]) {
  if (!fs.existsSync(requiredPath)) throw new Error(`Chrona profile file not found: ${requiredPath}`)
}

const existingPlanDayTimelapse = execFileSync('sqlite3', [dbPath, `
SELECT COALESCE(video_summary_url, '')
FROM timeline_cards
WHERE is_deleted = 0 AND title = 'Plan the day and triage inbox'
ORDER BY id DESC
LIMIT 1;
`], { encoding: 'utf8' }).trim() || null

const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chrona-accountant-demo-backup-'))
fs.copyFileSync(settingsPath, path.join(backupDir, 'settings.json'))
fs.copyFileSync(dbPath, path.join(backupDir, 'chrona.sqlite'))

const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
settings.themePreference = 'light'
settings.categories = [
  {
    id: 'cat_billable',
    name: 'Billable',
    color: '#3BD4B2',
    description: 'Client work that can be billed to an engagement.',
    order: 10
  },
  {
    id: 'cat_non_billable',
    name: 'Non-billable',
    color: '#F2B84B',
    description: 'Firm administration, internal meetings, and other non-billable work.',
    order: 20
  },
  {
    id: 'cat_personal',
    name: 'Personal',
    color: '#63A9FF',
    description: 'Personal tasks, errands, and breaks.',
    order: 30
  },
  {
    id: 'cat_idle',
    name: 'Idle',
    color: '#BEC8D4',
    description: 'Inactivity (away, locked, or no visible interaction).',
    locked: true,
    order: 40
  }
]
settings.subcategories = [
  subcategory('sub_billable_harbor', 'cat_billable', 'Harbor Manufacturing', 10),
  subcategory('sub_billable_redwood', 'cat_billable', 'Redwood Dental Group', 20),
  subcategory('sub_billable_northstar', 'cat_billable', 'Northstar Ventures', 30),
  subcategory('sub_nonbill_admin', 'cat_non_billable', 'Firm Administration', 10),
  subcategory('sub_nonbill_meetings', 'cat_non_billable', 'Internal Meetings', 20)
]
settings.promptPreambleAsk = [
  'For this accountant demo, treat cards in the Billable category as billable time.',
  'For Billable cards, the subcategory is the client name.',
  'Calculate durations exactly from startTs and endTs.',
  'When asked for billable time by client, group Billable cards by subcategory, show each subtotal and the overall total, and cite the supporting cards.'
].join(' ')
settings.onboardingCompleted = true
// Keep capture usable for the on-camera health state while preventing a short
// recording session from generating overlapping cards on the staged day.
settings.captureIntervalSeconds = 30
settings.analysisCheckIntervalSeconds = 600
settings.analysisBatchTargetDurationSec = 4 * 60 * 60
settings.analysisMinBatchDurationSec = 4 * 60 * 60

const tempSettingsPath = `${settingsPath}.demo-${process.pid}.tmp`
fs.writeFileSync(tempSettingsPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 })
fs.renameSync(tempSettingsPath, settingsPath)

const cards = [
  card('08:30', '08:50', 'Non-billable', 'Firm Administration', 'Plan the day and triage inbox',
    'Reviewed overnight messages, prioritized client deadlines, and mapped the day\'s work.',
    'Reviewed new messages, identified the three client deadlines for the day, and organized the engagement queue before beginning client work.',
    'Outlook', 'CPAAutomation'),
  card('08:50', '10:20', 'Billable', 'Harbor Manufacturing', 'Reconcile Harbor Manufacturing operating accounts',
    'Matched bank activity to the general ledger and cleared reconciling items for the month-end close.',
    'Compared bank activity with the general ledger, investigated outstanding checks and deposits in transit, and cleared supported reconciling items. Flagged one duplicate vendor payment for client confirmation.',
    'Excel', 'NetSuite'),
  card('10:20', '10:35', 'Non-billable', 'Internal Meetings', 'Daily team check-in',
    'Confirmed engagement priorities, open questions, and ownership for the day.',
    'Reviewed the day\'s engagement priorities with the team, assigned follow-ups, and confirmed the review sequence for open client work.',
    'Microsoft Teams', null),
  card('10:35', '12:05', 'Billable', 'Harbor Manufacturing', 'Investigate inventory and freight variance',
    'Analyzed the month-over-month variance, traced freight postings, and documented the likely drivers.',
    'Compared current- and prior-month balances, traced freight-in entries to inventory receipts, and documented timing and volume as the primary variance drivers. Prepared a concise note for the close file.',
    'Excel', 'NetSuite'),
  card('12:05', '12:45', 'Personal', null, 'Lunch',
    'Stepped away for lunch.',
    'No client or firm work was performed during this interval.',
    null, null),
  card('12:45', '14:15', 'Billable', 'Redwood Dental Group', 'Review Redwood Dental tax workpapers',
    'Reviewed fixed-asset additions, tied supporting schedules, and noted follow-up items for the client.',
    'Reviewed fixed-asset additions against invoices and the depreciation schedule, tied totals to the trial balance, and prepared a short list of missing support.',
    'CCH Axcess', 'Excel'),
  card('14:15', '14:30', 'Non-billable', 'Firm Administration', 'Inbox and engagement administration',
    'Responded to internal messages and organized open engagement items.',
    'Updated internal engagement notes, cleared routine messages, and organized the remaining client follow-ups for the afternoon.',
    'Outlook', 'CPAAutomation'),
  card('14:30', '15:25', 'Non-billable', null, 'Redwood client call and follow-up',
    'Discussed missing fixed-asset support with the controller, then documented decisions and sent the request list.',
    'Met with the controller to resolve missing fixed-asset support and classification questions. Documented the agreed treatment and sent a follow-up request list.',
    'Microsoft Teams', 'Outlook'),
  card('15:25', '15:35', 'Idle', null, 'Away from computer',
    'No active computer use was detected.',
    'The computer was inactive during this interval.',
    null, null),
  card('15:35', '16:50', 'Billable', 'Northstar Ventures', 'Test Northstar expense samples',
    'Selected and tested operating-expense samples, linked support, and documented exceptions for review.',
    'Selected operating-expense samples, agreed amounts to invoices and approvals, linked the supporting documents, and documented two items for reviewer follow-up.',
    'Excel', 'CPAAutomation'),
  card('16:50', '17:20', 'Non-billable', 'Firm Administration', 'Finalize time notes and plan tomorrow',
    'Reviewed the day\'s activity, organized follow-ups, and set tomorrow\'s engagement priorities.',
    'Reviewed the completed client work, organized open requests, and set the next day\'s engagement priorities.',
    'CPAAutomation', 'Outlook')
]

const observations = [
  ...observationSequence('08:30', '08:50', 5, [
    step('Scanned overnight Outlook messages and identified the client items requiring action today.', 'Outlook'),
    step('Flagged the Harbor Manufacturing close message and noted the reconciliation deadline.', 'Outlook', 'CPAAutomation'),
    step('Reviewed the Redwood Dental request for fixed-asset support and added it to the engagement queue.', 'Outlook', 'CPAAutomation'),
    step('Checked the Northstar testing status and ordered the three client blocks in the day plan.', 'CPAAutomation', 'Outlook')
  ]),

  ...observationSequence('08:50', '10:20', 10, [
    step('Opened the Harbor Manufacturing operating-account reconciliation workbook and the NetSuite general-ledger export.', 'Excel', 'NetSuite'),
    step('Imported the latest bank activity and aligned statement dates with the reconciliation period.', 'Excel', 'NetSuite'),
    step('Matched cleared deposits from the bank statement to the corresponding general-ledger entries.', 'Excel', 'NetSuite'),
    step('Reviewed outstanding checks and marked the items supported by the prior reconciliation.', 'Excel', 'NetSuite'),
    step('Investigated a deposit in transit by tracing the receipt date and subsequent bank clearing date.', 'NetSuite', 'Excel'),
    step('Filtered the vendor-payment ledger and found two entries with the same amount and invoice reference.', 'NetSuite', 'Excel'),
    step('Compared the duplicate-looking entries with invoice support and isolated one item for client confirmation.', 'NetSuite', 'Excel'),
    step('Updated the reconciliation schedule with the supported items and the remaining open difference.', 'Excel', 'NetSuite'),
    step('Saved the Harbor workpaper and added a reviewer note describing the possible duplicate vendor payment.', 'Excel', 'NetSuite')
  ]),

  ...observationSequence('10:20', '10:35', 5, [
    step('Joined the daily team check-in in Microsoft Teams and opened the engagement-priority agenda.', 'Microsoft Teams'),
    step('Reported the Harbor reconciliation status and reviewed the Redwood and Northstar work planned for the afternoon.', 'Microsoft Teams', 'CPAAutomation'),
    step('Captured follow-up owners and confirmed the review sequence for the open client work.', 'Microsoft Teams', 'CPAAutomation')
  ]),

  ...observationSequence('10:35', '12:05', 10, [
    step('Opened the Harbor variance workbook and compared current-month inventory balances with the prior month.', 'Excel', 'NetSuite'),
    step('Calculated the month-over-month change and isolated freight-in as the largest variance component.', 'Excel', 'NetSuite'),
    step('Filtered NetSuite journal entries to the freight and inventory accounts for the close period.', 'NetSuite', 'Excel'),
    step('Reviewed the posting dates and descriptions for the largest freight entries.', 'NetSuite', 'Excel'),
    step('Traced selected freight postings to inventory receipts and receiving dates.', 'NetSuite', 'Excel'),
    step('Compared current shipment volume with the prior month to test the volume explanation.', 'Excel', 'NetSuite'),
    step('Separated the variance into timing and volume components in the analysis workbook.', 'Excel', 'NetSuite'),
    step('Drafted the month-end explanation and cited the supporting receipt and posting details.', 'Excel', 'NetSuite'),
    step('Reviewed the completed analysis for consistency and saved the note to the Harbor close file.', 'Excel', 'NetSuite')
  ]),

  ...observationSequence('12:05', '12:45', 10, [
    step('The screen showed no active interaction after the user stepped away for lunch.', null),
    step('The computer remained inactive with no visible application changes.', null),
    step('No keyboard or pointer activity was visible during the lunch interval.', null),
    step('The screen remained unchanged until the user returned at the end of the break.', null)
  ]),

  ...observationSequence('12:45', '14:15', 10, [
    step('Opened the Redwood Dental fixed-asset workpapers in CCH Axcess and reviewed the additions schedule.', 'CCH Axcess', 'Excel'),
    step('Compared the fixed-asset additions total with the related trial-balance accounts.', 'Excel', 'CCH Axcess'),
    step('Opened invoice support for the first group of additions and matched amounts and vendors.', 'CCH Axcess', 'Excel'),
    step('Reviewed the remaining addition invoices and flagged one item with incomplete support.', 'CCH Axcess', 'Excel'),
    step('Checked asset classifications against the invoice descriptions and the client capitalization policy.', 'Excel', 'CCH Axcess'),
    step('Verified placed-in-service dates and useful lives in the depreciation schedule.', 'Excel', 'CCH Axcess'),
    step('Recalculated the updated depreciation amounts and reviewed the current-year effect.', 'Excel', 'CCH Axcess'),
    step('Tied the revised fixed-asset schedule back to the Redwood trial balance.', 'Excel', 'CCH Axcess'),
    step('Compiled the missing-support and classification questions for client follow-up.', 'CCH Axcess', 'Excel')
  ]),

  ...observationSequence('14:15', '14:30', 5, [
    step('Scanned new Outlook messages and cleared routine internal responses.', 'Outlook'),
    step('Updated CPAAutomation engagement notes with the open Redwood support questions.', 'CPAAutomation', 'Outlook'),
    step('Organized the remaining afternoon follow-ups before joining the client call.', 'CPAAutomation', 'Outlook')
  ]),

  ...observationSequence('14:30', '15:25', 10, [
    step('Joined the Redwood Dental controller call in Microsoft Teams and opened the fixed-asset question list.', 'Microsoft Teams', 'CCH Axcess'),
    step('Reviewed the missing invoice support with the controller while referencing the workpaper schedule.', 'Microsoft Teams', 'CCH Axcess'),
    step('Discussed the classification of two equipment purchases and compared the proposed accounting treatment.', 'Microsoft Teams', 'CCH Axcess'),
    step('Confirmed which documents the controller would provide and summarized the agreed fixed-asset treatment.', 'Microsoft Teams', 'CCH Axcess'),
    step('Documented the call decisions and updated the Redwood workpaper follow-up notes.', 'CCH Axcess', 'Microsoft Teams'),
    step('Sent the controller a concise Outlook request list with the missing support and agreed next steps.', 'Outlook', 'Microsoft Teams')
  ]),

  ...observationSequence('15:25', '15:35', 5, [
    step('No active interaction was visible after the client follow-up was sent.', null),
    step('The computer remained idle until work resumed on the Northstar engagement.', null)
  ]),

  ...observationSequence('15:35', '16:50', 10, [
    step('Opened the Northstar Ventures operating-expense population and the sampling worksheet.', 'Excel', 'CPAAutomation'),
    step('Applied the sampling criteria and reviewed the resulting expense population for completeness.', 'Excel', 'CPAAutomation'),
    step('Selected the operating-expense samples and recorded the selections in the testing sheet.', 'Excel', 'CPAAutomation'),
    step('Agreed the first group of sample amounts to vendor invoices and payment support.', 'Excel', 'CPAAutomation'),
    step('Verified approval evidence and business purpose for the remaining selected samples.', 'CPAAutomation', 'Excel'),
    step('Linked the supporting invoices and approvals to the corresponding sample rows.', 'CPAAutomation', 'Excel'),
    step('Documented two exceptions and described the additional evidence needed from the client.', 'CPAAutomation', 'Excel'),
    step('Reviewed the completed Northstar testing sheet and prepared the exceptions for reviewer follow-up.', 'Excel', 'CPAAutomation')
  ]),

  ...observationSequence('16:50', '17:20', 10, [
    step('Reviewed the completed client blocks in CPAAutomation and checked that each engagement had clear time notes.', 'CPAAutomation', 'Outlook'),
    step('Organized the outstanding Harbor, Redwood, and Northstar requests and assigned the next follow-up dates.', 'CPAAutomation', 'Outlook'),
    step('Updated tomorrow\'s priority list and sent final internal status messages in Outlook.', 'Outlook', 'CPAAutomation')
  ])
]

const epoch = (clock) => {
  const [year, month, day] = DEMO_DAY.split('-').map(Number)
  const [hour, minute] = clock.split(':').map(Number)
  // This script is executed with TZ=America/Los_Angeles so local Date math
  // matches Chrona's device-local logical day.
  return Math.floor(new Date(year, month - 1, day, hour, minute, 0, 0).getTime() / 1000)
}

const clockLabel = (clock) => {
  const [hourText, minute] = clock.split(':')
  const hour = Number(hourText)
  const suffix = hour < 12 ? 'AM' : 'PM'
  const hour12 = hour % 12 || 12
  return `${hour12}:${minute} ${suffix}`
}

const values = cards.map((item) => {
  const metadata = JSON.stringify({
    demo: DEMO_TAG,
    appSites: { primary: item.primary, secondary: item.secondary }
  })
  return `(${[
    'NULL',
    sqlQuote(clockLabel(item.start)),
    sqlQuote(clockLabel(item.end)),
    epoch(item.start),
    epoch(item.end),
    sqlQuote(DEMO_DAY),
    sqlQuote(item.title),
    sqlQuote(item.summary),
    sqlQuote(item.category),
    sqlQuote(item.subcategory),
    sqlQuote(item.details),
    sqlQuote(metadata),
    item.title === 'Plan the day and triage inbox'
      ? sqlQuote(existingPlanDayTimelapse)
      : 'NULL',
    0
  ].join(', ')})`
}).join(',\n')

const ratingValues = cards.map((item) => {
  const focused = item.category === 'Billable' || item.title === 'Redwood client call and follow-up'
  return `(${epoch(item.start)}, ${epoch(item.end)}, ${sqlQuote(focused ? 'focus' : 'neutral')})`
}).join(',\n')

const observationValues = observations.map((item) => {
  const metadata = JSON.stringify({
    demo: DEMO_TAG,
    appSites: { primary: item.primary, secondary: item.secondary }
  })
  return `(
    (SELECT id FROM analysis_batches WHERE reason = ${sqlQuote(`demo_observations:${DEMO_TAG}`)} ORDER BY id DESC LIMIT 1),
    ${epoch(item.start)},
    ${epoch(item.end)},
    ${sqlQuote(item.text)},
    ${sqlQuote(metadata)},
    ${sqlQuote(settings.geminiModel || 'gemini-3.5-flash')}
  )`
}).join(',\n')

const demoStart = epoch(cards[0].start)
const demoEnd = epoch(cards.at(-1).end)
const sql = `
PRAGMA foreign_keys = ON;
BEGIN IMMEDIATE;
DELETE FROM analysis_batches
WHERE reason = ${sqlQuote(`demo_observations:${DEMO_TAG}`)};
DELETE FROM timeline_review_ratings
WHERE start_ts >= ${demoStart} AND end_ts <= ${demoEnd};
DELETE FROM timeline_cards
WHERE metadata LIKE '%"demo":"${DEMO_TAG}"%';
INSERT INTO analysis_batches (
  batch_start_ts, batch_end_ts, status, reason, llm_metadata, detailed_transcription
) VALUES (
  ${demoStart},
  ${demoEnd},
  'analyzed',
  ${sqlQuote(`demo_observations:${DEMO_TAG}`)},
  ${sqlQuote(JSON.stringify({ demo: DEMO_TAG, observationCount: observations.length }))},
  'Structured observations for the accountant billable-time demonstration.'
);
INSERT INTO observations (
  batch_id, start_ts, end_ts, observation, metadata, llm_model
) VALUES
${observationValues};
INSERT INTO timeline_cards (
  batch_id, start, end, start_ts, end_ts, day, title, summary,
  category, subcategory, detailed_summary, metadata, video_summary_url, is_deleted
) VALUES
${values};
INSERT INTO timeline_review_ratings (start_ts, end_ts, rating) VALUES
${ratingValues};
INSERT OR IGNORE INTO journal_entries (
  day, intentions, notes, reflections, summary, status
) VALUES (
  ${sqlQuote(DEMO_DAY)},
  'Protect focused blocks for Harbor, Redwood, and Northstar client work.',
  'Follow up on the Harbor duplicate payment and the two Northstar sample exceptions.',
  'The day stayed focused, and the reconstructed timeline made the client allocation easy to verify.',
  'Completed 6h 40m of billable client work across three engagements.',
  'complete'
);
COMMIT;
`

execFileSync('sqlite3', [dbPath], { input: sql, stdio: ['pipe', 'pipe', 'pipe'] })

const verification = execFileSync('sqlite3', [dbPath, `
SELECT category || '|' || COUNT(*) || '|' || SUM(end_ts-start_ts)
FROM timeline_cards
WHERE is_deleted = 0 AND day = '${DEMO_DAY}'
GROUP BY category
ORDER BY category;
`], { encoding: 'utf8' }).trim()

const manifest = {
  demoDay: DEMO_DAY,
  backupDir,
  appData: APP_DATA,
  cards: cards.length,
  observations: observations.length,
  deliberateCorrection: {
    title: 'Redwood client call and follow-up',
    from: { category: 'Non-billable', subcategory: null },
    to: { category: 'Billable', subcategory: 'Redwood Dental Group' }
  },
  verification: verification.split('\n').filter(Boolean)
}
fs.writeFileSync(path.join(backupDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`)

function subcategory(id, categoryId, name, order) {
  return {
    id,
    categoryId,
    name,
    color: categoryId === 'cat_billable' ? '#3BD4B2' : '#F2B84B',
    description: categoryId === 'cat_billable' ? `Billable work for ${name}.` : `${name} time.`,
    order
  }
}

function card(start, end, category, subcategory, title, summary, details, primary, secondary) {
  return { start, end, category, subcategory, title, summary, details, primary, secondary }
}

function observation(start, end, text, primary, secondary) {
  return { start, end, text, primary, secondary }
}

function step(text, primary, secondary = null) {
  return { text, primary, secondary }
}

function observationSequence(start, end, stepMinutes, entries) {
  const startMinutes = clockToMinutes(start)
  const endMinutes = clockToMinutes(end)
  const expectedEntries = Math.ceil((endMinutes - startMinutes) / stepMinutes)
  if (entries.length !== expectedEntries) {
    throw new Error(
      `Observation sequence ${start}-${end} requires ${expectedEntries} entries, received ${entries.length}`
    )
  }

  return entries.map((entry, index) => {
    const itemStart = startMinutes + index * stepMinutes
    const itemEnd = Math.min(endMinutes, itemStart + stepMinutes)
    return observation(
      minutesToClock(itemStart),
      minutesToClock(itemEnd),
      entry.text,
      entry.primary,
      entry.secondary
    )
  })
}

function clockToMinutes(clock) {
  const [hour, minute] = clock.split(':').map(Number)
  return hour * 60 + minute
}

function minutesToClock(totalMinutes) {
  const hour = Math.floor(totalMinutes / 60)
  const minute = totalMinutes % 60
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

function sqlQuote(value) {
  if (value === null || value === undefined) return 'NULL'
  return `'${String(value).replaceAll("'", "''")}'`
}
