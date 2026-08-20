import { expect, test } from '@playwright/test'

test('landing page renders in Bahasa Indonesia', async ({ page }) => {
  await page.goto('/')

  await expect(page.locator('html')).toHaveAttribute('lang', 'id')
  await expect(page.getByRole('heading', { level: 1 })).toContainText('AI sales agent')
  await expect(page.getByRole('link', { name: 'Masuk' })).toBeVisible()
})

test('an unauthenticated visit to a workspace redirects to login', async ({ page }) => {
  await page.goto('/app/demo/dashboard')

  await expect(page).toHaveURL(/\/login\?next=/)
  await expect(page.getByRole('heading', { name: 'Masuk ke akun Anda' })).toBeVisible()
})

test('health endpoint answers', async ({ request }) => {
  const response = await request.get('/api/health')

  expect(response.ok()).toBe(true)
  expect(await response.json()).toEqual({ ok: true, service: 'sora' })
})
