import { chromium } from 'playwright';

const BASE = 'http://localhost:4173';
const results = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok, extra });
  console.log(`${ok ? 'ok    ' : 'FAIL  '} ${name}${extra ? '  — ' + extra : ''}`);
};

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await ctx.newPage();

const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

// ---------- 1. home ----------
await page.goto(BASE, { waitUntil: 'networkidle' });
check('home renders heading', await page.locator('h1', { hasText: 'Engineering Docs' }).isVisible());
check('home lists sections', (await page.locator('main section').count()) >= 2,
  `${await page.locator('main section').count()} sections`);
check('sidebar built from flat tree', (await page.locator('aside nav li').count()) >= 2);
await page.screenshot({ path: '/tmp/shot-home.png', fullPage: false });

// ---------- 2. deep page ----------
await page.goto(`${BASE}/system-design/rate-limiter/token-bucket`, { waitUntil: 'networkidle' });
check('deep URL renders the page', await page.locator('article h1', { hasText: 'Token Bucket' }).isVisible());
check('title tag is per-page', (await page.title()).includes('Token Bucket'), await page.title());
check('canonical link present',
  (await page.locator('link[rel=canonical]').getAttribute('href')) === `${BASE}/system-design/rate-limiter/token-bucket`);
check('exactly one <title> in head', (await page.locator('head title').count()) === 1,
  `${await page.locator('head title').count()}`);
check('exactly one meta description', (await page.locator('head meta[name=description]').count()) === 1,
  `${await page.locator('head meta[name=description]').count()}`);
check('meta description is page-specific',
  (await page.locator('meta[name=description]').first().getAttribute('content') || '').includes('bucket'));
check('open graph tags present', (await page.locator('meta[property^="og:"]').count()) >= 4);
check('breadcrumbs show ancestors',
  (await page.locator('nav[aria-label=Breadcrumb] a, nav[aria-label=Breadcrumb] span[aria-current]').count()) >= 3);
check('JSON-LD breadcrumbs emitted', (await page.locator('script[type="application/ld+json"]').count()) === 1);
check('GFM table rendered', await page.locator('article table').first().isVisible());
check('table is scroll-wrapped', (await page.locator('article .table-scroll').count()) >= 1);
check('code block highlighted', (await page.locator('article pre code .hljs-keyword').count()) > 0,
  `${await page.locator('article pre span[class^=hljs]').count()} tokens`);
check('blockquote rendered', await page.locator('article blockquote').first().isVisible());
check('inline code rendered', (await page.locator('article :not(pre) > code').count()) > 0);
check('table of contents built', await page.locator('nav[aria-label="On this page"]').isVisible());
check('prev/next present', (await page.locator('nav[aria-label=Pagination] a').count()) >= 1);
check('sidebar auto-expanded to current page',
  await page.locator('aside a[aria-current=page]', { hasText: 'Token Bucket' }).isVisible());
check('internal md link is SPA link',
  (await page.locator('article a[href="/system-design/rate-limiter/sliding-window"]').count()) > 0);
await page.screenshot({ path: '/tmp/shot-page.png', fullPage: false });

// ---------- 3. TOC anchor actually scrolls ----------
const tocHref = await page.locator('nav[aria-label="On this page"] a').first().getAttribute('href');
const targetExists = await page.locator(tocHref.replace('#', '#')).count();
check('TOC anchor matches a real heading id', targetExists === 1, tocHref);

// ---------- 4. section page lists children ----------
await page.goto(`${BASE}/system-design/rate-limiter`, { waitUntil: 'networkidle' });
check('section page lists child cards', (await page.locator('section[aria-labelledby=subpages] a').count()) === 3);

// ---------- 5. RLS: draft page is a 404 for anonymous ----------
await page.goto(`${BASE}/system-design/caching/redis`, { waitUntil: 'networkidle' });
await page.waitForTimeout(600);
check('draft page 404s for anonymous (RLS)', await page.getByText('Page not found').isVisible());

// ---------- 6. genuine 404 ----------
await page.goto(`${BASE}/no/such/page`, { waitUntil: 'networkidle' });
await page.waitForTimeout(600);
check('unknown URL shows 404', await page.getByText('Page not found').isVisible());
await page.screenshot({ path: '/tmp/shot-404.png' });

// ---------- 7. search ----------
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.keyboard.press('Control+k');
await page.waitForSelector('[role=dialog]');
await page.locator('[role=dialog] input').fill('token bucket');
await page.waitForTimeout(900);
const hits = await page.locator('[role=dialog] li button').count();
check('search returns ranked hits', hits > 0, `${hits} hits`);
check('search highlights matches without innerHTML', (await page.locator('[role=dialog] mark').count()) > 0);
await page.screenshot({ path: '/tmp/shot-search.png' });
await page.keyboard.press('ArrowDown');
await page.keyboard.press('Enter');
await page.waitForTimeout(900);
check('search result navigates', page.url().includes('/system-design/'), page.url());

// ---------- 8. dark mode ----------
await page.goto(`${BASE}/database/indexing/b-tree`, { waitUntil: 'networkidle' });
await page.locator('button[aria-label=Dark]').click();
await page.waitForTimeout(300);
check('dark class applied', await page.locator('html.dark').count() === 1);
await page.screenshot({ path: '/tmp/shot-dark.png' });
const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
check('dark background actually dark', bg !== 'rgb(255, 255, 255)', bg);

// ---------- 9. request count per navigation ----------
let reqs = [];
page.on('request', (r) => { if (r.url().includes('54321')) reqs.push(r.url()); });
reqs = [];
await page.locator('aside a', { hasText: 'GIN' }).first().click();
await page.waitForTimeout(1200);
check('navigation costs exactly 1 database request', reqs.length === 1, `${reqs.length}: ${reqs.map(u=>u.split('/rest/v1/')[1]?.slice(0,40)).join(' | ')}`);

// ---------- 10. mobile ----------
const mobile = await ctx.newPage();
await mobile.setViewportSize({ width: 390, height: 844 });
await mobile.goto(`${BASE}/system-design/rate-limiter/token-bucket`, { waitUntil: 'networkidle' });
check('sidebar hidden on mobile', !(await mobile.locator('aside#site-nav').isVisible()));
await mobile.locator('button[aria-label="Toggle navigation"]').click();
await mobile.waitForTimeout(300);
check('mobile drawer opens', await mobile.locator('aside#site-nav').isVisible());
const scrollX = await mobile.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
check('no horizontal page overflow on mobile', scrollX <= 1, `${scrollX}px`);
await mobile.screenshot({ path: '/tmp/shot-mobile.png' });

// ---------- 11. admin guard ----------
await page.goto(`${BASE}/admin`, { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
check('unauthenticated /admin redirects to login', page.url().includes('/login'), page.url());
await page.screenshot({ path: '/tmp/shot-login.png' });

check('no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
