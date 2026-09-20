import { base64Encode } from "@opencode/util/encode"
import { expect, test, type Page } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"
import { installSseTransport } from "../utils/sse-transport"
import { expectSessionTitle } from "../utils/waits"

const directory = "/workspace/review-loading"
const projectID = "proj_review_loading"
const sessionID = "ses_review_loading"
const title = "Review loading"
const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`

for (const width of [390, 1440]) {
  test(`shows an empty review for a non-git folder at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await setup(page)
    const requests: string[] = []
    await page.route("**/api/vcs/diff**", async (route) => {
      requests.push(route.request().url())
      await route.fallback()
    })

    await openSession(page)
    const review = await openReview(page)
    await expect(review.getByText("Loading changes…", { exact: true })).toHaveCount(0)
    await expect(
      review.getByText(width < 768 ? "No uncommitted changes yet" : "No file changes yet", { exact: true }),
    ).toBeVisible()
    await expect(review.getByText("Loading", { exact: true })).toHaveCount(0)
    expect(requests).toEqual([])
  })
}

for (const branch of ["main", undefined]) {
  test(`keeps the initial git request loading until an empty ${branch ? "repository" : "unborn repository"} resolves`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await setup(page, "git")
    await page.route(/\/api\/vcs(?:\?.*)?$/, (route) =>
      route.fulfill({ json: { location: { directory }, data: { branch: { current: branch, default: branch } } } }),
    )
    const response = Promise.withResolvers<void>()
    await page.route("**/api/vcs/diff**", async (route) => {
      await response.promise
      await route.fulfill({ json: { location: { directory }, data: [] } })
    })
    const request = page.waitForRequest("**/api/vcs/diff**")
    await openSession(page)
    const review = await openReview(page)
    await request
    await expect(review.getByText("Loading changes…", { exact: true })).toBeVisible()
    await expect(review.getByText("No file changes yet", { exact: true })).toHaveCount(0)

    response.resolve()
    await expect(review.getByText("No file changes yet", { exact: true })).toBeVisible()
    await expect(review.getByText("Loading changes…", { exact: true })).toHaveCount(0)
  })
}

test("keeps a git review pending while the server connection is suspended", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const transport = await installSseTransport(page, { server })
  await setup(page, "git")
  const requests: string[] = []
  await page.route("**/api/vcs/diff**", async (route) => {
    requests.push(route.request().url())
    await route.fallback()
  })
  await openSession(page)
  await transport.waitForConnection()
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide")))
  await expect.poll(async () => (await transport.connections())[0]?.endedBy).toBe("abort")

  const review = await openReview(page)
  await expect(review.getByText("Loading changes…", { exact: true })).toBeVisible()
  await expect(review.getByText("No file changes yet", { exact: true })).toHaveCount(0)
  expect(requests).toEqual([])

  const request = page.waitForRequest("**/api/vcs/diff**")
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow")))
  await request
  await expect(review.getByText("No file changes yet", { exact: true })).toBeVisible()
  await expect(review.getByText("Loading changes…", { exact: true })).toHaveCount(0)
})

async function openSession(page: Page) {
  await page.goto(`/server/${base64Encode(server)}/session/${sessionID}`)
  await expectSessionTitle(page, title)
}

async function openReview(page: Page) {
  if ((page.viewportSize()?.width ?? 1280) < 768) {
    const changes = page.getByRole("tab", { name: "Changes", exact: true })
    await changes.click()
    await expect(changes).toHaveAttribute("aria-selected", "true")
    return page.locator('[data-component="session-review"]')
  }
  const toggle = page.getByRole("button", { name: "Toggle review", exact: true })
  await toggle.click()
  await expect(toggle).toHaveAttribute("aria-expanded", "true")
  return page.locator("#review-panel")
}

async function setup(page: Page, vcs?: "git") {
  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs,
      name: "review-loading",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: { all: [], connected: [], default: {} },
    sessions: [
      {
        id: sessionID,
        projectID,
        directory,
        title,
        time: { created: 1700000000000, updated: 1700000000000 },
      },
    ],
    pageMessages: () => ({ items: [] }),
  })
}
