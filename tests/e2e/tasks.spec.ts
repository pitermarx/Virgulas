import { test, expect } from '../test';
import { setupDoc } from '../test';

/** A local-time YYYY-MM-DD `days` from today. */
function daysFromNow(days: number): string {
    const d = new Date();
    d.setDate(d.getDate() + days);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

/** The tasks sidebar's due chip label for a local date `days` from today. */
function dueLabel(days: number): string {
    const now = new Date();
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days);
    const month = d.toLocaleString('en-US', { month: 'short' });
    return d.getFullYear() === now.getFullYear()
        ? `${month} ${d.getDate()}`
        : `${month} ${d.getDate()}, ${d.getFullYear()}`;
}

const openPanel = async (page: import('@playwright/test').Page) => {
    await page.keyboard.press('Control+Alt+k');
    const panel = page.locator('.tasks-panel');
    await expect(panel).toBeVisible();
    return panel;
};

test.describe('Task state', () => {
    test.beforeEach(async ({ page }) => {
        await setupDoc(page, {
            id: 'root',
            text: 'Root',
            children: [
                { id: 'plain', text: 'Plain node', children: [] },
                { id: 'pending', text: 'Buy milk', done: false, children: [] },
                { id: 'done', text: 'Walk dog', done: true, children: [] }
            ]
        });
    });

    test('a task, a done task and a plain node each render their own affordance', async ({ page }) => {
        await expect(page.locator('[data-node-id="pending"] .task-checkbox')).toHaveAttribute('aria-pressed', 'false');
        await expect(page.locator('[data-node-id="done"] .task-checkbox')).toHaveAttribute('aria-pressed', 'true');
        await expect(page.locator('[data-node-id="plain"] .bullet')).toBeVisible();
        await expect(page.locator('[data-node-id="plain"] .task-checkbox')).not.toBeVisible();
    });

    test('the checkbox round-trips a task between pending and done', async ({ page }) => {
        const pending = page.locator('[data-node-id="pending"] .task-checkbox');
        await pending.click();
        await expect(pending).toHaveAttribute('aria-pressed', 'true');
        await expect(page.locator('[data-node-id="pending"]')).toHaveClass(/node-done/);

        const done = page.locator('[data-node-id="done"] .task-checkbox');
        await done.click();
        await expect(done).toHaveAttribute('aria-pressed', 'false');
        await expect(page.locator('[data-node-id="done"]')).not.toHaveClass(/node-done/);
    });

    test('editing shows the checkbox prefix and hides the checkbox', async ({ page }) => {
        for (const [id, expected] of [['pending', '[ ] Buy milk'], ['done', '[x] Walk dog'], ['plain', 'Plain node']]) {
            await page.locator(`[data-node-id="${id}"] .node-text-md`).click();
            await expect(page.locator(`[data-node-id="${id}"] .node-text-input`)).toHaveValue(expected);
            await expect(page.locator(`[data-node-id="${id}"] .task-checkbox`)).not.toBeVisible();
            await page.keyboard.press('Escape');
        }
    });

    test('typing a task prefix converts a plain node and removing it converts back', async ({ page }) => {
        await page.locator('[data-node-id="plain"] .node-text-md').click();
        const input = page.locator('[data-node-id="plain"] .node-text-input');
        await input.fill('[ ] New task');
        await page.keyboard.press('Escape');
        await expect(page.locator('[data-node-id="plain"] .task-checkbox')).toHaveAttribute('aria-pressed', 'false');
        await expect(page.locator('[data-node-id="plain"] .node-text-md')).toContainText('New task');

        await page.locator('[data-node-id="plain"] .node-text-md').click();
        await input.fill('[x] Done task');
        await page.keyboard.press('Escape');
        await expect(page.locator('[data-node-id="plain"] .task-checkbox')).toHaveAttribute('aria-pressed', 'true');

        await page.locator('[data-node-id="plain"] .node-text-md').click();
        await input.fill('Plain again');
        await page.keyboard.press('Escape');
        await expect(page.locator('[data-node-id="plain"] .task-checkbox')).not.toBeVisible();
        await expect(page.locator('[data-node-id="plain"] .bullet')).toBeVisible();
    });

    test('Ctrl+Enter cycles plain → pending → done → plain', async ({ page }) => {
        const node = page.locator('[data-node-id="plain"]');
        await node.click();
        const input = node.locator('.node-text-input');
        await expect(input).toBeVisible();

        await page.keyboard.press('Control+Enter');
        await expect(input).toHaveValue('[ ] Plain node');
        await page.keyboard.press('Control+Enter');
        await expect(input).toHaveValue('[x] Plain node');
        await page.keyboard.press('Control+Enter');
        await expect(input).toHaveValue('Plain node');

        await page.keyboard.press('Escape');
        await expect(node.locator('.task-checkbox')).not.toBeVisible();
        await expect(node.locator('.bullet')).toBeVisible();
    });
});

test.describe('Recurring tasks', () => {
    test('a recurring task advances its due date instead of completing, from the checkbox and from Ctrl+Enter', async ({ page }) => {
        const due = daysFromNow(-1); // overdue, so it renders in Pending
        await setupDoc(page, {
            id: 'root',
            text: 'Root',
            children: [
                { id: 'rec', text: 'Pay rent', meta: { due, rec: '1m' }, done: false, children: [] }
            ]
        });

        const checkbox = page.locator('[data-node-id="rec"] .task-checkbox');
        await checkbox.click();
        await expect(checkbox).toHaveAttribute('aria-pressed', 'false');
        await expect(page.locator('[data-node-id="rec"]')).not.toHaveClass(/node-done/);

        await page.locator('[data-node-id="rec"] .node-text-md').click();
        const input = page.locator('[data-node-id="rec"] .node-text-input');
        await expect(input).toHaveValue(/rec:1m/);
        await expect(input).not.toHaveValue(new RegExp(`due:${due}(?!\\d)`));
        await page.keyboard.press('Escape');

        // Ctrl+Enter advances it again instead of marking it done.
        await page.locator('[data-node-id="rec"]').click();
        await page.keyboard.press('Control+Enter');
        await page.keyboard.press('Escape');
        await expect(page.locator('[data-node-id="rec"] .task-checkbox')).toHaveAttribute('aria-pressed', 'false');
    });

    test('the tasks sidebar shows the advanced date as soon as the checkbox is clicked', async ({ page }) => {
        // Install the fake clock before the app boots, so every timer it
        // schedules is under the test's control; pausing later then freezes
        // them all instead of leaving a real boot timer running.
        await page.clock.install();
        const due = daysFromNow(-1); // overdue, so it renders in Pending
        await setupDoc(page, {
            id: 'root',
            text: 'Root',
            children: [
                { id: 'rec', text: 'Pay rent', meta: { due, rec: '1d' }, done: false, children: [] }
            ]
        });

        await page.keyboard.press('Control+Alt+k');
        const panel = page.locator('.tasks-panel');
        await expect(panel).toBeVisible();
        const row = panel.locator('.task-row').filter({ hasText: 'Pay rent' });
        const dueChip = row.locator('.task-row-due');
        await expect(dueChip).toHaveText(dueLabel(-1));

        // Freeze time before the click, so the 800 ms version debounce can
        // never fire while the assertion runs: only the task-command path can
        // refresh the row. The click is dispatched directly because
        // Playwright's actionability waits on animation frames, which a paused
        // clock stops.
        const fakeNow = await page.evaluate(() => Date.now());
        await page.clock.pauseAt(fakeNow + 1_000);
        await row.locator('.task-row-check').dispatchEvent('click');

        await expect(dueChip).toHaveText(dueLabel(0));
        await expect(row.locator('.task-row-check')).toHaveAttribute('aria-pressed', 'false');
    });

    test('rec is inert without a due date, and the badge sits beside the due chip', async ({ page }) => {
        await setupDoc(page, {
            id: 'root',
            text: 'Root',
            children: [
                { id: 'no-due', text: 'Water plants', meta: { rec: '1w' }, done: false, children: [] },
                { id: 'with-due', text: 'Trim hedge', meta: { due: daysFromNow(3), rec: '1m' }, done: false, children: [] }
            ]
        });

        const checkbox = page.locator('[data-node-id="no-due"] .task-checkbox');
        await checkbox.click();
        await expect(checkbox).toHaveAttribute('aria-pressed', 'true');

        const withDue = page.locator('[data-node-id="with-due"] .node-text-md');
        await expect(withDue.locator('.due-date')).toBeVisible();
        await expect(withDue.locator('.rec-badge')).toContainText('rec:1m');
    });
});

test.describe('Tasks sidebar', () => {
    test.beforeEach(async ({ page }) => {
        await setupDoc(page, {
            id: 'root',
            text: 'Root',
            children: [
                { id: 'p1', text: 'Buy milk', done: false, children: [] },
                { id: 'p2', text: 'Write tests', done: false, children: [] },
                { id: 'd1', text: 'Walk dog', done: true, children: [] },
                { id: 'plain', text: 'Just a note', children: [] }
            ]
        });
    });

    test('opens and closes with Ctrl+Alt+K', async ({ page }) => {
        await openPanel(page);
        await page.keyboard.press('Control+Alt+k');
        await expect(page.locator('.tasks-panel')).not.toBeVisible();
    });

    test('lists pending tasks only, and expanding Done reveals the finished ones', async ({ page }) => {
        const panel = await openPanel(page);
        await expect(panel.locator('.task-row')).toHaveCount(2);
        await expect(panel.locator('.task-row-text').nth(0)).toContainText('Buy milk');
        await expect(panel.locator('.task-row-text').nth(1)).toContainText('Write tests');
        await expect(panel.locator('.task-row-text').filter({ hasText: 'Just a note' })).not.toBeVisible();

        const doneHeader = panel.locator('.tasks-group-header').nth(1);
        await expect(doneHeader).toContainText('Done');
        await expect(panel.locator('.task-row-text').filter({ hasText: 'Walk dog' })).not.toBeVisible();
        await doneHeader.click();
        await expect(panel.locator('.task-row-text').filter({ hasText: 'Walk dog' })).toBeVisible();
    });

    test('clicking a task focuses it, closing the sidebar on narrow screens and keeping it wide', async ({ page }) => {
        await page.setViewportSize({ width: 800, height: 900 });
        let panel = await openPanel(page);
        await expect(panel.locator('.task-row')).toHaveCount(2);
        await panel.locator('.task-row').filter({ hasText: 'Buy milk' }).locator('.task-row-body').click();
        await expect(page.locator('.tasks-panel')).not.toBeVisible();
        await expect(page.locator('[data-node-id="p1"] .node-text-input')).toBeFocused();

        await page.setViewportSize({ width: 1400, height: 900 });
        // The wide layout drives the panel's close-on-select behaviour; wait for
        // the media query before toggling the panel.
        await expect.poll(() => page.evaluate(() => window.matchMedia('(min-width: 1160px)').matches)).toBe(true);
        panel = await openPanel(page);
        // A different task: clicking the already-focused one again would toggle
        // its editor rather than prove the wide-mode focus behaviour.
        await panel.locator('.task-row').filter({ hasText: 'Write tests' }).locator('.task-row-body').click();
        await expect(panel).toBeVisible();
        await expect(page.locator('[data-node-id="p2"] .node-text-input')).toBeFocused();
    });

    test('clicking a visible task does not zoom; a task hidden by a collapsed ancestor zooms to its parent', async ({ page }) => {
        await setupDoc(page, {
            id: 'root',
            text: 'Root',
            children: [
                { id: 'visible-task', text: 'Visible task', done: false, children: [] },
                {
                    id: 'section', text: 'Section', collapsed: true, children: [
                        { id: 'hidden-task', text: 'Hidden task', done: false, children: [] }
                    ]
                }
            ]
        });

        let panel = await openPanel(page);
        await panel.locator('.task-row').filter({ hasText: 'Visible task' }).locator('.task-row-body').click();
        await expect(page.locator('.breadcrumbs')).not.toBeVisible();

        // Wide mode keeps the panel open, so the next task is one click away.
        await panel.locator('.task-row').filter({ hasText: 'Hidden task' }).locator('.task-row-body').click();
        await expect(page.locator('.breadcrumbs')).toContainText('Section');
        await expect(page.locator('[data-node-id="hidden-task"] .node-text-input')).toBeFocused();
    });

    test('toggling a task from the sidebar updates the list', async ({ page }) => {
        const panel = await openPanel(page);
        await expect(panel.locator('.task-row')).toHaveCount(2);
        await panel.locator('.task-row-check').first().click();
        await expect(panel.locator('.task-row')).toHaveCount(1);
    });

    test('the status toolbar stays visible and the panel scrolls on widescreen', async ({ page }) => {
        await page.setViewportSize({ width: 1400, height: 900 });
        const panel = await openPanel(page);
        const toolbar = page.locator('.status-toolbar');
        await expect(toolbar).toBeVisible();

        const toolbarBox = await toolbar.boundingBox();
        const panelBox = await panel.boundingBox();
        expect(toolbarBox).not.toBeNull();
        expect(panelBox).not.toBeNull();
        expect(toolbarBox!.y).toBeGreaterThanOrEqual(panelBox!.y);
        expect(panelBox!.y + panelBox!.height).toBeLessThanOrEqual(toolbarBox!.y + 1);

        const bodyBox = await panel.locator('.tasks-panel-body').boundingBox();
        expect(bodyBox).not.toBeNull();
        expect(bodyBox!.height).toBeGreaterThan(0);
    });
});

test.describe('Tasks sidebar — scheduling and zoom', () => {
    test('future tasks are scheduled, the 3-day window hides distant ones, and widening reveals them', async ({ page }) => {
        await setupDoc(page, {
            id: 'root',
            text: 'Root',
            children: [
                { id: 'pending', text: 'No due date', done: false, children: [] },
                { id: 'soon', text: 'Soon', meta: { due: daysFromNow(2) }, done: false, children: [] },
                { id: 'far', text: 'Far out', meta: { due: daysFromNow(30) }, done: false, children: [] }
            ]
        });

        const panel = await openPanel(page);
        await expect(panel.locator('.tasks-group-header').nth(0)).toContainText('Pending');
        await expect(panel.locator('.task-row-text').filter({ hasText: 'No due date' })).toBeVisible();
        await expect(panel.locator('.tasks-group-header').nth(1)).toContainText('Scheduled');
        await expect(panel.locator('.task-row-text').filter({ hasText: 'Soon' })).toBeVisible();
        await expect(panel.locator('.task-row-text').filter({ hasText: 'Far out' })).not.toBeVisible();
        await expect(panel.locator('.tasks-scheduled-hidden')).toContainText('1 more beyond 3d');

        await panel.locator('.tasks-window-btn', { hasText: '30d' }).click();
        await expect(panel.locator('.task-row-text').filter({ hasText: 'Far out' })).toBeVisible();
    });

    test('the panel shows every task at the root and only the subtree when zoomed', async ({ page }) => {
        await setupDoc(page, {
            id: 'root',
            text: 'Root',
            children: [
                { id: 'sectionA', text: 'Section A', children: [{ id: 'taskA', text: 'Task in A', done: false, children: [] }] },
                { id: 'sectionB', text: 'Section B', children: [{ id: 'taskB', text: 'Task in B', done: false, children: [] }] }
            ]
        });

        let panel = await openPanel(page);
        await expect(panel.locator('.task-row')).toHaveCount(2);

        await page.keyboard.press('Control+Alt+k');
        await page.locator('[data-node-id="sectionA"] .bullet').click();
        panel = await openPanel(page);
        await expect(panel.locator('.task-row')).toHaveCount(1);
        await expect(panel.locator('.task-row-text')).toContainText('Task in A');
    });
});
