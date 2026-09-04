import { chromium } from 'playwright';

const BASE = 'http://localhost:4173';
const results = [];
const check = (n, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'ok    ' : 'FAIL  '} ${n}${extra ? '  — ' + extra : ''}`); };

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

/** Each pass reveals one more level of the tree. */
async function expandAll(pg) {
  for (let i = 0; i < 8; i++) {
    const buttons = await pg.locator('tbody button[aria-label^="Expand"]').all();
    if (!buttons.length) return;
    for (const b of buttons) await b.click().catch(() => {});
    await pg.waitForTimeout(150);
  }
}

/* ---- sign in ---- */
await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
await page.fill('#email', 'admin@example.com');
await page.fill('#password', 'secret123');
await page.click('button[type=submit]');
await page.waitForURL('**/dashboard', { timeout: 15000 });
await page.waitForSelector('nav a:has-text("All pages")', { timeout: 10000 });
check('admin sign-in reaches the dashboard', page.url().endsWith('/dashboard'));

/* ---- the full tree, private pages included ---- */
await page.goto(`${BASE}/dashboard/all`, { waitUntil: 'networkidle' });
await page.waitForSelector('table');
check('roots and first level render collapsed', (await page.locator('tbody tr').count()) === 6,
  `${await page.locator('tbody tr').count()} rows`);
await expandAll(page);
check('expanding reveals the whole tree', (await page.locator('tbody tr').count()) === 15,
  `${await page.locator('tbody tr').count()} rows`);
check('private pages are marked', (await page.locator('tbody :text("PRIVATE")').count()) >= 1);
check('shared pages are marked', (await page.locator('tbody :text("SHARED")').count()) >= 1);
check('owner column is shown to admins', (await page.locator('th:has-text("Owner")').count()) === 1);
await page.screenshot({ path: '/tmp/au-all.png' });

/* ---- create ---- */
await page.click('a:has-text("New page")');
await page.waitForSelector('#title');
await page.fill('#title', 'Consistent Hashing');
await page.waitForTimeout(200);
check('slug auto-derives from the title', (await page.inputValue('#slug')) === 'consistent-hashing',
  await page.inputValue('#slug'));

const lb = await page.locator('#parent option', { hasText: 'Load Balancer' }).first().getAttribute('value');
await page.selectOption('#parent', lb);
await page.fill('#md-source',
  '# Consistent Hashing\n\nMap servers and keys onto a ring.\n\n```js\nconst ring = [];\n```\n\n| a | b |\n| --- | --- |\n| 1 | 2 |');
await page.waitForTimeout(500);
check('live preview renders markdown',
  await page.locator('[aria-label=Preview] h1', { hasText: 'Consistent Hashing' }).isVisible());
check('live preview highlights code', (await page.locator('[aria-label=Preview] .hljs-keyword').count()) > 0);
check('live preview renders tables', await page.locator('[aria-label=Preview] table').isVisible());
await page.click('input[name=visibility][value=public]');
await page.screenshot({ path: '/tmp/au-editor.png' });

await page.click('button:has-text("Create page")');
await page.waitForTimeout(1500);
check('create navigates to the saved page', /\/dashboard\/pages\/[0-9a-f-]{36}$/.test(page.url()), page.url());
const url1 = (await page.locator('code.font-mono').first().textContent()).trim();
check('path materialised by the database trigger',
  url1 === '/system-design/load-balancer/consistent-hashing', url1);

/* ---- it is live ---- */
const pub = await browser.newPage();
await pub.goto(`${BASE}/system-design/load-balancer/consistent-hashing`, { waitUntil: 'networkidle' });
check('a public page is live at its derived URL',
  await pub.locator('article h1', { hasText: 'Consistent Hashing' }).isVisible());

/* ---- rename -> redirect ---- */
await page.fill('#slug', 'ring-hashing');
await page.click('button:has-text("Save")');
await page.waitForTimeout(1500);
await pub.goto(`${BASE}/system-design/load-balancer/consistent-hashing`, { waitUntil: 'networkidle' });
await pub.waitForTimeout(1500);
check('the old URL redirects after a rename',
  pub.url().endsWith('/system-design/load-balancer/ring-hashing'), pub.url());

/* ---- move -> redirect ---- */
await page.goto(`${BASE}/dashboard/all`, { waitUntil: 'networkidle' });
await page.waitForSelector('table');
await expandAll(page);
const row = page.locator('tr', { has: page.locator('a:text-is("Consistent Hashing")') }).first();
await row.hover();
await row.locator('button[aria-label*="somewhere else"]').click();
await page.waitForSelector('#move-parent');
const cache = await page.locator('#move-parent option', { hasText: 'Caching' }).first().getAttribute('value');
await page.selectOption('#move-parent', cache);
await page.waitForTimeout(200);
check('the move dialog previews the new URL',
  (await page.locator('[role=dialog] code').textContent()).includes('caching/ring-hashing'));
await page.click('[role=dialog] button:has-text("Move page")');
await page.waitForTimeout(1500);
await pub.goto(`${BASE}/system-design/load-balancer/ring-hashing`, { waitUntil: 'networkidle' });
await pub.waitForTimeout(1500);
check('the URL redirects after a move too',
  pub.url().endsWith('/system-design/caching/ring-hashing'), pub.url());

/* ---- delete guard ---- */
await page.goto(`${BASE}/dashboard/all`, { waitUntil: 'networkidle' });
await page.waitForSelector('table');
await expandAll(page);
const rl = page.locator('tr', { has: page.locator('a:text-is("Rate Limiter")') }).first();
await rl.hover();
await rl.locator('button[aria-label^="Delete"]').click();
await page.waitForSelector('[role=dialog]');
await page.waitForTimeout(900);
check('the delete dialog states the blast radius',
  (await page.locator('[role=dialog]').textContent()).includes('permanently delete 4 pages'),
  (await page.locator('[role=dialog]').textContent()).slice(0, 80).replace(/\s+/g, ' '));
check('deleting a section is disabled until the title is typed',
  await page.locator('[role=dialog] button:has-text("Delete all")').isDisabled());
await page.fill('#confirm-title', 'Rate Limiter');
check('confirmation arms the button',
  await page.locator('[role=dialog] button:has-text("Delete all")').isEnabled());
await page.click('[role=dialog] button:has-text("Cancel")');

/* ---- visibility straight from the tree ---- */
const gin = page.locator('tr', { has: page.locator('a:text-is("GIN")') }).first();
await gin.locator('select[id^=vis-]').selectOption('collaborative');
await page.waitForTimeout(1500);
check('visibility can be changed from the tree',
  /shared/i.test(await gin.textContent()),
  (await gin.textContent()).replace(/\s+/g, ' ').slice(0, 40));

/* ---- reorder ---- */
const before = await page.locator('tbody tr td:first-child a').allTextContents();
const first = page.locator('tbody tr').first();
await first.hover();
await first.locator('button[aria-label="Move down"]').click();
await page.waitForTimeout(1500);
const after = await page.locator('tbody tr td:first-child a').allTextContents();
check('reordering changes sibling order', before[0] !== after[0], `${before[0]} → ${after[0]}`);

check('no console errors', errors.length === 0, errors.slice(0, 2).join(' | '));

await browser.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
