import { expect, test as base, type APIRequestContext, type Page } from '@playwright/test'
import { getE2EEnv, type E2ERuntimeEnv } from './env'

type SmokeFixtures = {
    e2eEnv: E2ERuntimeEnv
    authenticatedPage: Page
    api: APIRequestContext
}

export const test = base.extend<SmokeFixtures>({
    e2eEnv: async ({}, use) => {
        await use(getE2EEnv())
    },

    api: async ({ playwright, e2eEnv }, use) => {
        const request = await playwright.request.newContext({
            baseURL: e2eEnv.mockApiUrl,
            extraHTTPHeaders: {
                'content-type': 'application/json',
            },
        })
        await use(request)
        await request.dispose()
    },

    authenticatedPage: async ({ page, e2eEnv }, use) => {
        await page.addInitScript((mockApiUrl) => {
            window.localStorage.setItem('yr_server_url', mockApiUrl)
        }, e2eEnv.mockApiUrl)

        await page.goto('/login')
        await page.getByRole('button', { name: 'Continue with SSO' }).click()
        await expect(page).toHaveURL(/\/sessions/)
        await expect(page.getByText('P0 Smoke Session')).toBeVisible()
        await use(page)
    },
})

export { expect }
