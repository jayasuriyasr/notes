import { chromium } from 'playwright';

const BASE = 'http://localhost:4173';
const results = [];
const check = (n, ok, extra = '') => {
  results.push(ok);
  console.log(`${ok ? 'ok    ' : 'FAIL  '} ${n}${extra ? '  — ' + extra : ''}`);
};

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const errors = [];
const newPage = async () => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(String(e)));
  p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  return p;
};

async function signIn(page, email) {
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.fill('#email', email);
  await page.fill('#password', 'secret123');
  await page.click('button[type=submit]');
  await page.waitForURL('**/dashboard', { timeout: 15000 });
  // The profile — and therefore the role — loads after the redirect, so
  // admin-only navigation appears a beat later than the URL changes.
  await page.waitForSelector('nav a:has-text("People")', { timeout: 10000 }).catch(() => {});
}

/* ═══ 1. REGISTRATION ═══════════════════════════════════════════════ */
const alice = await newPage();
await alice.goto(`${BASE}/register`, { waitUntil: 'networkidle' });
await alice.fill('#displayName', 'Alice Anderson');
await alice.fill('#email', 'alice@example.com');
await alice.fill('#password', 'secret123');
await alice.click('button[type=submit]');
await alice.waitForURL('**/dashboard', { timeout: 15000 });
check('register creates an account and signs in', alice.url().endsWith('/dashboard'), alice.url());
await alice.waitForSelector('text=You have not written anything yet', { timeout: 10000 })
  .catch(() => {});
check('new member sees an empty dashboard',
  await alice.getByText('You have not written anything yet').isVisible());
check('new member is NOT shown admin tabs',
  (await alice.locator('nav a:has-text("People")').count()) === 0);
await alice.screenshot({ path: '/tmp/mu-empty.png' });

/* ═══ 2. CREATE — PRIVATE BY DEFAULT ════════════════════════════════ */
await alice.click('a:has-text("New page")');
await alice.waitForSelector('#title');
await alice.fill('#title', 'Alice Research');
check('new pages default to private',
  await alice.locator('input[name=visibility][value=private]').isChecked());
await alice.fill('#md-source', '# Alice Research\n\nSecret notes.\n\n```js\nconst x = 1;\n```');
await alice.click('button:has-text("Create page")');
await alice.waitForTimeout(1500);
check('page created at a derived URL',
  (await alice.locator('code.font-mono').first().textContent()).trim() === '/alice-research',
  (await alice.locator('code.font-mono').first().textContent()).trim());
await alice.screenshot({ path: '/tmp/mu-editor.png' });

const anon = await newPage();
await anon.goto(`${BASE}/alice-research`, { waitUntil: 'networkidle' });
await anon.waitForTimeout(900);
check('a private page 404s for the public', await anon.getByText('Page not found').isVisible());
await alice.goto(`${BASE}/alice-research`, { waitUntil: 'networkidle' });
check('...but its owner can read it', await alice.locator('article h1').isVisible());
check('owner sees a visibility notice on their own private page',
  await alice.getByText('Only you and administrators can see this page.').isVisible());

/* ═══ 3. PUBLISH ════════════════════════════════════════════════════ */
await alice.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
await alice.selectOption('select[id^=vis-]', 'public');
await alice.waitForTimeout(1500);
await anon.goto(`${BASE}/alice-research`, { waitUntil: 'networkidle' });
await anon.waitForTimeout(600);
check('switching to "anyone can view" publishes it',
  await anon.locator('article h1', { hasText: 'Alice Research' }).isVisible());
check('the byline names the author',
  (await anon.locator('article').textContent()).includes('Alice Anderson'));

/* ═══ 4. COLLABORATIVE EDITING ══════════════════════════════════════ */
await alice.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
await alice.selectOption('select[id^=vis-]', 'collaborative');
await alice.waitForTimeout(1500);

const bob = await newPage();
await bob.goto(`${BASE}/register`, { waitUntil: 'networkidle' });
await bob.fill('#email', 'bob@example.com');
await bob.fill('#password', 'secret123');
await bob.click('button[type=submit]');
await bob.waitForURL('**/dashboard', { timeout: 15000 });

await bob.goto(`${BASE}/alice-research`, { waitUntil: 'networkidle' });
await bob.waitForTimeout(700);
check('a member sees "Edit this page" on a shared page',
  await bob.getByRole('link', { name: /Edit this page/ }).isVisible());
await bob.getByRole('link', { name: /Edit this page/ }).click();
await bob.waitForSelector('#title');
check('guest editor is told what they may change',
  await bob.getByText('This is a shared page owned by someone else').isVisible());
check('guest editor is NOT offered the address field', (await bob.locator('#slug').count()) === 0);
check('guest editor is NOT offered the visibility picker',
  (await bob.locator('input[name=visibility]').count()) === 0);
check('guest editor is NOT offered the section picker', (await bob.locator('#parent').count()) === 0);
await bob.screenshot({ path: '/tmp/mu-guest.png' });

await bob.fill('#title', 'Alice Research (with Bob)');
await bob.click('button:has-text("Save")');
await bob.waitForTimeout(1500);
check('guest edit saves', (await bob.locator('h1').first().textContent()).includes('with Bob'));

await anon.goto(`${BASE}/alice-research`, { waitUntil: 'networkidle' });
await anon.waitForTimeout(600);
check('the edit is live and credits the editor',
  (await anon.locator('article').textContent()).includes('last edited by @bob'));

/* ═══ 5. BOB CANNOT MANAGE ALICE'S PAGE ═════════════════════════════ */
await bob.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
check("a shared page does not appear in the guest's own page list",
  (await bob.locator('tbody tr').count()) === 0, `${await bob.locator('tbody tr').count()} rows`);

/* ═══ 6. PRIVATE INHERITANCE, THROUGH THE UI ════════════════════════ */
await alice.goto(`${BASE}/dashboard/pages/new`, { waitUntil: 'networkidle' });
await alice.fill('#title', 'Vault');
await alice.click('button:has-text("Create page")');
await alice.waitForTimeout(1500);
const vaultUrl = alice.url();
await alice.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
const vaultRow = alice.locator('tr', { has: alice.locator('a:text-is("Vault")') });
await vaultRow.hover();
await vaultRow.locator('button[aria-label*="Add a page inside"]').click();
await alice.waitForSelector('#title');
await alice.fill('#title', 'Inner Note');
await alice.fill('#md-source', '# Inner Note\n\nNested content.');
await alice.click('input[name=visibility][value=public]');
check('the picker warns that a private parent overrides the choice',
  await alice.getByText('This page is private regardless').isVisible());
await alice.screenshot({ path: '/tmp/mu-inherit.png' });
await alice.click('button:has-text("Create page")');
await alice.waitForTimeout(1500);

await anon.goto(`${BASE}/vault/inner-note`, { waitUntil: 'networkidle' });
await anon.waitForTimeout(900);
check('a public page inside a private section is still hidden',
  await anon.getByText('Page not found').isVisible());

await alice.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
const vaultRow2 = alice.locator('tr', { has: alice.locator('a:text-is("Vault")') });
await vaultRow2.locator('select[id^=vis-]').selectOption('public');
await alice.waitForTimeout(1600);
await anon.goto(`${BASE}/vault/inner-note`, { waitUntil: 'networkidle' });
await anon.waitForTimeout(700);
check('opening the parent reveals the child that asked to be public',
  await anon.locator('article h1', { hasText: 'Inner Note' }).isVisible());

/* ═══ 7. ADMIN: PEOPLE ═════════════════════════════════════════════ */
const admin = await newPage();
await signIn(admin, 'admin@example.com');
check('admin sees the People tab', await admin.locator('nav a:has-text("People")').isVisible());
await admin.click('nav a:has-text("People")');
await admin.waitForSelector('table');
const userRows = await admin.locator('tbody tr').count();
check('people list shows every account', userRows >= 3, `${userRows} accounts`);
check('page counts are shown', (await admin.locator('tbody').textContent()).includes('shared'));
await admin.screenshot({ path: '/tmp/mu-people.png' });

const selfRow = admin.locator('tr', { has: admin.locator('text=(you)') });
check('admin cannot demote themselves',
  await selfRow.locator('button:has-text("Demote")').isDisabled());
check('admin cannot delete themselves',
  await selfRow.locator('button:has-text("Delete")').isDisabled());

/* ═══ 8. SUSPENSION ════════════════════════════════════════════════ */
const bobRow = admin.locator('tr', { has: admin.locator('text=@bob') });
await bobRow.locator('button:has-text("Suspend")').click();
await admin.waitForTimeout(1500);
check('suspension is reflected in the list',
  (await bobRow.textContent()).includes('Suspended'));

await bob.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
await bob.waitForTimeout(800);
check('a suspended member is told, not locked out',
  await bob.getByText('Your account is suspended').isVisible());
await bob.screenshot({ path: '/tmp/mu-suspended.png' });
await bob.goto(`${BASE}/alice-research`, { waitUntil: 'networkidle' });
await bob.waitForTimeout(700);
check('a suspended member can still read', await bob.locator('article h1').isVisible());
check('a suspended member is not offered editing',
  (await bob.getByRole('link', { name: /Edit this page/ }).count()) === 0);

await bobRow.locator('button:has-text("Reactivate")').click();
await admin.waitForTimeout(1500);
check('reactivation restores the account', !(await bobRow.textContent()).includes('Suspended'));

/* ═══ 9. NON-ADMIN CANNOT REACH ADMIN ROUTES ═══════════════════════ */
await alice.goto(`${BASE}/dashboard/people`, { waitUntil: 'networkidle' });
await alice.waitForTimeout(900);
check('a member sent to /dashboard/people is bounced',
  alice.url().endsWith('/dashboard'), alice.url());

/* ═══ 10. DELETING A USER TRANSFERS THEIR PAGES ════════════════════ */
await admin.goto(`${BASE}/dashboard/people`, { waitUntil: 'networkidle' });
const aliceRow = admin.locator('tr', { has: admin.locator('text=@alice') });
const alicePages = (await aliceRow.textContent()).match(/(\d+)\s*\(/)?.[1];
await aliceRow.locator('button:has-text("Delete")').click();
await admin.waitForSelector('[role=dialog]');
check('delete dialog states the page transfer',
  (await admin.locator('[role=dialog]').textContent()).includes('will transfer'));
check('delete dialog suggests suspending instead',
  (await admin.locator('[role=dialog]').textContent()).includes('Suspend'));
await admin.screenshot({ path: '/tmp/mu-delete-user.png' });
await admin.click('[role=dialog] button:has-text("Delete account")');
await admin.waitForTimeout(2000);
check('deletion reports how many pages moved',
  (await admin.locator('body').textContent()).includes('transferred to you'),
  (await admin.locator('body').textContent()).match(/Removed @\w+\..{0,40}/)?.[0]);

await anon.goto(`${BASE}/alice-research`, { waitUntil: 'networkidle' });
await anon.waitForTimeout(700);
check("the deleted member's published page survives",
  await anon.locator('article h1').isVisible(), `alice owned ${alicePages} pages`);

check('no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
