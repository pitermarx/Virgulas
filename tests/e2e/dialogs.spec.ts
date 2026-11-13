import { test, expect, type Page, setupDoc } from '../test';

// a11y-02: one focus contract for every dialog. A dialog takes focus when it
// opens, keeps Tab inside while it is modal, and hands focus back to whatever
// opened it when it closes.

/** True when the focused element sits inside the dialog with this label. */
const focusInside = (page: Page, labelledBy: string) =>
  page.evaluate((label) => !!document.activeElement?.closest(`[aria-labelledby="${label}"]`), labelledBy);

test.describe('dialog focus management', () => {
  test('Options takes focus, traps Tab and returns focus to its button on Escape', async ({ page }) => {
    await setupDoc(page, { id: 'root', text: 'Root', children: [{ id: 'n1', text: 'Node' }] });

    const opener = page.getByRole('button', { name: 'Options' });
    await opener.click();
    const dialog = page.getByRole('dialog', { name: 'Options' });
    await expect(dialog).toBeVisible();

    // Focus moved in without the user tabbing.
    await expect.poll(() => focusInside(page, 'options-title')).toBe(true);

    // The outline behind is inert while the dialog is open.
    expect(
      await page.evaluate(() => {
        const main = document.getElementById('main-content') as HTMLElement & { inert?: boolean };
        return main.hasAttribute('inert') || main.inert === true;
      }),
      'the outline is inert behind a modal dialog'
    ).toBe(true);

    // Tab and Shift+Tab wrap around inside the dialog instead of escaping it.
    for (const key of ['Shift+Tab', 'Tab', 'Tab', 'Shift+Tab']) {
      await page.keyboard.press(key);
      await expect.poll(() => focusInside(page, 'options-title'), `${key} stays inside the dialog`).toBe(true);
    }

    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.textContent?.trim() ?? ''), 'focus returns to the opener')
      .toBe('Options');
  });

  test('Quick capture focuses the textarea and Escape closes it', async ({ page }) => {
    await page.goto('/?quick-add=buy%20milk');

    const dialog = page.getByRole('dialog', { name: 'Quick capture' });
    await expect(dialog).toBeVisible();
    await expect(page.locator('#quick-capture-input')).toBeFocused();

    for (const key of ['Tab', 'Shift+Tab']) {
      await page.keyboard.press(key);
      await expect.poll(() => focusInside(page, 'quick-capture-title'), `${key} stays inside the dialog`).toBe(true);
    }

    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect.poll(() => focusInside(page, 'quick-capture-title')).toBe(false);
  });

  test('the tasks panel is a named region that takes and returns focus', async ({ page }) => {
    await setupDoc(page, { id: 'root', text: 'Root', children: [] });

    const opener = page.getByRole('button', { name: 'Open tasks panel' });
    await opener.click();
    const panel = page.getByRole('region', { name: 'Tasks' });
    await expect(panel).toBeVisible();
    await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('.tasks-panel'))).toBe(true);

    await page.getByRole('button', { name: 'Close tasks panel' }).click();
    await expect(panel).toHaveCount(0);
    await expect
      .poll(() => page.evaluate(() => !!document.activeElement?.classList.contains('toolbar-btn-tasks')))
      .toBe(true);
  });
});
