import { test, expect } from './test';
import { setupDoc } from './test';

test.describe('Tasks', () => {
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

    test('pending task shows unchecked checkbox', async ({ page }) => {
        const checkbox = page.locator('[data-node-id="pending"] .task-checkbox');
        await expect(checkbox).toBeVisible();
        await expect(checkbox).toHaveAttribute('aria-pressed', 'false');
    });

    test('done task shows checked checkbox', async ({ page }) => {
        const checkbox = page.locator('[data-node-id="done"] .task-checkbox');
        await expect(checkbox).toBeVisible();
        await expect(checkbox).toHaveAttribute('aria-pressed', 'true');
    });

    test('plain node shows bullet, not checkbox', async ({ page }) => {
        await expect(page.locator('[data-node-id="plain"] .bullet')).toBeVisible();
        await expect(page.locator('[data-node-id="plain"] .task-checkbox')).not.toBeVisible();
    });

    test('clicking checkbox on pending task marks it done', async ({ page }) => {
        const checkbox = page.locator('[data-node-id="pending"] .task-checkbox');
        await checkbox.click();
        await expect(checkbox).toHaveAttribute('aria-pressed', 'true');
        await expect(page.locator('[data-node-id="pending"]')).toHaveClass(/node-done/);
    });

    test('clicking checkbox on done task marks it pending', async ({ page }) => {
        const checkbox = page.locator('[data-node-id="done"] .task-checkbox');
        await checkbox.click();
        await expect(checkbox).toHaveAttribute('aria-pressed', 'false');
        await expect(page.locator('[data-node-id="done"]')).not.toHaveClass(/node-done/);
    });

    test('editing a pending task shows [ ] prefix in input', async ({ page }) => {
        await page.locator('[data-node-id="pending"] .node-text-md').click();
        const input = page.locator('[data-node-id="pending"] .node-text-input');
        await expect(input).toHaveValue('[ ] Buy milk');
    });

    test('editing a done task shows [x] prefix in input', async ({ page }) => {
        await page.locator('[data-node-id="done"] .node-text-md').click();
        const input = page.locator('[data-node-id="done"] .node-text-input');
        await expect(input).toHaveValue('[x] Walk dog');
    });

    test('editing a plain node shows no prefix in input', async ({ page }) => {
        await page.locator('[data-node-id="plain"] .node-text-md').click();
        const input = page.locator('[data-node-id="plain"] .node-text-input');
        await expect(input).toHaveValue('Plain node');
    });

    test('checkbox is hidden while the node is being edited', async ({ page }) => {
        await page.locator('[data-node-id="pending"] .node-text-md').click();
        await expect(page.locator('[data-node-id="pending"] .task-checkbox')).not.toBeVisible();
    });

    test('typing [ ] in a plain node converts it to a pending task', async ({ page }) => {
        await page.locator('[data-node-id="plain"] .node-text-md').click();
        const input = page.locator('[data-node-id="plain"] .node-text-input');
        await input.fill('[ ] New task');
        await page.keyboard.press('Escape');
        await expect(page.locator('[data-node-id="plain"] .task-checkbox')).toBeVisible();
        await expect(page.locator('[data-node-id="plain"] .node-text-md')).toContainText('New task');
    });

    test('typing [x] in a plain node converts it to a done task', async ({ page }) => {
        await page.locator('[data-node-id="plain"] .node-text-md').click();
        const input = page.locator('[data-node-id="plain"] .node-text-input');
        await input.fill('[x] Done task');
        await page.keyboard.press('Escape');
        await expect(page.locator('[data-node-id="plain"] .task-checkbox')).toHaveAttribute('aria-pressed', 'true');
    });

    test('removing [ ] prefix from a pending task converts it to a plain node', async ({ page }) => {
        await page.locator('[data-node-id="pending"] .node-text-md').click();
        const input = page.locator('[data-node-id="pending"] .node-text-input');
        await input.fill('Buy milk');
        await page.keyboard.press('Escape');
        await expect(page.locator('[data-node-id="pending"] .task-checkbox')).not.toBeVisible();
        await expect(page.locator('[data-node-id="pending"] .bullet')).toBeVisible();
    });

    test('Ctrl+Enter cycles plain → pending → done → plain', async ({ page }) => {
        const node = page.locator('[data-node-id="plain"]');
        await node.click();
        const input = node.locator('.node-text-input');
        await expect(input).toBeVisible();

        // plain → pending: input shows [ ] prefix
        await page.keyboard.press('Control+Enter');
        await expect(input).toHaveValue('[ ] Plain node');

        // pending → done: input shows [x] prefix
        await page.keyboard.press('Control+Enter');
        await expect(input).toHaveValue('[x] Plain node');

        // done → plain: no prefix, no checkbox after blur
        await page.keyboard.press('Control+Enter');
        await expect(input).toHaveValue('Plain node');
        await page.keyboard.press('Escape');
        await expect(node.locator('.task-checkbox')).not.toBeVisible();
        await expect(node.locator('.bullet')).toBeVisible();
    });
});

test.describe('Recurring tasks', () => {
    function daysFromNow(days: number): string {
        const d = new Date();
        d.setDate(d.getDate() + days);
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${y}-${m}-${day}`;
    }

    test('clicking the checkbox on a recurring task advances the due date instead of marking it done', async ({ page }) => {
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
        // Stays unchecked — the due date advanced instead of becoming done
        await expect(checkbox).toHaveAttribute('aria-pressed', 'false');
        await expect(page.locator('[data-node-id="rec"]')).not.toHaveClass(/node-done/);
        await page.locator('[data-node-id="rec"] .node-text-md').click();
        const input = page.locator('[data-node-id="rec"] .node-text-input');
        await expect(input).toHaveValue(/rec:1m/);
        await expect(input).not.toHaveValue(new RegExp(`due:${due}(?!\\d)`));
    });

    test('Ctrl+Enter on a recurring task advances the due date instead of marking it done', async ({ page }) => {
        const due = daysFromNow(-1);
        await setupDoc(page, {
            id: 'root',
            text: 'Root',
            children: [
                { id: 'rec', text: 'Pay rent', meta: { due, rec: '1w' }, done: false, children: [] }
            ]
        });
        await page.locator('[data-node-id="rec"]').click();
        await page.keyboard.press('Control+Enter');
        await page.keyboard.press('Escape');
        await expect(page.locator('[data-node-id="rec"] .task-checkbox')).toHaveAttribute('aria-pressed', 'false');
    });

    test('recurring task with no due date is marked done normally (rec is inert)', async ({ page }) => {
        await setupDoc(page, {
            id: 'root',
            text: 'Root',
            children: [
                { id: 'rec', text: 'Water plants', meta: { rec: '1w' }, done: false, children: [] }
            ]
        });
        const checkbox = page.locator('[data-node-id="rec"] .task-checkbox');
        await checkbox.click();
        await expect(checkbox).toHaveAttribute('aria-pressed', 'true');
    });

    test('rec badge is rendered next to the due date chip', async ({ page }) => {
        const due = daysFromNow(3);
        await setupDoc(page, {
            id: 'root',
            text: 'Root',
            children: [
                { id: 'rec', text: 'Pay rent', meta: { due, rec: '1m' }, done: false, children: [] }
            ]
        });
        const node = page.locator('[data-node-id="rec"] .node-text-md');
        await expect(node.locator('.due-date')).toBeVisible();
        await expect(node.locator('.rec-badge')).toBeVisible();
        await expect(node.locator('.rec-badge')).toContainText('rec:1m');
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

    test('opens with Ctrl+Alt+K', async ({ page }) => {
        await page.keyboard.press('Control+Alt+k');
        await expect(page.locator('.tasks-panel')).toBeVisible();
    });

    test('closes with Ctrl+Alt+K again', async ({ page }) => {
        await page.keyboard.press('Control+Alt+k');
        await expect(page.locator('.tasks-panel')).toBeVisible();
        await page.keyboard.press('Control+Alt+k');
        await expect(page.locator('.tasks-panel')).not.toBeVisible();
    });

    test('shows pending tasks', async ({ page }) => {
        await page.keyboard.press('Control+Alt+k');
        const panel = page.locator('.tasks-panel');
        await expect(panel.locator('.task-row')).toHaveCount(2);
        await expect(panel.locator('.task-row-text').nth(0)).toContainText('Buy milk');
        await expect(panel.locator('.task-row-text').nth(1)).toContainText('Write tests');
    });

    test('done group is collapsed by default', async ({ page }) => {
        await page.keyboard.press('Control+Alt+k');
        const panel = page.locator('.tasks-panel');
        // Done group header should be present but items collapsed
        await expect(panel.locator('.tasks-group-header').nth(1)).toContainText('Done');
        await expect(panel.locator('.task-row-text').filter({ hasText: 'Walk dog' })).not.toBeVisible();
    });

    test('expanding done group shows done tasks', async ({ page }) => {
        await page.keyboard.press('Control+Alt+k');
        const panel = page.locator('.tasks-panel');
        await expect(panel).toBeVisible();
        // Wait for pending tasks to confirm panel is fully rendered
        await expect(panel.locator('.task-row')).toHaveCount(2);
        // Expand Done group
        const doneHeader = panel.locator('.tasks-group-header').nth(1);
        await expect(doneHeader).toBeVisible();
        await doneHeader.click();
        await expect(panel.locator('.task-row-text').filter({ hasText: 'Walk dog' })).toBeVisible();
    });

    test('plain nodes do not appear in sidebar', async ({ page }) => {
        await page.keyboard.press('Control+Alt+k');
        const panel = page.locator('.tasks-panel');
        await expect(panel.locator('.task-row-text').filter({ hasText: 'Just a note' })).not.toBeVisible();
    });

    test('clicking a task row in narrow mode closes the sidebar and focuses the task', async ({ page }) => {
        await page.setViewportSize({ width: 800, height: 900 });
        await page.keyboard.press('Control+Alt+k');
        const panel = page.locator('.tasks-panel');
        await expect(panel).toBeVisible();
        await expect(panel.locator('.task-row')).toHaveCount(2);
        await panel.locator('.task-row-body').first().click();
        await expect(page.locator('.tasks-panel')).not.toBeVisible();
        await expect(page.locator('[data-node-id="p1"] .node-text-input')).toBeFocused();
    });

    test('clicking a task row in wide mode keeps the sidebar open', async ({ page }) => {
        await page.setViewportSize({ width: 1400, height: 900 });
        await page.keyboard.press('Control+Alt+k');
        const panel = page.locator('.tasks-panel');
        await expect(panel).toBeVisible();
        await panel.locator('.task-row-body').first().click();
        await expect(panel).toBeVisible();
        await expect(page.locator('[data-node-id="p1"] .node-text-input')).toBeFocused();
    });

    test('clicking a task that is already visible does not change the zoom', async ({ page }) => {
        await page.keyboard.press('Control+Alt+k');
        const panel = page.locator('.tasks-panel');
        await panel.locator('.task-row-body').first().click();
        // p1 is a direct child of root, already visible under the root zoom — no breadcrumbs at root
        await expect(page.locator('.breadcrumbs')).not.toBeVisible();
    });

    test('clicking a task hidden by a collapsed ancestor zooms to its parent', async ({ page }) => {
        await setupDoc(page, {
            id: 'root',
            text: 'Root',
            children: [
                {
                    id: 'section', text: 'Section', collapsed: true, children: [
                        { id: 'hidden-task', text: 'Hidden task', done: false, children: [] }
                    ]
                }
            ]
        });
        await page.keyboard.press('Control+Alt+k');
        const panel = page.locator('.tasks-panel');
        await panel.locator('.task-row-body').first().click();
        await expect(page.locator('.breadcrumbs')).toContainText('Section');
        await expect(page.locator('[data-node-id="hidden-task"] .node-text-input')).toBeFocused();
    });

    test('toggling task done from sidebar updates the sidebar', async ({ page }) => {
        await page.keyboard.press('Control+Alt+k');
        const panel = page.locator('.tasks-panel');
        await expect(panel).toBeVisible();
        await expect(panel.locator('.task-row')).toHaveCount(2);
        // Click the check button on the first pending task row
        await panel.locator('.task-row-check').first().click();
        // Now only 1 pending task remains visible
        await expect(panel.locator('.task-row')).toHaveCount(1);
    });

    test('status toolbar stays visible when tasks panel is open on widescreen', async ({ page }) => {
        await page.setViewportSize({ width: 1400, height: 900 });
        await page.keyboard.press('Control+Alt+k');
        const panel = page.locator('.tasks-panel');
        await expect(panel).toBeVisible();
        const toolbar = page.locator('.status-toolbar');
        await expect(toolbar).toBeVisible();
        // The toolbar should not be covered by the panel — both visible simultaneously
        const toolbarBox = await toolbar.boundingBox();
        const panelBox = await panel.boundingBox();
        expect(toolbarBox).not.toBeNull();
        expect(panelBox).not.toBeNull();
        // Toolbar is below the panel (panel is on the right side, toolbar spans full width below)
        expect(toolbarBox!.y).toBeGreaterThanOrEqual(panelBox!.y);
        // Panel height adjusts to the window: panel bottom should not exceed toolbar top
        expect(panelBox!.y + panelBox!.height).toBeLessThanOrEqual(toolbarBox!.y + 1);
        // Panel body scrolls independently
        const panelBody = panel.locator('.tasks-panel-body');
        await expect(panelBody).toBeVisible();
        const bodyBox = await panelBody.boundingBox();
        expect(bodyBox).not.toBeNull();
        expect(bodyBox!.height).toBeGreaterThan(0);
    });
});

test.describe('Tasks sidebar — scheduled group', () => {
    function daysFromNow(days: number): string {
        const d = new Date();
        d.setDate(d.getDate() + days);
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${y}-${m}-${day}`;
    }

    test.beforeEach(async ({ page }) => {
        await setupDoc(page, {
            id: 'root',
            text: 'Root',
            children: [
                { id: 'pending', text: 'No due date', done: false, children: [] },
                { id: 'soon', text: 'Soon', meta: { due: daysFromNow(2) }, done: false, children: [] },
                { id: 'far', text: 'Far out', meta: { due: daysFromNow(30) }, done: false, children: [] }
            ]
        });
    });

    test('future due-dated tasks show under Scheduled, not Pending', async ({ page }) => {
        await page.keyboard.press('Control+Alt+k');
        const panel = page.locator('.tasks-panel');
        await expect(panel.locator('.tasks-group-header').nth(0)).toContainText('Pending');
        await expect(panel.locator('.task-row-text').filter({ hasText: 'No due date' })).toBeVisible();
        await expect(panel.locator('.tasks-group-header').nth(1)).toContainText('Scheduled');
    });

    test('default 3-day window shows the soon task but hides the far task', async ({ page }) => {
        await page.keyboard.press('Control+Alt+k');
        const panel = page.locator('.tasks-panel');
        await expect(panel.locator('.task-row-text').filter({ hasText: 'Soon' })).toBeVisible();
        await expect(panel.locator('.task-row-text').filter({ hasText: 'Far out' })).not.toBeVisible();
        await expect(panel.locator('.tasks-scheduled-hidden')).toContainText('1 more beyond 3d');
    });

    test('widening the window filter reveals the far task', async ({ page }) => {
        await page.keyboard.press('Control+Alt+k');
        const panel = page.locator('.tasks-panel');
        await panel.locator('.tasks-window-btn', { hasText: '30d' }).click();
        await expect(panel.locator('.task-row-text').filter({ hasText: 'Far out' })).toBeVisible();
    });
});

test.describe('Tasks sidebar — zoom scoping', () => {
    test.beforeEach(async ({ page }) => {
        await setupDoc(page, {
            id: 'root',
            text: 'Root',
            children: [
                {
                    id: 'sectionA', text: 'Section A', children: [
                        { id: 'taskA', text: 'Task in A', done: false, children: [] }
                    ]
                },
                {
                    id: 'sectionB', text: 'Section B', children: [
                        { id: 'taskB', text: 'Task in B', done: false, children: [] }
                    ]
                }
            ]
        });
    });

    test('sidebar shows all tasks when zoomed at root', async ({ page }) => {
        await page.keyboard.press('Control+Alt+k');
        const panel = page.locator('.tasks-panel');
        await expect(panel.locator('.task-row')).toHaveCount(2);
    });

    test('sidebar only shows tasks within the zoomed subtree', async ({ page }) => {
        await page.locator('[data-node-id="sectionA"] .bullet').click();
        await page.keyboard.press('Control+Alt+k');
        const panel = page.locator('.tasks-panel');
        await expect(panel.locator('.task-row')).toHaveCount(1);
        await expect(panel.locator('.task-row-text')).toContainText('Task in A');
    });
});

