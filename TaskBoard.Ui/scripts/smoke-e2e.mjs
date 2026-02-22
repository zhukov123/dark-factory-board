import { chromium } from 'playwright'

const apiBaseUrl = 'http://localhost:5005'
const uiBaseUrl = 'http://localhost:5173' // Vite dev server when using run-dev.sh
const token = 'dev-token'
const runId = Date.now()
const titleOne = `E2E ${runId} A`
const titleTwo = `E2E ${runId} B`
const updatedTitleOne = `${titleOne} Updated`

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function poll(check, description, timeoutMs = 15000, intervalMs = 300) {
  const start = Date.now()
  let lastValue
  while (Date.now() - start < timeoutMs) {
    lastValue = await check()
    if (lastValue) {
      return
    }
    await sleep(intervalMs)
  }
  throw new Error(`Timed out waiting for: ${description}. Last value: ${JSON.stringify(lastValue)}`)
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

async function findTicketByTitle(title) {
  const result = await api(`/tickets?q=${encodeURIComponent(title)}&limit=50`)
  const items = result.items ?? result
  const list = Array.isArray(items) ? items : []
  return list.find((ticket) => ticket.title === title) ?? null
}

async function dragTicketToStatus(page, ticketId, status) {
  const source = page
    .locator('.ticket-card')
    .filter({ has: page.locator('.ticket-button', { hasText: new RegExp(`^${ticketId}\\b`) }) })
    .first()
  await source.waitFor({ state: 'visible', timeout: 10000 })
  await source.scrollIntoViewIfNeeded()

  const target = page
    .locator('.kanban-column')
    .filter({ has: page.locator('h3', { hasText: new RegExp(`^${status}\\s`) }) })
    .first()
  await target.waitFor({ state: 'visible', timeout: 10000 })
  await target.scrollIntoViewIfNeeded()

  const sourceBox = await source.boundingBox()
  const targetBox = await target.boundingBox()

  if (!sourceBox || !targetBox) {
    throw new Error(`Could not get drag bounds for ${ticketId} -> ${status}`)
  }

  const sourceX = sourceBox.x + sourceBox.width / 2
  const sourceY = sourceBox.y + sourceBox.height / 2
  const targetPoints = [
    {
      x: targetBox.x + targetBox.width / 2,
      y: targetBox.y + Math.min(90, targetBox.height / 3),
    },
    {
      x: targetBox.x + targetBox.width / 2,
      y: targetBox.y + targetBox.height - 24,
    },
  ]

  for (const point of targetPoints) {
    await page.mouse.move(sourceX, sourceY)
    await page.mouse.down()
    await page.mouse.move(sourceX + 8, sourceY + 8, { steps: 4 })
    await page.mouse.move(point.x, point.y, { steps: 24 })
    await page.mouse.up()
    await page.waitForTimeout(250)
  }
}

async function openTicketDetail(page, ticketId, searchText) {
  const detail = page
    .locator('section.panel')
    .filter({ has: page.locator('h2', { hasText: `Ticket Detail: ${ticketId}` }) })
  const filtersSection = page
    .locator('section.panel')
    .filter({ has: page.locator('h2', { hasText: 'Filters' }) })
  const searchInput = filtersSection.getByLabel('Search')

  for (let attempt = 0; attempt < 4; attempt += 1) {
    await searchInput.fill(searchText)
    await page.waitForTimeout(300)

    const button = page.locator('.ticket-button', { hasText: new RegExp(`^${ticketId}\\b`) }).first()
    await button.waitFor({ state: 'visible', timeout: 10000 })
    await button.evaluate((element) => {
      element.click()
    })

    try {
      await detail.waitFor({ state: 'visible', timeout: 4000 })
      return detail
    } catch {
      await page.waitForTimeout(250)
    }
  }

  throw new Error(`Could not open ticket detail for ${ticketId}`)
}

async function main() {
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext()
  await context.addInitScript(
    ({ providedToken }) => {
      localStorage.setItem('taskboard_token', providedToken)
      localStorage.setItem('taskboard_api_base_url', '') // same origin = Vite proxy to API
    },
    { providedToken: token },
  )

  const page = await context.newPage()
  await page.goto(uiBaseUrl, { waitUntil: 'networkidle' })
  await page.evaluate((t) => {
    localStorage.setItem('taskboard_token', t)
    localStorage.setItem('taskboard_api_base_url', '')
  }, token)
  await page.reload({ waitUntil: 'networkidle' })
  await page.locator('h1', { hasText: 'TaskBoard' }).first().waitFor({ timeout: 10000 })
  await page.locator('.kanban-column').first().waitFor({ state: 'visible', timeout: 10000 })

  await page.getByRole('button', { name: '+ New Ticket' }).click()
  const createSection = page.locator('section.panel').filter({ has: page.locator('h2', { hasText: 'New Ticket' }) })
  await createSection.waitFor({ state: 'visible', timeout: 5000 })
  const createButton = createSection.getByRole('button', { name: 'Create' })

  await createSection.getByLabel('Title').fill(titleOne)
  await createSection.getByLabel('Status').selectOption('Backlog')
  await createSection.getByLabel('Priority').fill('3')
  await createSection.getByLabel('Repo').fill('repo-e2e')
  await poll(async () => createButton.isEnabled(), 'create button enabled for first ticket')
  await createButton.click()
  await poll(async () => (await findTicketByTitle(titleOne)) !== null, 'first ticket created via API')

  await page.getByRole('button', { name: '+ New Ticket' }).click()
  await createSection.waitFor({ state: 'visible', timeout: 5000 })
  await createSection.getByLabel('Title').fill(titleTwo)
  await createSection.getByLabel('Status').selectOption('Ready')
  await createSection.getByLabel('Priority').fill('5')
  await createSection.getByLabel('Repo').fill('repo-e2e')
  await poll(async () => createButton.isEnabled(), 'create button enabled for second ticket')
  await createButton.click()

  let ticketOne = null
  let ticketTwo = null

  await poll(async () => {
    ticketOne = await findTicketByTitle(titleOne)
    ticketTwo = await findTicketByTitle(titleTwo)
    return Boolean(ticketOne && ticketTwo)
  }, 'created tickets to appear via API')

  if (!ticketOne || !ticketTwo) {
    throw new Error('Could not resolve created ticket ids')
  }

  await page.locator('.kanban-column').first().scrollIntoViewIfNeeded().catch(() => {})
  await page.waitForTimeout(1000)
  await poll(
    async () => {
      const card = page.locator('.ticket-card').filter({
        has: page.locator('.ticket-button', { hasText: new RegExp(`^${ticketOne.id}\\b`) }),
      }).first()
      return (await card.count()) > 0 && (await card.isVisible())
    },
    'ticket one card visible on board',
    20000,
  )
  await dragTicketToStatus(page, ticketOne.id, 'Ready')

  await poll(async () => {
    const current = await api(`/tickets/${ticketOne.id}`)
    return current.status === 'Ready'
  }, 'ticket one transitioned to Ready after drag')

  const detailSection = await openTicketDetail(page, ticketOne.id, titleOne)
  await detailSection.getByLabel('Title').fill(updatedTitleOne)
  await detailSection.getByRole('button', { name: 'Save Ticket' }).click()

  await poll(async () => {
    const current = await api(`/tickets/${ticketOne.id}`)
    return current.title === updatedTitleOne
  }, 'ticket one title updated')

  // Post a ticket update (activity) and verify it appears
  const activityInput = detailSection.locator('.activity-post input[type="text"]').first()
  await activityInput.waitFor({ state: 'visible', timeout: 5000 })
  await activityInput.fill('Started working')
  await detailSection.getByRole('button', { name: 'Post' }).click()
  await poll(
    async () => {
      const events = await api(`/events?ticket_id=${encodeURIComponent(ticketOne.id)}&limit=50`)
      return events.some((e) => e.type === 'ticket.update' && e.payload?.message === 'Started working')
    },
    'ticket update event persisted via API',
  )
  await page.waitForTimeout(500)
  await detailSection.locator('.activity-message', { hasText: 'Started working' }).waitFor({ state: 'visible', timeout: 5000 })

  const secondDetailSection = await openTicketDetail(page, ticketTwo.id, titleTwo)
  const filtersSection = page
    .locator('section.panel')
    .filter({ has: page.locator('h2', { hasText: 'Filters' }) })
  await filtersSection.getByLabel('Search').fill('')
  await page.waitForTimeout(300)
  await poll(
    async () =>
      (await secondDetailSection
        .locator(`select[multiple] option[value=\"${ticketOne.id}\"]`)
        .count()) > 0,
    'dependency option includes blocker ticket',
  )

  await secondDetailSection.locator('select[multiple]').selectOption(ticketOne.id)
  await secondDetailSection.getByRole('button', { name: 'Save Dependencies' }).click()

  await poll(async () => {
    const deps = await api(`/tickets/${ticketTwo.id}/deps`)
    return deps.blocked_by.includes(ticketOne.id)
  }, 'ticket two dependency set to ticket one')

  const eligibleBeforeDone = await api('/eligible?repo=repo-e2e')
  const beforeIds = new Set(eligibleBeforeDone.map((ticket) => ticket.ticket_id))
  if (beforeIds.has(ticketTwo.id)) {
    throw new Error('ticket two was eligible before blocker was done')
  }

  await dragTicketToStatus(page, ticketOne.id, 'Done')

  await poll(async () => {
    const current = await api(`/tickets/${ticketOne.id}`)
    return current.status === 'Done'
  }, 'ticket one transitioned to Done after drag')

  await poll(async () => {
    const eligibleAfterDone = await api('/eligible?repo=repo-e2e')
    return eligibleAfterDone.some((ticket) => ticket.ticket_id === ticketTwo.id)
  }, 'ticket two became eligible after blocker done')

  await openTicketDetail(page, ticketOne.id, updatedTitleOne)
  await poll(async () => {
    const events = await api(`/events?ticket_id=${encodeURIComponent(ticketOne.id)}&limit=100`)
    return events.some((event) => event.type === 'ticket.transition')
  }, 'ticket transition event persisted')

  await browser.close()

  console.log(JSON.stringify({
    ok: true,
    ticketOneId: ticketOne.id,
    ticketTwoId: ticketTwo.id,
    updatedTitleOne,
  }))
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
