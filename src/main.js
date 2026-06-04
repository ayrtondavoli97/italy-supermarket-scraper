/**
 * Italy Supermarket Scraper — Esselunga
 * spesaonline.esselunga.it
 * Products load async — wait for skeleton to be replaced by real cards
 */

import { Actor } from 'apify';
import { PlaywrightCrawler } from 'crawlee';

const BASE = 'https://spesaonline.esselunga.it';
const NAV  = `${BASE}/commerce/nav/supermercato`;

const KNOWN_CATEGORIES = [
    { slug: 'vita-allaperto',            catName: "Vita all'aperto",              storeId: '300000001002740' },
    { slug: 'outdoor',                   catName: 'Outdoor',                      storeId: '300000001002742' },
    { slug: 'carbonella-e-barbecue',     catName: 'Carbonella e Barbecue',        storeId: '300000001002743' },
    { slug: 'insetticidi-e-repellenti',  catName: 'Insetticidi e Repellenti',     storeId: '300000001015232' },
    { slug: 'giardinaggio',              catName: 'Giardinaggio',                 storeId: '300000001015226' },
    { slug: 'solari',                    catName: 'Solari',                       storeId: '600000001031689' },
    { slug: 'oli-e-abbronzanti',         catName: 'Oli e abbronzanti',            storeId: '600000001031690' },
    { slug: 'solari-viso',               catName: 'Solari viso',                  storeId: '600000001031691' },
    { slug: 'solari-corpo',              catName: 'Solari corpo',                 storeId: '600000001031692' },
    { slug: 'protezione-bambini',        catName: 'Protezione bambini',           storeId: '600000001031695' },
    { slug: 'doposole-e-idratanti',      catName: 'Doposole e idratanti',         storeId: '600000001031696' },
    { slug: 'mondo-bimbi',               catName: 'Mondo bimbi',                  storeId: '600000001048359' },
    { slug: 'frutta-e-verdura',          catName: 'Frutta e Verdura',             storeId: '300000001002007' },
    { slug: 'carne',                     catName: 'Carne',                        storeId: '300000001002027' },
    { slug: 'pesce',                     catName: 'Pesce',                        storeId: '300000001002050' },
    { slug: 'salumi-e-formaggi',         catName: 'Salumi e Formaggi',            storeId: '300000001002033' },
    { slug: 'pane-e-pasticceria',        catName: 'Pane e Pasticceria',           storeId: '300000001021465' },
    { slug: 'bevande',                   catName: 'Bevande',                      storeId: '300000001002399' },
    { slug: 'vini-e-spumanti',           catName: 'Vini e Spumanti',              storeId: '300000001002075' },
    { slug: 'birre-e-alcolici',          catName: 'Birre e Alcolici',             storeId: '300000001002062' },
    { slug: 'pasta-riso-e-cereali',      catName: 'Pasta, Riso e Cereali',        storeId: '300000001002081' },
    { slug: 'sughi-e-conserve',          catName: 'Sughi e Conserve',             storeId: '300000001002206' },
    { slug: 'dolci-e-snack',             catName: 'Dolci e Snack',                storeId: '600000001034067' },
    { slug: 'igiene-e-cura-persona',     catName: 'Igiene e Cura Persona',        storeId: '300000001002264' },
    { slug: 'pulizia-casa',              catName: 'Pulizia Casa',                 storeId: '300000001002278' },
    { slug: 'amici-animali',             catName: 'Amici Animali',                storeId: '300000001024351' },
];

await Actor.init();

const input = await Actor.getInput() ?? {};
const { categoria = '', query = '', maxItems = 2000, proxyConfig: proxyConfigInput } = input;

const proxyConfiguration = proxyConfigInput
    ? await Actor.createProxyConfiguration(proxyConfigInput)
    : undefined;

console.log(`Categoria="${categoria || 'tutte'}" | Query="${query}" | Max=${maxItems}`);

let startUrls;
if (query) {
    startUrls = [{ url: `${NAV}/store/search?term=${encodeURIComponent(query)}&page=1`, userData: { tipo: 'search', slug: 'search', page: 1 } }];
} else {
    let cats = KNOWN_CATEGORIES;
    if (categoria) {
        cats = KNOWN_CATEGORIES.filter(c =>
            c.slug.includes(categoria.toLowerCase()) ||
            c.catName.toLowerCase().includes(categoria.toLowerCase())
        );
        if (cats.length === 0) cats = [{ slug: categoria, catName: categoria, storeId: '300000001003363' }];
    }
    startUrls = cats.map(c => ({
        url: `${NAV}/store/menu/${c.storeId}/${c.slug}`,
        userData: { tipo: 'categoria', slug: c.slug, catName: c.catName, page: 1 },
    }));
}

let collected = 0;

const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    launchContext: { launchOptions: { headless: true } },
    requestHandlerTimeoutSecs: 120,
    maxConcurrency: 2,

    async requestHandler({ page, request, log, addRequests }) {
        const { tipo, slug, catName, page: pageNum = 1 } = request.userData;
        log.info(`[${tipo}] ${catName || slug} page=${pageNum}`);

        await page.goto(request.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        await dismissCookies(page, log);

        // ── Wait for skeleton to disappear and real products to load ─────
        log.info('Waiting for products to load (skeleton → real)...');
        try {
            // Wait until skeleton cards are gone
            await page.waitForFunction(
                () => document.querySelectorAll('.product-card-skeleton').length === 0,
                { timeout: 20_000 }
            );
            log.info('Skeletons gone');
        } catch {
            log.warning('Skeletons still present after 20s');
        }

        // Wait for real product cards to appear
        try {
            await page.waitForSelector(
                '.product-card:not(.product-card-skeleton), [class*="product-card"]:not([class*="skeleton"])',
                { timeout: 15_000 }
            );
            log.info('Real product cards detected');
        } catch {
            log.warning('No real product cards found');
        }

        // Extra buffer
        await page.waitForTimeout(1000);

        // Save debug on first scrape
        if (pageNum === 1 && collected === 0) {
            const html = await page.content();
            await Actor.setValue(`debug_${slug}_loaded`, html, { contentType: 'text/html' });
            log.info('Debug HTML saved (after load)');
        }

        const { items, hasNext, debugInfo } = await page.evaluate(() => {
            const g = (el, ...sels) => {
                for (const s of sels) {
                    try { const f = el.querySelector(s); if (f) return f.textContent.trim(); } catch {}
                }
                return '';
            };

            // Real product cards (exclude skeletons)
            let cards = [...document.querySelectorAll('.product-card:not(.product-card-skeleton)')];

            // Fallback broader selectors
            if (cards.length === 0) {
                cards = [...document.querySelectorAll('[class*="product-card"]:not([class*="skeleton"])')];
            }
            if (cards.length === 0) {
                cards = [...document.querySelectorAll('[class*="ProductCard"]:not([class*="Skeleton"])')];
            }
            // Last resort: any element with price € not in skeleton
            if (cards.length === 0) {
                const skeletonParents = new Set([...document.querySelectorAll('[class*="skeleton"], [class*="Skeleton"]')]);
                const isInSkeleton = el => {
                    let cur = el;
                    while (cur) { if (skeletonParents.has(cur)) return true; cur = cur.parentElement; }
                    return false;
                };
                cards = [...document.querySelectorAll('li, article, div')].filter(el => {
                    if (isInSkeleton(el)) return false;
                    const txt = el.textContent.trim();
                    return txt.includes('€') && txt.length > 20 && txt.length < 1500 &&
                        !el.className?.includes('nav') && !el.className?.includes('menu');
                }).slice(0, 200);
            }

            const debugInfo = {
                skeletons: document.querySelectorAll('.product-card-skeleton').length,
                realCards: document.querySelectorAll('.product-card:not(.product-card-skeleton)').length,
                cardsUsed: cards.length,
                firstClass: cards[0]?.className?.substring(0, 100) || 'none',
                firstHTML: cards[0]?.outerHTML?.substring(0, 500) || 'none',
            };

            const items = cards.map(card => {
                const txt = card.textContent.trim();

                const name = g(card,
                    '.product-card__name', '.product-name', '[class*="name"]',
                    '[class*="title"]', '[class*="denomination"]',
                    'h2', 'h3', 'h4', 'h5', 'p'
                );
                if (!name || name.length < 2 || name.length > 300) return null;

                // Price
                const priceEl = card.querySelector(
                    '.product-card__price, .price:not(.old-price), [class*="price"]:not([class*="old"]):not([class*="skeleton"]):not([class*="kg"])'
                );
                const priceMatch = (priceEl?.textContent || txt).match(/(\d{1,3}(?:[.,]\d{3})*[.,]\d{2})\s*€/);
                const price = priceMatch ? priceMatch[1].replace(',', '.') : '';

                // Old price
                const oldEl = card.querySelector('.old-price, [class*="old-price"], [class*="barred"], s, del');
                const oldPrice = oldEl?.textContent.match(/(\d+[,\.]\d{2})/)?.[1]?.replace(',', '.') || '';

                // Price per unit (€/kg etc)
                const unitEl = card.querySelector('[class*="price-kg"], [class*="price-per"], [class*="priceKg"], [class*="unit-price"]');
                const unitMatch = (unitEl?.textContent || txt).match(/(\d+[,\.]\d+)\s*€\s*\/\s*(kg|l|g|ml|pz)/i);
                const pricePerUnit = unitMatch ? `${unitMatch[1].replace(',', '.')}€/${unitMatch[2]}` : '';

                const brand = g(card, '.product-card__brand', '[class*="brand"]', '[class*="manufacturer"]');
                const weight = g(card, '.product-card__weight', '[class*="weight"]', '[class*="format"]', '[class*="quantity"]', '[class*="size"]');
                const promo = g(card, '.product-card__badge', '[class*="badge"]', '[class*="promo"]', '[class*="offer"]', '[class*="discount"]');

                const img = card.querySelector('img')?.src || card.querySelector('img')?.dataset?.src || '';
                const link = card.querySelector('a');
                const url = link?.href || '';

                return { name, price, oldPrice, pricePerUnit, brand, weight, promo, img, url };
            }).filter(Boolean);

            // Next page
            const hasNext = !!([...document.querySelectorAll('button, a')].find(el => {
                const t = el.textContent.trim().toLowerCase();
                return (t === '>' || t === '›' || t === 'successiva' || t === 'next') &&
                    !el.disabled && !el.hasAttribute('disabled');
            }));

            return { items, hasNext, debugInfo };
        });

        log.info(`${slug} p${pageNum}: ${items.length} products | skeletons=${debugInfo.skeletons} | realCards=${debugInfo.realCards}`);
        if (items.length === 0) {
            log.info(`First card class: ${debugInfo.firstClass}`);
            log.info(`First card HTML: ${debugInfo.firstHTML}`);
        }

        for (const item of items) {
            if (collected >= maxItems) break;
            await Actor.pushData({ ...item, supermarket: 'Esselunga', categoria: catName || slug });
            collected++;
        }

        if (hasNext && collected < maxItems) {
            const nextUrl = new URL(request.url);
            nextUrl.searchParams.set('page', pageNum + 1);
            await addRequests([{ url: nextUrl.toString(), userData: { ...request.userData, page: pageNum + 1 } }]);
        }
    },

    failedRequestHandler({ request, log }) { log.error(`Failed: ${request.url}`); },
});

await crawler.run(startUrls);
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
