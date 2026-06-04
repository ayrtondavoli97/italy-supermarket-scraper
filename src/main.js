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
const { categoria = '', query = '', maxItems = 2000, proxyConfig: proxyConfigInput } = input;

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

        // ── HOMEPAGE ──────────────────────────────────────────────────────
        if (tipo === 'homepage') {
            log.info('Homepage: discovering categories...');
            await page.goto(`${NAV}/store/home`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
            await page.waitForTimeout(3000);
            await dismissCookies(page, log);

            const cats = await page.evaluate(() => {
                const seen = new Set();
                return [...document.querySelectorAll('a[href*="/store/menu/"]')].map(a => {
                    const m = a.href.match(/\/store\/menu\/(\d+)\/(.+)/);
                    return m ? { id: m[1], slug: m[2], text: a.textContent.trim(), href: a.href } : null;
                }).filter(c => {
                    if (!c || seen.has(c.slug)) return false;
                    seen.add(c.slug);
                    return true;
                });
            });

            log.info(`Found ${cats.length} categories`);

            let toQueue = cats;
            if (categoria) {
                toQueue = cats.filter(c =>
                    c.slug.includes(categoria.toLowerCase()) ||
                    c.text.toLowerCase().includes(categoria.toLowerCase())
                );
            }

            await addRequests(toQueue.map(c => ({
                url: c.href,
                userData: { tipo: 'categoria', slug: c.slug, catName: c.text, page: 1 },
            })));
            return;
        }

        // ── CATEGORY / SEARCH ─────────────────────────────────────────────
        log.info(`[${tipo}] ${catName || slug || query} page=${pageNum}`);
        await page.goto(request.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        await dismissCookies(page, log);
        await page.waitForTimeout(2000);

        // Save debug HTML on very first scrape
        if (pageNum === 1 && collected === 0) {
            const html = await page.content();
            await Actor.setValue(`debug_${slug || 'search'}_p1`, html, { contentType: 'text/html' });
            log.info(`Debug HTML saved: debug_${slug || 'search'}_p1`);
        }

        const { items, hasNext, debugInfo } = await page.evaluate(() => {
            const g = (el, ...sels) => {
                for (const s of sels) {
                    try { const f = el.querySelector(s); if (f) return f.textContent.trim(); } catch {}
                }
                return '';
            };

            // ── Find the main content area (exclude nav/header/footer) ───
            const main = document.querySelector('main, [role="main"], #main-content, [class*="main-content"], [class*="MainContent"]')
                || document.body;

            // ── Try specific product card selectors ───────────────────────
            let cards = [];
            const specificSels = [
                'li[class*="product"]', 'li[class*="Product"]',
                'article[class*="product"]', 'article[class*="Product"]',
                '[class*="productCard"]', '[class*="ProductCard"]',
                '[class*="product-card"]', '[class*="product-item"]',
                '[class*="grocery-item"]', '[class*="GroceryItem"]',
                '[class*="catalog-item"]', '[class*="CatalogItem"]',
                '[data-testid*="product"]', '[data-product]',
            ];

            for (const sel of specificSels) {
                try {
                    const found = [...main.querySelectorAll(sel)];
                    if (found.length > 2) { cards = found; break; }
                } catch {}
            }

            // ── Fallback: li/article with € but NOT inside nav/menu ───────
            if (cards.length === 0) {
                // Exclude navigation containers
                const navSels = ['nav', 'header', 'footer', '[class*="nav"]', '[class*="Nav"]',
                    '[class*="menu"]', '[class*="Menu"]', '[class*="sidebar"]', '[class*="Sidebar"]',
                    '[class*="breadcrumb"]', '[role="navigation"]'];

                const allItems = [...document.querySelectorAll('li, article')];
                cards = allItems.filter(el => {
                    // Must contain €
                    if (!el.textContent.includes('€')) return false;
                    // Text length sanity check
                    const len = el.textContent.trim().length;
                    if (len < 10 || len > 3000) return false;
                    // Must NOT be inside nav/menu/header/footer
                    for (const navSel of navSels) {
                        try { if (el.closest(navSel)) return false; } catch {}
                    }
                    return true;
                });
            }

            // Debug info
            const debugInfo = {
                mainTag: main.tagName,
                mainClass: main.className?.substring(0, 100),
                cardsFound: cards.length,
                firstCardHTML: cards[0]?.outerHTML?.substring(0, 300) || '',
            };

            // ── Parse cards ───────────────────────────────────────────────
            const items = cards.map(card => {
                const name = g(card,
                    '[class*="name"]', '[class*="Name"]', '[class*="title"]', '[class*="Title"]',
                    '[class*="denomination"]', '[class*="description"]',
                    'h2', 'h3', 'h4', 'h5'
                );
                if (!name || name.length < 2 || name.length > 300) return null;

                // Price via regex on full text
                const txt = card.textContent;
                const priceMatch = txt.match(/(\d{1,3}(?:[.,]\d{3})*[.,]\d{2})\s*€|€\s*(\d{1,3}(?:[.,]\d{3})*[.,]\d{2})/);
                const price = priceMatch
                    ? (priceMatch[1] || priceMatch[2]).replace(',', '.')
                    : '';

                const oldEl = card.querySelector('s, del, [class*="old"], [class*="strike"], [class*="original"], [class*="barred"]');
                const oldPriceMatch = oldEl?.textContent.match(/(\d+[,\.]\d{2})/);
                const oldPrice = oldPriceMatch ? oldPriceMatch[1].replace(',', '.') : '';

                const unitMatch = txt.match(/(\d+[,\.]\d+)\s*€\s*\/\s*(kg|l|lt|g|ml|pz)/i);
                const pricePerUnit = unitMatch ? `${unitMatch[1].replace(',', '.')}€/${unitMatch[2]}` : '';

                const brand = g(card, '[class*="brand"]', '[class*="Brand"]', '[class*="manufacturer"]');
                const weight = g(card, '[class*="weight"]', '[class*="Weight"]', '[class*="format"]', '[class*="size"]', '[class*="quantity"]');
                const promo = g(card, '[class*="badge"]', '[class*="Badge"]', '[class*="promo"]', '[class*="offer"]', '[class*="discount"]', '[class*="tag"]');

                const img = card.querySelector('img')?.src || card.querySelector('img')?.dataset?.src || '';
                const link = card.querySelector('a[href*="/store/"]') || card.querySelector('a');
                const url = link?.href || '';

                return { name, price, oldPrice, pricePerUnit, brand, weight, promo, img, url };
            }).filter(Boolean);

            // ── Next page ─────────────────────────────────────────────────
            const hasNext = !!([...document.querySelectorAll('button, a')].find(el => {
                const t = el.textContent.trim().toLowerCase();
                return (t === '>' || t === '›' || t === 'successiva' || t === 'next') &&
                    !el.disabled && !el.hasAttribute('disabled');
            }));

            return { items, hasNext, debugInfo };
        });

        log.info(`${slug} page=${pageNum}: ${items.length} products | hasNext=${hasNext}`);
        log.info(`Debug: main=${debugInfo.mainTag}.${debugInfo.mainClass} | cards=${debugInfo.cardsFound}`);
        if (debugInfo.firstCardHTML) log.info(`First card HTML: ${debugInfo.firstCardHTML}`);

        for (const item of items) {
            if (collected >= maxItems) break;
            await Actor.pushData({ ...item, supermarket: 'Esselunga', categoria: catName || slug || '' });
            collected++;
        }

        if (hasNext && collected < maxItems) {
            const nextUrl = new URL(request.url);
            const cur = parseInt(nextUrl.searchParams.get('page') || '1');
            nextUrl.searchParams.set('page', cur + 1);
            await addRequests([{ url: nextUrl.toString(), userData: { ...request.userData, page: cur + 1 } }]);
        }
    },

    failedRequestHandler({ request, log }) { log.error(`Failed: ${request.url}`); },
});

const startRequests = query
    ? [{ url: `${NAV}/store/search?term=${encodeURIComponent(query)}&page=1`, userData: { tipo: 'search', slug: 'search', page: 1 } }]
    : [{ url: `${NAV}/store/home`, userData: { tipo: 'homepage' } }];

await crawler.run(startRequests);
console.log(`Done. Total saved: ${collected} products.`);
await Actor.exit();

async function dismissCookies(page, log) {
    for (const text of ['Accetta tutti', 'Accetta', 'Chiudi', 'OK']) {
        try {
            const btn = page.locator(`button:has-text("${text}")`).first();
            if (await btn.isVisible({ timeout: 1500 })) {
                await btn.click();
                await page.waitForTimeout(800);
                log.info(`Cookie dismissed: "${text}"`);
                return;
            }
        } catch { /* ignore */ }
    }
}
