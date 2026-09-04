import { chromium } from 'playwright';
const BASE = 'http://localhost:4173';
const results = [];
const check = (n, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'ok    ' : 'FAIL  '} ${n}${extra ? '  — ' + extra : ''}`); };

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

/** Keep clicking Expand until the whole tree is open (each pass reveals one more level). */
async function expandAll(pg) {
  for (let pass = 0; pass < 8; pass++) {
    const buttons = await pg.locator('tbody button[aria-label^="Expand"]').all();
    if (!buttons.length) return;
    for (const b of buttons) await b.click().catch(() => {});
    await pg.waitForTimeout(150);
  }
}
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

// ---- sign in ----
await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
await page.fill('#email', 'admin@example.com');
await page.fill('#password', 'whatever');
await page.click('button[type=submit]');
await page.waitForURL('**/admin', { timeout: 15000 });
check('admin sign-in reaches the dashboard', page.url().endsWith('/admin'));

await page.waitForSelector('table');
const rows = await page.locator('tbody tr').count();
check('admin tree renders roots + first level collapsed', rows === 6, `${rows} rows`);
await expandAll(page);
const allRows = await page.locator('tbody tr').count();
check('expanding reveals the whole tree incl. drafts', allRows === 15, `${allRows} rows`);
check('draft badge shown', (await page.locator('text=Draft').count()) >= 1);
await page.screenshot({ path: '/tmp/shot-admin.png' });

// ---- create a topic ----
await page.click('text=+ Create topic');
await page.waitForSelector('#title');
await page.fill('#title', 'Consistent Hashing');
await page.waitForTimeout(200);
check('slug auto-derives from title', (await page.inputValue('#slug')) === 'consistent-hashing',
  await page.inputValue('#slug'));
const lbValue = await page.locator('#parent option', { hasText: 'Load Balancer' }).first().getAttribute('value');
await page.selectOption('#parent', lbValue);
await page.fill('#md-source', '# Consistent Hashing\n\nMap servers and keys onto a ring.\n\n```js\nconst ring = [];\n```\n\n| a | b |\n| --- | --- |\n| 1 | 2 |');
await page.waitForTimeout(500);
check('live preview renders markdown', await page.locator('[aria-label=Preview] h1', { hasText: 'Consistent Hashing' }).isVisible());
check('live preview highlights code', (await page.locator('[aria-label=Preview] .hljs-keyword').count()) > 0);
check('live preview renders tables', await page.locator('[aria-label=Preview] table').isVisible());
await page.screenshot({ path: '/tmp/shot-editor.png' });

await page.click('button:has-text("Create")');
await page.waitForTimeout(1500);
check('create navigated to the saved topic', /\/admin\/topics\/[0-9a-f-]{36}$/.test(page.url()), page.url());
const urlPreview = await page.locator('code.font-mono').first().textContent();
check('path materialised by the DB trigger', urlPreview.trim() === '/system-design/load-balancer/consistent-hashing', urlPreview.trim());

// ---- publish, then confirm it is publicly visible ----
await page.click('button:has-text("Publish")');
await page.waitForTimeout(1200);
check('publish flips status', (await page.locator('span:has-text("published")').count()) > 0);

const pub = await browser.newPage();
await pub.goto(`${BASE}/system-design/load-balancer/consistent-hashing`, { waitUntil: 'networkidle' });
check('published page is live at its derived URL',
  await pub.locator('article h1', { hasText: 'Consistent Hashing' }).isVisible());

// ---- rename the slug -> old URL must redirect ----
await page.fill('#slug', 'ring-hashing');
await page.click('button:has-text("Save")');
await page.waitForTimeout(1500);
await pub.goto(`${BASE}/system-design/load-balancer/consistent-hashing`, { waitUntil: 'networkidle' });
await pub.waitForTimeout(1500);
check('old URL redirects to the new one after a rename',
  pub.url().endsWith('/system-design/load-balancer/ring-hashing'), pub.url());

// ---- move it to another parent ----
await page.goto(`${BASE}/admin`, { waitUntil: 'networkidle' });
await page.waitForSelector('table');
await expandAll(page);
const row = page.locator('tr', { has: page.locator('a:text-is("Consistent Hashing")') }).first();
await row.hover();
await row.locator('button[aria-label*="to another parent"]').click();
await page.waitForSelector('#move-parent');
const cacheValue = await page.locator('#move-parent option', { hasText: 'Caching' }).first().getAttribute('value');
await page.selectOption('#move-parent', cacheValue);
await page.waitForTimeout(200);
const newUrlPreview = await page.locator('[role=dialog] code').textContent();
check('move dialog previews the new URL', newUrlPreview.includes('caching/ring-hashing'), newUrlPreview);
await page.screenshot({ path: '/tmp/shot-move.png' });
await page.click('[role=dialog] button:has-text("Move page")');
await page.waitForTimeout(1500);
await pub.goto(`${BASE}/system-design/load-balancer/ring-hashing`, { waitUntil: 'networkidle' });
await pub.waitForTimeout(1500);
check('URL after a move redirects too', pub.url().endsWith('/system-design/caching/ring-hashing'), pub.url());

// ---- delete guard on a parent with children ----
await page.goto(`${BASE}/admin`, { waitUntil: 'networkidle' });
await page.waitForSelector('table');
await expandAll(page);
const rlRow = page.locator('tr', { has: page.locator('a:text-is("Rate Limiter")') }).first();
await rlRow.hover();
await rlRow.locator('button[aria-label^="Delete"]').click();
await page.waitForSelector('[role=dialog]');
await page.waitForTimeout(900);
check('delete dialog states the blast radius',
  (await page.locator('[role=dialog]').textContent()).includes('permanently delete 4 pages'),
  (await page.locator('[role=dialog]').textContent()).slice(0, 90).replace(/\s+/g, ' '));
check('delete button is disabled until the title is typed',
  await page.locator('[role=dialog] button:has-text("Delete all")').isDisabled());
await page.screenshot({ path: '/tmp/shot-delete.png' });
await page.fill('#confirm-title', 'Rate Limiter');
check('delete button arms after confirmation',
  await page.locator('[role=dialog] button:has-text("Delete all")').isEnabled());
await page.click('[role=dialog] button:has-text("Cancel")');

// ---- reorder ----
const before = await page.locator('tbody tr td:first-child a').allTextContents();
const first = page.locator('tbody tr').first();
await first.hover();
await first.locator('button[aria-label="Move down"]').click();
await page.waitForTimeout(1200);
const after = await page.locator('tbody tr td:first-child a').allTextContents();
check('reorder changes sibling order', before[0] !== after[0], `${before[0]} -> ${after[0]}`);

check('no console errors', errors.length === 0, errors.slice(0, 2).join(' | '));

await browser.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
