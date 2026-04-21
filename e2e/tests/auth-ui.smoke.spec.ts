import { expect, test } from '../src/fixtures'

test.describe('P0 auth and session UI smoke', () => {
    test('completes fake Keycloak login and renders the session list', async ({ authenticatedPage, e2eEnv }) => {
        await expect(authenticatedPage).toHaveURL(/\/sessions/)
        await expect(authenticatedPage.getByText('P0 Smoke Session')).toBeVisible()
        await expect(authenticatedPage.getByText('P0 smoke session ready')).toBeVisible()

        const stateResponse = await authenticatedPage.request.get(`${e2eEnv.mockApiUrl}/__state`)
        expect(stateResponse.ok()).toBeTruthy()
        const state = await stateResponse.json() as { runId: string; sessions: Array<{ id: string }> }
        expect(state.runId).toBe(e2eEnv.runId)
        expect(state.sessions.length).toBeGreaterThan(0)
    })

    test('opens session detail, sends a message, receives SSE UI refresh, and shows downloads', async ({ authenticatedPage }) => {
        await authenticatedPage.getByText('P0 Smoke Session').click()
        await expect(authenticatedPage).toHaveURL(/\/sessions\/session-/)
        await expect(authenticatedPage.getByText('Initial fake agent response')).toBeVisible()

        const text = `E2E SSE refresh ${Date.now()}`
        await authenticatedPage.getByPlaceholder('Type a message...').fill(text)
        await authenticatedPage.getByRole('button', { name: 'Send' }).click()

        await expect(authenticatedPage.getByText(text)).toBeVisible()
        await expect(authenticatedPage.getByText(`Fake agent acknowledged: ${text}`)).toBeVisible()

        const downloadsButton = authenticatedPage.getByRole('button', { name: 'Downloads (2)' })
        await expect(downloadsButton).toBeVisible()
        await downloadsButton.click()
        await expect(authenticatedPage.getByText('smoke-report.txt')).toBeVisible()
        await expect(authenticatedPage.getByText('e2e-result.txt')).toBeVisible()
    })
})
