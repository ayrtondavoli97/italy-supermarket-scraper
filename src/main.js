/**
 * Italy Supermarket Scraper — Esselunga
 * spesaonline.esselunga.it
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
    // Cap categories to scrape based on maxItems (avg ~30 products/cat)
    const catsNeeded = Math.max(1, Math.ceil(maxItems / 30));
    startUrls = cats.slice(0, catsNeeded).map(c => ({
        url: `${NAV}/store/menu/${c.storeId}/${c.slug}`,
        userData: { tipo: 'categoria', slug: c.slug, catName: c.catName, page: 1 },
    }));
}

let collected = 0;

const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    launchContext: { launchOptions: { headless: true } },
    requestHandlerTimeoutSecs: 120,
    maxConcurrency: 5,

    async requestHandler({ page, request, log, addRequests }) {
        const { tipo, slug, catName, page: pageNum = 1 } = request.userData;
        log.info(`[${tipo}] ${catName || slug} page=${pageNum}`);

        await page.goto(request.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        await dismissCookies(page, log);

        // Wait for skeleton to disappear
        try {
            await page.waitForFunction(
                () => document.querySelectorAll('.product-card-skeleton').length === 0,
                { timeout: 10_000 }
            );
        } catch { log.warning('Skeletons still present after 20s'); }

        // Wait for real product links
        try {
            await page.waitForSelector('a[href*="/store/prodotto/"]', { timeout: 8_000 });
            log.info('Products loaded');
        } catch { log.warning('No product links found'); }

        

        const { items, hasNext } = await page.evaluate(() => {
            const g = (el, ...sels) => {
                for (const s of sels) {
                    try { const f = el.querySelector(s); if (f) return f.textContent.trim(); } catch {}
                }
                return '';
            };

            // Find the outermost container per product using product links
            // Each product has a unique /store/prodotto/{id}/ link
            // We find the smallest container that wraps each link uniquely
            const productLinks = [...document.querySelectorAll('a[href*="/store/prodotto/"]')];

            // Deduplicate by href — keep only one link per product URL
            const seen = new Set();
            const uniqueLinks = productLinks.filter(a => {
                const href = a.href;
                if (seen.has(href)) return false;
                seen.add(href);
                return true;
            });

            // For each unique product link, find its card container
            // The card is the closest ancestor with class containing "product-card" or "item"
            // or just use the link's parent if no specific container found
            const cards = uniqueLinks.map(link => {
                // Walk up to find a suitable card container
                let el = link.parentElement;
                while (el && el !== document.body) {
                    const cls = el.className || '';
                    if (cls.includes('product-card') || cls.includes('ProductCard') ||
                        cls.includes('product-item') || cls.includes('ProductItem') ||
                        el.tagName === 'LI' || el.tagName === 'ARTICLE') {
                        return el;
                    }
                    el = el.parentElement;
                }
                return link.parentElement; // fallback
            }).filter(Boolean);

            // Extract data from each card
            const items = cards.map(card => {
                const link = card.querySelector('a[href*="/store/prodotto/"]');
                const url = link?.href || '';
                const txt = card.textContent.trim();

                // Product name — from link text or specific elements
                const name = g(card,
                    '.product-card__name', '.product-card__title',
                    '[class*="name"]', '[class*="title"]', '[class*="denomination"]',
                    'h2', 'h3', 'h4', 'h5'
                ) || link?.textContent.trim() || '';

                if (!name || name.length < 2 || name.length > 300) return null;

                // Price — look for specific price elements first
                const priceEl = card.querySelector(
                    '.product-card__price .price, .product-card__price-value, [class*="price-value"], [class*="priceValue"]'
                );
                const priceMatch = (priceEl?.textContent || '').match(/(\d{1,3}[,\.]\d{2})/)
                    || txt.match(/(\d{1,3}[,\.]\d{2})\s*€/);
                const price = priceMatch ? priceMatch[1].replace(',', '.') : '';

                // Old price
                const oldEl = card.querySelector('.old-price, [class*="old-price"], [class*="barred"], s, del');
                const oldPrice = oldEl?.textContent.match(/(\d+[,\.]\d{2})/)?.[1]?.replace(',', '.') || '';

                // Price per kg/l
                const unitEl = card.querySelector('[class*="price-kg"], [class*="priceKg"], [class*="price-per"], [class*="unit"]');
                const unitMatch = (unitEl?.textContent || txt).match(/(\d+[,\.]\d+)\s*€\s*\/\s*(kg|l|g|ml|pz)/i);
                const pricePerUnit = unitMatch ? `${unitMatch[1].replace(',', '.')}€/${unitMatch[2]}` : '';

                const brand = g(card, '[class*="brand"]', '[class*="Brand"]');
                const weight = g(card, '[class*="weight"]', '[class*="format"]', '[class*="quantity"]');
                const promo = g(card, '[class*="badge"]', '[class*="promo"]', '[class*="offer"]', '[class*="discount"]');
                const img = card.querySelector('img')?.src || '';

                return { name, price, oldPrice, pricePerUnit, brand, weight, promo, img, url };
            }).filter(Boolean);

            // Next page button
            const hasNext = !!([...document.querySelectorAll('button, a')].find(el => {
                const t = el.textContent.trim().toLowerCase();
                return (t === '>' || t === '›' || t === 'successiva' || t === 'next') &&
                    !el.disabled && !el.hasAttribute('disabled');
            }));

            return { items, hasNext };
        });

        log.info(`${slug} p${pageNum}: ${items.length} products | hasNext=${hasNext}`);

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
