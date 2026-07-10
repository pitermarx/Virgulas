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

    test('clicking task row in sidebar zooms to that node', async ({ page }) => {
        await page.keyboard.press('Control+Alt+k');
        const panel = page.locator('.tasks-panel');
        await expect(panel).toBeVisible();
        await expect(panel.locator('.task-row')).toHaveCount(2);
        await panel.locator('.task-row-body').first().click();
        // Panel closes on navigate; breadcrumb shows the task node
        await expect(page.locator('.tasks-panel')).not.toBeVisible();
        await expect(page.locator('.breadcrumbs')).toContainText('Buy milk');
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
});
