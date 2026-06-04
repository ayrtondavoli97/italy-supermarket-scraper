/**
 * Italy Supermarket Scraper — Esselunga
 * Strategy: intercept XHR/fetch API calls that return product JSON
 * This is faster and more reliable than DOM scraping
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

let cats = KNOWN_CATEGORIES;
if (categoria) {
    cats = KNOWN_CATEGORIES.filter(c =>
        c.slug.includes(categoria.toLowerCase()) ||
        c.catName.toLowerCase().includes(categoria.toLowerCase())
    );
    if (cats.length === 0) cats = [{ slug: categoria, catName: categoria, storeId: '300000001003363' }];
}
// Cap by maxItems
const catsNeeded = query ? 1 : Math.max(1, Math.ceil(maxItems / 40));
const catsToScrape = cats.slice(0, catsNeeded);

const startUrls = query
    ? [{ url: `${NAV}/store/search?term=${encodeURIComponent(query)}&page=1`, userData: { slug: 'search', catName: 'Ricerca', page: 1 } }]
    : catsToScrape.map(c => ({
        url: `${NAV}/store/menu/${c.storeId}/${c.slug}`,
        userData: { slug: c.slug, catName: c.catName, page: 1 },
    }));

let collected = 0;

const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    launchContext: { launchOptions: { headless: true } },
    requestHandlerTimeoutSecs: 120,
    maxConcurrency: 2,

    async requestHandler({ page, request, log, addRequests }) {
        const { slug, catName, page: pageNum = 1 } = request.userData;
        log.info(`${catName} page=${pageNum}`);

        // Intercept API responses that contain product data
        const apiResponses = [];
        page.on('response', async response => {
            const url = response.url();
            const ct = response.headers()['content-type'] || '';
            if (!ct.includes('json')) return;
            // Look for product API endpoints
            if (url.includes('/api/') || url.includes('/products') ||
                url.includes('/catalog') || url.includes('/items') ||
                url.includes('prodotti') || url.includes('search')) {
                try {
                    const json = await response.json();
                    apiResponses.push({ url, json });
                    log.info(`API response: ${url.substring(0, 100)} | keys: ${Object.keys(json).join(',').substring(0, 80)}`);
                } catch { /* ignore */ }
            }
        });

        await page.goto(request.url, { waitUntil: 'commit', timeout: 30_000 });
        await dismissCookies(page, log);

        // Wait up to 15s for skeleton to disappear (products to load)
        try {
            await page.waitForFunction(
                () => document.querySelectorAll('.product-card-skeleton').length === 0,
                { timeout: 15_000 }
            );
            log.info('Skeletons gone — products loaded');
        } catch {
            log.warning('Skeletons still present — products may require store selection');
        }

        // Wait a bit more for API calls to complete
        await page.waitForTimeout(2000);

        // Log all intercepted API calls
        log.info(`Intercepted ${apiResponses.length} API responses`);
        if (apiResponses.length > 0) {
            await Actor.setValue(`api_calls_${slug}_p${pageNum}`, apiResponses.map(r => ({ url: r.url, keys: Object.keys(r.json) })));
        }

        // Try to parse from API responses first
        let items = [];
        for (const { url: apiUrl, json } of apiResponses) {
            const parsed = extractProductsFromApi(json, apiUrl);
            if (parsed.length > 0) {
                log.info(`Extracted ${parsed.length} products from API: ${apiUrl.substring(0, 80)}`);
                items = [...items, ...parsed];
            }
        }

        // Fallback: DOM parsing with product links
        if (items.length === 0) {
            items = await page.evaluate(() => {
                const productLinks = [...document.querySelectorAll('a[href*="/store/prodotto/"]')];
                const seen = new Set();
                const unique = productLinks.filter(a => {
                    if (seen.has(a.href)) return false;
                    seen.add(a.href);
                    return true;
                });

                return unique.map(link => {
                    let card = link.parentElement;
                    while (card && card !== document.body) {
                        const cls = card.className || '';
                        if (cls.includes('product-card') || card.tagName === 'LI' || card.tagName === 'ARTICLE') break;
                        card = card.parentElement;
                    }
                    const txt = card?.textContent.trim() || '';
                    const priceMatch = txt.match(/(\d{1,3}[,\.]\d{2})\s*€/);
                    const name = link.textContent.trim() ||
                        card?.querySelector('[class*="name"],[class*="title"],h3,h4')?.textContent.trim() || '';
                    return {
                        name,
                        price: priceMatch ? priceMatch[1].replace(',', '.') : '',
                        oldPrice: '',
                        pricePerUnit: '',
                        brand: '',
                        weight: '',
                        promo: card?.querySelector('[class*="badge"],[class*="promo"]')?.textContent.trim() || '',
                        img: card?.querySelector('img')?.src || '',
                        url: link.href,
                    };
                }).filter(i => i.name && i.name.length > 2);
            });
            log.info(`DOM fallback: ${items.length} products`);
        }

        log.info(`${catName} p${pageNum}: ${items.length} products`);

        for (const item of items) {
            if (collected >= maxItems) break;
            await Actor.pushData({ ...item, supermarket: 'Esselunga', categoria: catName });
            collected++;
        }

        // Check for next page
        const hasNext = await page.evaluate(() => {
            return !!([...document.querySelectorAll('button, a')].find(el => {
                const t = el.textContent.trim().toLowerCase();
                return (t === '>' || t === '›' || t === 'successiva') &&
                    !el.disabled && !el.hasAttribute('disabled');
            }));
        });

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

// Extract products from various API response formats
function extractProductsFromApi(json, apiUrl) {
    const candidates = [
        json.products, json.items, json.data?.products, json.data?.items,
        json.result?.products, json.results, json.catalog, json.entries,
        json.data, Array.isArray(json) ? json : null,
    ].filter(Array.isArray);

    for (const arr of candidates) {
        if (arr.length === 0) continue;
        const first = arr[0];
        // Check it looks like a product (has name/price fields)
        if (first.name || first.denominazione || first.description || first.price || first.prezzoVendita) {
            return arr.map(p => ({
                name: p.name || p.denominazione || p.description || p.titolo || '',
                price: String(p.price || p.prezzoVendita || p.prezzo || ''),
                oldPrice: String(p.oldPrice || p.prezzoOriginale || p.prezzoPieno || ''),
                pricePerUnit: p.pricePerUnit || p.prezzoKg || p.unitPrice || '',
                brand: p.brand || p.marca || '',
                weight: p.weight || p.formato || p.quantity || '',
                promo: p.badge || p.promo || p.offer || '',
                img: p.image || p.imageUrl || p.img || p.foto || '',
                url: p.url || p.link || '',
                sku: p.sku || p.id || p.codice || '',
            })).filter(p => p.name);
        }
    }
    return [];
}

async function dismissCookies(page, log) {
    for (const text of ['Accetta tutti', 'Accetta', 'Chiudi']) {
        try {
            const btn = page.locator(`button:has-text("${text}")`).first();
            if (await btn.isVisible({ timeout: 1500 })) {
                await btn.click();
                await page.waitForTimeout(500);
                log.info(`Cookie dismissed: "${text}"`);
                return;
            }
        } catch { /* ignore */ }
    }
}
