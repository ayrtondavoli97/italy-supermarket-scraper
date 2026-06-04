/**
 * Italy Supermarket Scraper — Esselunga
 * spesaonline.esselunga.it
 */

import { Actor } from 'apify';
import { PlaywrightCrawler } from 'crawlee';

const BASE = 'https://spesaonline.esselunga.it';
const NAV  = `${BASE}/commerce/nav/supermercato`;

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

const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    launchContext: { launchOptions: { headless: true } },
    requestHandlerTimeoutSecs: 180,
    maxConcurrency: 2,

    async requestHandler({ page, request, log, addRequests }) {
        const { tipo, slug, catName, page: pageNum = 1 } = request.userData;

        // ── HOMEPAGE: discover categories ────────────────────────────────
        if (tipo === 'homepage') {
            log.info('Homepage: discovering categories...');
            await page.goto(`${NAV}/store/home`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
            await page.waitForTimeout(3000);
            await dismissCookies(page, log);

            const html = await page.content();
            await Actor.setValue('debug_homepage', html, { contentType: 'text/html' });

            const cats = await page.evaluate(() => {
                return [...document.querySelectorAll('a[href*="/store/menu/"]')].map(a => {
                    const m = a.href.match(/\/store\/menu\/(\d+)\/(.+)/);
                    return m ? { id: m[1], slug: m[2], text: a.textContent.trim(), href: a.href } : null;
                }).filter(Boolean);
            });

            // Deduplicate by slug
            const seen = new Set();
            const unique = cats.filter(c => {
                if (seen.has(c.slug)) return false;
                seen.add(c.slug);
                return true;
            });

            log.info(`Found ${unique.length} categories`);

            let toQueue = unique;
            if (categoria) {
                toQueue = unique.filter(c =>
                    c.slug.includes(categoria.toLowerCase()) ||
                    c.text.toLowerCase().includes(categoria.toLowerCase())
                );
                log.info(`Filtered to ${toQueue.length} matching "${categoria}"`);
            }

            await addRequests(toQueue.map(c => ({
                url: c.href,
                userData: { tipo: 'categoria', slug: c.slug, catName: c.text, storeId: c.id, page: 1 },
            })));
            return;
        }

        // ── CATEGORY or SEARCH page ───────────────────────────────────────
        log.info(`[${tipo}] ${catName || slug || query} page=${pageNum}`);
        await page.goto(request.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        await dismissCookies(page, log);
        await page.waitForTimeout(2000);

        // Save debug HTML on very first page
        if (pageNum === 1 && collected === 0) {
            const html = await page.content();
            await Actor.setValue(`debug_${slug || 'search'}_p1`, html, { contentType: 'text/html' });
        }

        // Log body text for selector debugging
        const bodyTxt = await page.evaluate(() => document.body.innerText.substring(0, 600));
        log.info(`Body:\n${bodyTxt}`);

        // Try to wait for any item/product element
        await page.waitForSelector('li, article, [class*="item"], [class*="card"]', { timeout: 10_000 }).catch(() => {});

        const { items, hasNext } = await page.evaluate(() => {
            // ── helper ──────────────────────────────────────────────────
            const g = (el, ...sels) => {
                for (const s of sels) {
                    try { const f = el.querySelector(s); if (f) return f.textContent.trim(); } catch {}
                }
                return '';
            };

            // ── Find product cards ───────────────────────────────────────
            // Esselunga uses <li> or <article> with product data inside
            // Strategy: find all elements that have both a price AND a product name pattern
            let cards = [];

            // Try specific selectors first
            const specificSels = [
                'li[class*="product"]', 'li[class*="item"]', 'article[class*="product"]',
                '[class*="productCard"]', '[class*="product-card"]', '[class*="ProductCard"]',
                '[class*="item-card"]', '[class*="ItemCard"]', '[class*="grocery-item"]',
            ];
            for (const sel of specificSels) {
                try {
                    const found = [...document.querySelectorAll(sel)];
                    if (found.length > 0) { cards = found; break; }
                } catch {}
            }

            // Fallback: li elements that contain price-like text (€)
            if (cards.length === 0) {
                cards = [...document.querySelectorAll('li, article')].filter(el => {
                    const txt = el.textContent;
                    return txt.includes('€') && txt.trim().length > 20 && txt.trim().length < 2000;
                });
            }

            const items = cards.map(card => {
                const txt = card.textContent;

                // Name: first meaningful text node or heading
                const name = g(card,
                    '[class*="name"]', '[class*="Name"]', '[class*="title"]', '[class*="Title"]',
                    '[class*="denomination"]', '[class*="description"]',
                    'h2', 'h3', 'h4', 'h5', 'p[class*="name"]'
                ) || card.querySelector('a')?.textContent.trim() || '';

                if (!name || name.length < 2 || name.length > 200) return null;

                // Price: look for € pattern
                const priceMatch = txt.match(/(\d+[,\.]\d{2})\s*€|€\s*(\d+[,\.]\d{2})/);
                const price = priceMatch ? (priceMatch[1] || priceMatch[2]).replace(',', '.') : '';

                // Price per kg
                const unitMatch = txt.match(/(\d+[,\.]\d+)\s*€\s*\/\s*(kg|l|lt|pz)/i);
                const pricePerUnit = unitMatch ? `${unitMatch[1]}€/${unitMatch[2]}` : '';

                // Old price (strikethrough)
                const oldEl = card.querySelector('s, del, [class*="old"], [class*="strike"], [class*="original"]');
                const oldPriceMatch = oldEl?.textContent.match(/(\d+[,\.]\d{2})/);
                const oldPrice = oldPriceMatch ? oldPriceMatch[1].replace(',', '.') : '';

                // Brand
                const brand = g(card, '[class*="brand"]', '[class*="Brand"]', '[class*="manufacturer"]');

                // Weight/format
                const weight = g(card, '[class*="weight"]', '[class*="format"]', '[class*="quantity"]', '[class*="size"]');

                // Promo badge
                const badge = g(card, '[class*="badge"]', '[class*="promo"]', '[class*="offer"]', '[class*="discount"]', '[class*="tag"]');

                // Image
                const img = card.querySelector('img')?.src || card.querySelector('img')?.dataset?.src || '';

                // Link
                const link = card.querySelector('a[href*="/store/"]') || card.querySelector('a');
                const url = link?.href || '';

                return { name, price, oldPrice, pricePerUnit, brand, weight, promo: badge, img, url };
            }).filter(Boolean);

            // ── Next page ────────────────────────────────────────────────
            // Esselunga uses scroll/infinite scroll OR next button
            // Look for pagination buttons without :has-text (not valid in querySelector)
            let hasNext = false;
            const allBtns = [...document.querySelectorAll('button, a')];
            const nextBtn = allBtns.find(el => {
                const t = el.textContent.trim().toLowerCase();
                return (t === '>' || t === '›' || t === 'successiva' || t === 'next' || t === 'avanti') &&
                    !el.disabled && !el.hasAttribute('disabled');
            });
            if (nextBtn) hasNext = true;

            // Also check for "load more" button
            const loadMore = allBtns.find(el => {
                const t = el.textContent.trim().toLowerCase();
                return t.includes('carica altri') || t.includes('mostra altri') || t.includes('load more');
            });
            if (loadMore) hasNext = true;

            return { items, hasNext };
        });

        log.info(`${slug} page=${pageNum}: ${items.length} products | hasNext=${hasNext}`);

        for (const item of items) {
            if (collected >= maxItems) break;
            await Actor.pushData({
                ...item,
                supermarket: 'Esselunga',
                categoria: catName || slug || '',
            });
            collected++;
        }

        // Next page
        if (hasNext && collected < maxItems) {
            // Try clicking next button via Playwright
            try {
                const nextClicked = await page.evaluate(() => {
                    const btn = [...document.querySelectorAll('button, a')].find(el => {
                        const t = el.textContent.trim().toLowerCase();
                        return t === '>' || t === '›' || t === 'successiva' || t.includes('carica altri');
                    });
                    if (btn) { btn.click(); return true; }
                    return false;
                });
                if (nextClicked) {
                    await page.waitForTimeout(3000);
                    // Re-scrape after click (inline pagination)
                    const moreItems = await page.evaluate(() => {
                        // same logic as above but abbreviated
                        return [...document.querySelectorAll('li, article')].filter(el =>
                            el.textContent.includes('€') && el.textContent.trim().length > 20
                        ).length;
                    });
                    log.info(`After next click: ${moreItems} items in DOM`);
                }
            } catch { /* ignore */ }

            // Queue next URL for scroll-type pagination
            const nextUrl = new URL(request.url);
            const cur = parseInt(nextUrl.searchParams.get('page') || '1');
            nextUrl.searchParams.set('page', cur + 1);
            await addRequests([{
                url: nextUrl.toString(),
                userData: { ...request.userData, page: cur + 1 },
            }]);
        }
    },

    failedRequestHandler({ request, log }) {
        log.error(`Failed: ${request.url}`);
    },
});

const startRequests = query
    ? [{ url: `${NAV}/store/search?term=${encodeURIComponent(query)}&page=1`, userData: { tipo: 'search', slug: 'search', page: 1 } }]
    : [{ url: `${NAV}/store/home`, userData: { tipo: 'homepage' } }];

await crawler.run(startRequests);
console.log(`Done. Total saved: ${collected} products.`);
await Actor.exit();

// ── Cookie dismiss (Playwright API, outside page.evaluate) ───────────────────
async function dismissCookies(page, log) {
    const texts = ['Accetta tutti', 'Accetta', 'Chiudi', 'OK', 'Got it'];
    for (const text of texts) {
        try {
            // Use Playwright locator (not querySelector) so :has-text works
            const btn = page.locator(`button:has-text("${text}")`).first();
            if (await btn.isVisible({ timeout: 1500 })) {
                await btn.click();
                await page.waitForTimeout(800);
                log.info(`Cookie dismissed: "${text}"`);
                return;
            }
        } catch { /* ignore */ }
    }
    // Fallback: onetrust
    try {
        const ot = page.locator('#onetrust-accept-btn-handler').first();
        if (await ot.isVisible({ timeout: 1500 })) { await ot.click(); }
    } catch { /* ignore */ }
}
