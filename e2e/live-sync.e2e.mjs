// Two-browser end-to-end check for live sync. Unit tests cover the diff and
// the transport; this covers what only a real pair of browsers can show:
// a second person joining by URL, edits travelling both ways, and table
// positions ending up identical.
//
// Not part of `npm test` -- it needs a running app, a running sync server and
// Playwright browsers, so it is opt-in:
//
//   # sync server (live-sync-server/ in this repo)
//   cd live-sync-server && DATA_DIR=/tmp/live-sync-data LISTEN_ADDR=:8090 go run .
//
//   # the app, with live sync pointed at a same-origin path
//   VITE_LIVE_SYNC_URL=/live-sync npx vite --port 5199 --strictPort
//
//   # something that serves both on one origin (a dev-only proxy, or the
//   # production Caddy setup where /live-sync/* is already routed)
//
//   npm i -D playwright && npx playwright install chromium
//   APP_URL=http://localhost:5200 npm run test:e2e:live-sync
//
// The app and the sync server MUST share an origin: the browser refuses the
// cross-origin PUT otherwise, which is also how it is deployed.

import assert from 'node:assert/strict';

const APP = process.env.APP_URL ?? 'http://localhost:5200';
const SYNC = process.env.SYNC_URL ?? `${APP}/live-sync`;
const POLL_GRACE_MS = Number(process.env.POLL_GRACE_MS ?? 9000);

let chromium;
try {
    ({ chromium } = await import('playwright'));
} catch {
    console.error(
        'playwright is not installed. Run: npm i -D playwright && npx playwright install chromium'
    );
    process.exit(1);
}

const log = (...args) => console.log('[live-sync e2e]', ...args);

const openBrowser = async (name) => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    page.on('console', (message) => {
        if (/live sync/i.test(message.text())) {
            console.error(`  [${name}] ${message.text()}`);
        }
    });

    return { browser, page, name };
};

// Read straight from the browser's own storage instead of the sidebar, which
// virtualises its rows and would make the assertions flaky.
const storedTables = (user) =>
    user.page.evaluate(async () => {
        const db = await new Promise((resolve, reject) => {
            const request = indexedDB.open('ChartDB');
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        const rows = await new Promise((resolve) => {
            const query = db
                .transaction('db_tables', 'readonly')
                .objectStore('db_tables')
                .getAll();
            query.onsuccess = () => resolve(query.result);
        });
        db.close();

        return rows
            .map((table) => ({
                name: table.name,
                x: Math.round(table.x),
                y: Math.round(table.y),
            }))
            .sort((a, b) => a.name.localeCompare(b.name));
    });

const names = (tables) => tables.map((table) => table.name);

const publishedTables = async (diagramId) => {
    const response = await fetch(`${SYNC}/diagrams/${diagramId}`);
    assert.equal(response.status, 200, 'diagram should be published');
    const diagram = await response.json();

    return (diagram.tables ?? []).map((table) => table.name).sort();
};

const addTable = async (user) => {
    const button = user.page
        .getByRole('button', { name: 'Add Table', exact: true })
        .first();

    // Selecting a table swaps the side panel, which hides the button.
    if (!(await button.isVisible().catch(() => false))) {
        await user.page.getByText('Tables', { exact: true }).first().click();
        await user.page.waitForTimeout(500);
    }

    await button.click();
    await user.page.waitForTimeout(POLL_GRACE_MS);
};

const a = await openBrowser('A');
const b = await openBrowser('B');

try {
    log('A creates a diagram');
    await a.page.goto(`${APP}/`, { waitUntil: 'domcontentloaded' });
    await a.page.waitForTimeout(4000);
    await a.page.locator('button:has(img[src*="mysql_logo"])').click();
    await a.page.waitForTimeout(700);
    await a.page.getByRole('button', { name: 'Empty database' }).click();
    await a.page.waitForTimeout(4000);

    const url = a.page.url();
    const diagramId = url.split('/diagrams/')[1];
    assert.ok(diagramId, `expected a diagram url, got ${url}`);

    log('A adds a table, which publishes the diagram');
    await addTable(a);
    assert.deepEqual(names(await storedTables(a)), ['table_1']);
    assert.deepEqual(await publishedTables(diagramId), ['table_1']);

    log('B opens the same url on a browser that has never seen the diagram');
    await b.page.goto(url, { waitUntil: 'domcontentloaded' });
    await b.page.waitForTimeout(POLL_GRACE_MS);
    assert.deepEqual(
        names(await storedTables(b)),
        ['table_1'],
        'B should have joined by importing the published diagram'
    );

    log('a table A drags ends up in the same place for B');
    const before = await storedTables(a);
    const node = a.page.locator('.react-flow__node').first();
    const box = await node.boundingBox();
    await a.page.mouse.move(box.x + box.width / 2, box.y + 12);
    await a.page.mouse.down();
    await a.page.mouse.move(box.x + box.width / 2 + 180, box.y + 132, {
        steps: 12,
    });
    await a.page.mouse.up();
    await a.page.waitForTimeout(POLL_GRACE_MS);

    const movedForA = await storedTables(a);
    assert.notDeepEqual(
        movedForA,
        before,
        'the drag should have moved something'
    );
    assert.deepEqual(
        await storedTables(b),
        movedForA,
        'B should see the same positions as A'
    );

    // Dragging leaves the table selected and the side panel swapped out; a
    // reload is the cheapest way back to a known screen for the next steps.
    await a.page.reload({ waitUntil: 'domcontentloaded' });
    await a.page.waitForTimeout(POLL_GRACE_MS);

    log("A's next edit reaches B");
    await addTable(a);
    assert.deepEqual(names(await storedTables(b)), ['table_1', 'table_2']);

    log("B's edit reaches A");
    await b.page.reload({ waitUntil: 'domcontentloaded' });
    await b.page.waitForTimeout(POLL_GRACE_MS);
    await addTable(b);
    assert.deepEqual(names(await storedTables(a)), [
        'table_1',
        'table_2',
        'table_3',
    ]);

    log('a browser sitting idle writes nothing back');
    const idleStart = await fetch(`${SYNC}/diagrams/${diagramId}`, {
        method: 'HEAD',
    });
    await a.page.waitForTimeout(POLL_GRACE_MS * 2);
    const idleEnd = await fetch(`${SYNC}/diagrams/${diagramId}`, {
        method: 'HEAD',
    });
    assert.equal(
        idleEnd.headers.get('last-modified'),
        idleStart.headers.get('last-modified'),
        'polling must converge instead of rewriting the diagram forever'
    );

    log('PASS');
} finally {
    await a.browser.close();
    await b.browser.close();
}
