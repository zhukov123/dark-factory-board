/**
 * Minimal e2e: create ticket via API, open UI, open ticket, post activity update, verify it appears.
 * Run with API on 5005 and UI on 5173 (e.g. ./scripts/run-dev.sh).
 */
import { chromium } from 'playwright'

const apiBaseUrl = 'http://localhost:5005'
const uiBaseUrl = 'http://localhost:5173'
const token = 'dev-token'
const runId = Date.now()
const title = `Activity E2E ${runId}`

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms))
}

async function api(path, init = {}) {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
  const text = await response.text()
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  if (!response.ok) {
    throw new Error(`API ${path} failed (${response.status}): ${JSON.stringify(body)}`)
  }
  return body
}

async function main() {
  const ticket = await api('/tickets', {
    method: 'POST',
    body: JSON.stringify({
      title,
      status: 'Ready',
      priority: 1,
      repo: 'repo-e2e',
      labels: [],
      acceptance_criteria: [],
      test_plan: '',
      description: '',
    }),
  })
  const ticketId = ticket.id
  console.log('Created ticket', ticketId)

  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext()
  const page = await context.newPage()

  await page.goto(uiBaseUrl, { waitUntil: 'networkidle' })
  await page.evaluate((t) => {
    localStorage.setItem('taskboard_token', t)
    localStorage.setItem('taskboard_api_base_url', '')
  }, token)
  await page.reload({ waitUntil: 'networkidle' })

  await page.locator('h1', { hasText: 'TaskBoard' }).first().waitFor({ timeout: 10000 })
  await page.locator('.kanban-column').first().waitFor({ state: 'visible', timeout: 10000 })
  await page.locator('.ticket-card').first().waitFor({ state: 'visible', timeout: 15000 })
  await page.waitForTimeout(1000)

  const card = page.locator('.ticket-card').filter({
    has: page.locator('.ticket-id', { hasText: new RegExp(`^${ticketId}$`) }),
  }).first()
  await card.scrollIntoViewIfNeeded()
  await card.waitFor({ state: 'visible', timeout: 10000 })
  await card.locator('.ticket-button').click()

  const detailSection = page.locator('.ticket-modal').filter({
    has: page.locator('.ticket-modal-id', { hasText: new RegExp(`^${ticketId}$`) }),
  })
  await detailSection.waitFor({ state: 'visible', timeout: 10000 })

  const activityInput = detailSection.locator('.activity-post input[type="text"]').first()
  await activityInput.waitFor({ state: 'visible', timeout: 5000 })
  await activityInput.fill('Started working')
  await detailSection.getByRole('button', { name: 'Post' }).click()

  await page.waitForTimeout(1000)
  await detailSection.locator('.activity-message', { hasText: 'Started working' }).waitFor({ state: 'visible', timeout: 10000 })

  console.log('Activity update visible in UI')
  await browser.close()
  console.log(JSON.stringify({ ok: true, ticketId }))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
