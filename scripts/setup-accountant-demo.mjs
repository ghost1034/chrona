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
    'NULL',
    0
  ].join(', ')})`
}).join(',\n')

const ratingValues = cards.map((item) => {
  const focused = item.category === 'Billable' || item.title === 'Redwood client call and follow-up'
  return `(${epoch(item.start)}, ${epoch(item.end)}, ${sqlQuote(focused ? 'focus' : 'neutral')})`
}).join(',\n')

const demoStart = epoch(cards[0].start)
const demoEnd = epoch(cards.at(-1).end)
const sql = `
PRAGMA foreign_keys = ON;
BEGIN IMMEDIATE;
DELETE FROM timeline_review_ratings
WHERE start_ts >= ${demoStart} AND end_ts <= ${demoEnd};
DELETE FROM timeline_cards
WHERE metadata LIKE '%"demo":"${DEMO_TAG}"%';
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

function sqlQuote(value) {
  if (value === null || value === undefined) return 'NULL'
  return `'${String(value).replaceAll("'", "''")}'`
}
