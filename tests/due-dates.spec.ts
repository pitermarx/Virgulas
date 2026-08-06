import { test, expect } from './test';
import { setupDoc } from './test';

function daysFromNow(days: number): string {
    const d = new Date();
    d.setDate(d.getDate() + days);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

test.describe('Due dates', () => {
    test.beforeEach(async ({ page }) => {
        await setupDoc(page, {
            id: 'root',
            text: 'Root',
            children: [
                { id: 'future', text: `Future task due:${daysFromNow(3)}`, done: false, children: [] },
                { id: 'overdue', text: `Overdue task due:${daysFromNow(-1)}`, done: false, children: [] },
                { id: 'plain', text: 'Plain task', done: false, children: [] },
                { id: 'plainDue', text: `Plain node due:${daysFromNow(3)}`, children: [] }
            ]
        });
    });

    test('due date is highlighted as a chip in node text', async ({ page }) => {
        const node = page.locator('[data-node-id="future"] .node-text-md');
        await expect(node.locator('.due-date')).toBeVisible();
        await expect(node.locator('.due-date')).toContainText(`due:${daysFromNow(3)}`);
    });

    test('due date is plain text when editing', async ({ page }) => {
        await page.locator('[data-node-id="future"] .node-text-md').click();
        const input = page.locator('[data-node-id="future"] .node-text-input');
        await expect(input).toHaveValue(`[ ] Future task due:${daysFromNow(3)}`);
        await expect(page.locator('[data-node-id="future"] .due-date')).not.toBeVisible();
    });

    test('due date metadata on a plain node is not rendered as a task chip', async ({ page }) => {
        const node = page.locator('[data-node-id="plainDue"] .node-text-md');
        await expect(node).toContainText(`due:${daysFromNow(3)}`);
        await expect(node.locator('.due-date')).toHaveCount(0);
    });

    test('due date is visible in tasks panel', async ({ page }) => {
        await page.keyboard.press('Control+Alt+k');
        const panel = page.locator('.tasks-panel');
        await expect(panel).toBeVisible();
        await expect(panel.locator('.task-row-due')).toHaveCount(2);
    });

    test('overdue task is highlighted in tasks panel', async ({ page }) => {
        await page.keyboard.press('Control+Alt+k');
        const panel = page.locator('.tasks-panel');
        await expect(panel).toBeVisible();
        const overdueRow = panel.locator('.task-row--overdue');
        await expect(overdueRow).toHaveCount(1);
        await expect(overdueRow).toContainText('Overdue task');
    });

    test('overdue tasks are prioritized (sorted first) in tasks panel', async ({ page }) => {
        await page.keyboard.press('Control+Alt+k');
        const panel = page.locator('.tasks-panel');
        await expect(panel).toBeVisible();
        const rows = panel.locator('.task-row');
        await expect(rows).toHaveCount(3);
        // Pending group (overdue, plain) renders before the Scheduled group (future)
        await expect(rows.nth(0)).toContainText('Overdue task');
        await expect(rows.nth(1)).toContainText('Plain task');
        await expect(rows.nth(2)).toContainText('Future task');
    });

    test('tasks toolbar icon is highlighted when overdue task exists', async ({ page }) => {
        const btn = page.locator('.toolbar-btn-tasks');
        await expect(btn).toHaveClass(/toolbar-btn-tasks--overdue/);
    });

    test('tasks toolbar icon is not highlighted when no overdue tasks', async ({ page }) => {
        await setupDoc(page, {
            id: 'root',
            text: 'Root',
            children: [
                { id: 'future', text: `Future task due:${daysFromNow(3)}`, done: false, children: [] },
                { id: 'plain', text: 'Plain task', done: false, children: [] }
            ]
        });
        const btn = page.locator('.toolbar-btn-tasks');
        await expect(btn).not.toHaveClass(/toolbar-btn-tasks--overdue/);
    });

    test('overdue done task does not highlight toolbar icon', async ({ page }) => {
        await setupDoc(page, {
            id: 'root',
            text: 'Root',
            children: [
                { id: 'overdueDone', text: `Done overdue due:${daysFromNow(-1)}`, done: true, children: [] }
            ]
        });
        const btn = page.locator('.toolbar-btn-tasks');
        await expect(btn).not.toHaveClass(/toolbar-btn-tasks--overdue/);
    });
});