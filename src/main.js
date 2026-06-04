/**
 * Italy Supermarket Scraper — Esselunga
 * URL structure: /commerce/nav/supermercato/store/menu/{storeId}/{categoria}
 * Strategy: 
 *   1. Load homepage to get storeId from navigation links
 *   2. Navigate categories and scrape products
 */

import { Actor } from 'apify';
import { PlaywrightCrawler } from 'crawlee';

// Known store ID from Google search results (main catalog)
// Will also try to extract dynamically from homepage
const DEFAULT_STORE_ID = '600000001041078';
const BASE = 'https://spesaonline.esselunga.it';
const NAV = `${BASE}/commerce/nav/supermercato`;

await Actor.init();

const input = await Actor.getInput() ?? {};
const {
    categoria = '',
    query = '',
    maxItems = 2000,
    proxyConfig: proxyConfigInput,
} = input;

const proxyConfiguration = proxyConfigInput
    ? await Actor.createProxyConfiguration(proxyConfigInput)
    : undefined;

console.log(`Categoria="${categoria || 'tutte'}" | Query="${query}" | Max=${maxItems}`);

let collected = 0;
let storeId = DEFAULT_STORE_ID;

const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    launchContext: { launchOptions: { headless: true } },
    requestHandlerTimeoutSecs: 180,
    maxConcurrency: 2,

    async requestHandler({ page, request, log, addRequests }) {
        const { tipo, slug, page: pageNum = 1 } = request.userData;

        // ── PHASE 1: Homepage — discover store ID and category list ──────
        if (tipo === 'homepage') {
            log.info('Loading homepage to discover store ID and categories...');
            await page.goto(`${NAV}/store/home`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
            await page.waitForTimeout(3000);

            // Dismiss cookie banner
            await dismissCookies(page, log);

            // Save homepage HTML for debug
            const html = await page.content();
            await Actor.setValue('debug_homepage', html, { contentType: 'text/html' });

            // Extract store ID from any link containing /store/menu/
            const discovered = await page.evaluate(() => {
                const links = [...document.querySelectorAll('a[href*="/store/menu/"]')];
                const ids = links.map(a => {
                    const m = a.href.match(/\/store\/menu\/(\d+)\//);
                    return m ? m[1] : null;
                }).filter(Boolean);
                // Get all category slugs
                const cats = links.map(a => {
                    const m = a.href.match(/\/store\/menu\/\d+\/(.+)/);
                    return m ? { slug: m[1], href: a.href, text: a.textContent.trim() } : null;
                }).filter(Boolean);
                return { ids: [...new Set(ids)], cats };
            });

            log.info(`Discovered store IDs: ${JSON.stringify(discovered.ids)}`);
            log.info(`Discovered categories: ${discovered.cats.length}`);
            discovered.cats.slice(0, 10).forEach(c => log.info(`  ${c.text} → ${c.slug}`));

            if (discovered.ids.length > 0) {
                storeId = discovered.ids[0];
                log.info(`Using store ID: ${storeId}`);
            }

            // Queue categories
            let catsToScrape = discovered.cats;
            if (categoria) {
                catsToScrape = catsToScrape.filter(c =>
                    c.slug.toLowerCase().includes(categoria.toLowerCase()) ||
                    c.text.toLowerCase().includes(categoria.toLowerCase())
                );
            }

            if (catsToScrape.length === 0 && storeId) {
                // Fallback: use known catalog URL
                log.info('No categories found from nav, using catalog URL directly');
                catsToScrape = [{ href: `${NAV}/store/menu/${storeId}/catalogo`, slug: 'catalogo', text: 'Catalogo' }];
            }

            const requests = catsToScrape.slice(0, categoria ? 5 : 50).map(c => ({
                url: c.href.startsWith('http') ? c.href : `${BASE}${c.href}`,
                userData: { tipo: 'categoria', slug: c.slug, catName: c.text, page: 1 },
            }));

            await addRequests(requests);
            log.info(`Queued ${requests.length} categories`);
            return;
        }

        // ── PHASE 2: Search ───────────────────────────────────────────────
        if (tipo === 'search') {
            const searchUrl = `${NAV}/store/search?term=${encodeURIComponent(query)}&page=${pageNum}`;
            log.info(`Search: "${query}" page=${pageNum}`);
            await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
            await dismissCookies(page, log);
        }

        // ── PHASE 3: Category page ────────────────────────────────────────
        if (tipo === 'categoria') {
            log.info(`Category: ${slug} page=${pageNum} | ${request.url}`);
            await page.goto(request.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
            await dismissCookies(page, log);
        }

        await page.waitForTimeout(2000);

        // Save debug HTML on first page of first request
        if (pageNum === 1 && collected === 0) {
            const html = await page.content();
            await Actor.setValue(`debug_${slug || 'search'}_p1`, html, { contentType: 'text/html' });
            const txt = await page.evaluate(() => document.body.innerText.substring(0, 800));
            log.info(`Page preview:\n${txt}`);
        }

        // Try to wait for products
        try {
            await page.waitForSelector(
                '[class*="product"], [class*="Product"], [data-testid*="product"], [class*="item-card"], [class*="ItemCard"]',
                { timeout: 15_000 }
            );
        } catch {
            const txt = await page.evaluate(() => document.body.innerText.substring(0, 400));
            log.warning(`No products selector found:\n${txt}`);
            return;
        }

        const { items, hasNext } = await page.evaluate(() => {
            const g = (el, ...sels) => {
                for (const s of sels) { const f = el.querySelector(s); if (f) return f.textContent.trim(); }
                return '';
            };

            const cards = [...document.querySelectorAll(
                '[class*="product-card"], [class*="ProductCard"], [class*="item-card"], [class*="ItemCard"], [class*="product-item"], [class*="ProductItem"]'
            )];

            const items = cards.map(card => {
                const name = g(card,
                    '[class*="product-name"], [class*="ProductName"], [class*="name"], [class*="title"], h2, h3, h4'
                );
                if (!name || name.length < 2) return null;

                const priceEl = card.querySelector('[class*="price"]:not([class*="old"]):not([class*="original"]),[class*="Price"]:not([class*="Old"])');
                const price = priceEl?.textContent.trim().match(/[\d,\.]+/)?.[0]?.replace(',', '.') || '';

                const oldPriceEl = card.querySelector('[class*="old-price"],[class*="OldPrice"],[class*="original-price"],s,del');
                const oldPrice = oldPriceEl?.textContent.trim().match(/[\d,\.]+/)?.[0]?.replace(',', '.') || '';

                const unitEl = card.querySelector('[class*="unit"],[class*="Unit"],[class*="per-kg"],[class*="PerKg"],[class*="price-per"]');
                const pricePerKg = unitEl?.textContent.trim() || '';

                const brand = g(card, '[class*="brand"],[class*="Brand"]');
                const weight = g(card, '[class*="weight"],[class*="Weight"],[class*="quantity"],[class*="Quantity"],[class*="format"],[class*="Format"]');
                const badge = g(card, '[class*="badge"],[class*="Badge"],[class*="promo"],[class*="Promo"],[class*="offer"],[class*="Offer"]');

                const img = card.querySelector('img')?.src || card.querySelector('img')?.dataset.src || '';
                const link = card.querySelector('a');
                const url = link?.href || '';

                return { name, price, oldPrice, pricePerKg, brand, weight, promo: badge, img, url };
            }).filter(Boolean);

            // Next page
            const nextEl = document.querySelector(
                '[class*="next"]:not([disabled]), [aria-label*="next"], button:has-text("Successiva"), a[rel="next"]'
            );
            const hasNext = !!nextEl && !nextEl.hasAttribute('disabled');

            return { items, hasNext };
        });

        log.info(`${slug} page=${pageNum}: ${items.length} products`);

        for (const item of items) {
            if (collected >= maxItems) break;
            await Actor.pushData({
                ...item,
                supermarket: 'Esselunga',
                categoria: slug || '',
            });
            collected++;
        }

        if (hasNext && collected < maxItems) {
            const nextUrl = new URL(request.url);
            const currentPage = parseInt(nextUrl.searchParams.get('page') || '1');
            nextUrl.searchParams.set('page', currentPage + 1);
            await addRequests([{
                url: nextUrl.toString(),
                userData: { ...request.userData, page: currentPage + 1 },
            }]);
        }
    },

    failedRequestHandler({ request, log }) {
        log.error(`Failed: ${request.url}`);
    },
});

// Start with homepage to discover store ID + categories
const startRequests = query
    ? [{ url: `${NAV}/store/search?term=${encodeURIComponent(query)}&page=1`, userData: { tipo: 'search', page: 1 } }]
    : [{ url: `${NAV}/store/home`, userData: { tipo: 'homepage' } }];

await crawler.run(startRequests);
console.log(`Done. Total saved: ${collected} products.`);
await Actor.exit();

async function dismissCookies(page, log) {
    const selectors = [
        '#onetrust-accept-btn-handler',
        'button:has-text("Accetta tutti")',
        'button:has-text("Accetta")',
        'button:has-text("Chiudi")',
        '[class*="cookie"] button',
        '[id*="cookie"] button',
    ];
    for (const sel of selectors) {
        try {
            const btn = page.locator(sel).first();
            if (await btn.isVisible({ timeout: 2000 })) {
                await btn.click();
                await page.waitForTimeout(800);
                log.info(`Cookie dismissed: ${sel}`);
                return;
            }
        } catch { /* ignore */ }
    }
}
