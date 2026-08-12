import { expect, test } from '@playwright/test';

test('the shell boots and shows the intro phase', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'PRINTHEAD' })).toBeVisible();
  await expect(page.getByTestId('phase')).toHaveText('intro');
});
