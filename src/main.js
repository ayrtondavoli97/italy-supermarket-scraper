/**
 * Italy Supermarket Scraper
 * v1.0 — Esselunga (spesaonline.esselunga.it)
 * Input: categoria (optional), query (optional), maxItems
 * Output: nome, prezzo, prezzoAlKg, marca, categoria, immagine, url
 */

import { Actor } from 'apify';
import { PlaywrightCrawler } from 'crawlee';

// Esselunga category slugs (from site navigation)
const CATEGORIE = {
    'frutta-verdura': 'frutta-e-verdura',
    'carne': 'carne',
    'pesce': 'pesce',
    'salumi-formaggi': 'salumi-e-formaggi',
    'pane-pasticceria': 'pane-e-pasticceria',
    'surgelati': 'surgelati',
    'pasta-riso-cereali': 'pasta-riso-e-cereali',
    'sughi-conserve': 'sughi-e-conserve',
    'olio-condimenti': 'olio-e-condimenti',
    'dolci-snack': 'dolci-e-snack',
    'colazione': 'colazione',
    'bevande': 'bevande',
    'vini-birre': 'vini-birre-e-alcolici',
    'acqua': 'acqua',
    'pulizia-casa': 'pulizia-casa',
    'igiene-persona': 'igiene-e-cura-persona',
    'neonati': 'neonati-e-bambini',
    'animali': 'animali',
    'bio': 'bio-e-vegano',
};

const BASE = 'https://spesaonline.esselunga.it';

await Actor.init();

const input = await Actor.getInput() ?? {};
const {
    categoria = '',       // es. 'pasta-riso-cereali' oppure vuoto = tutte
    query = '',           // ricerca per nome prodotto
    maxItems = 2000,
    proxyConfig: proxyConfigInput,
} = input;

const proxyConfiguration = proxyConfigInput
    ? await Actor.createProxyConfiguration(proxyConfigInput)
    : undefined;

console.log(`Categoria="${categoria || 'tutte'}" | Query="${query}" | Max=${maxItems}`);

// Build start URLs
let startUrls = [];

if (query) {
    // Search mode
    startUrls = [{
        url: `${BASE}/search?q=${encodeURIComponent(query)}&page=1`,
        userData: { tipo: 'search', query, page: 1 },
    }];
} else if (categoria) {
    const slug = CATEGORIE[categoria] || categoria;
    startUrls = [{
        url: `${BASE}/categories/${slug}?page=1`,
        userData: { tipo: 'categoria', categoria: slug, page: 1 },
    }];
} else {
    // All categories
    startUrls = Object.values(CATEGORIE).map(slug => ({
        url: `${BASE}/categories/${slug}?page=1`,
        userData: { tipo: 'categoria', categoria: slug, page: 1 },
    }));
}

let collected = 0;

const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    launchContext: { launchOptions: { headless: true } },
    requestHandlerTimeoutSecs: 120,
    maxConcurrency: 3,

    async requestHandler({ page, request, log, addRequests }) {
        const { tipo, categoria: cat, query: q, page: pageNum } = request.userData;
        log.info(`[${tipo}] ${cat || q} page=${pageNum} | ${request.url}`);

        await page.goto(request.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });

        // Dismiss cookie banner if present
        try {
            const cookieBtn = page.locator('button:has-text("Accetta"), button:has-text("Accept"), button:has-text("Accetta tutti"), #onetrust-accept-btn-handler').first();
            if (await cookieBtn.isVisible({ timeout: 4000 })) {
                await cookieBtn.click();
                await page.waitForTimeout(1000);
                log.info('Cookie banner dismissed');
            }
        } catch { /* ignore */ }

        // Wait for product grid
        try {
            await page.waitForSelector(
                '[class*="product"], [class*="Product"], [data-testid*="product"], .card, article',
                { timeout: 20_000 }
            );
        } catch {
            // Save debug HTML on first page
            if (pageNum === 1) {
                const html = await page.content();
                await Actor.setValue(`debug_${cat || q}_p1`, html, { contentType: 'text/html' });
                log.info(`Debug HTML saved`);
            }
            const txt = await page.evaluate(() => document.body.innerText.substring(0, 600));
            log.warning(`No products found:\n${txt}`);
            return;
        }

        const { items, hasNextPage, totalPages } = await page.evaluate((pageNum) => {
            // Product cards
            const cards = [
                ...document.querySelectorAll('[class*="product-card"], [class*="ProductCard"], [data-testid*="product"], .product-item')
            ];

            const items = cards.map(card => {
                const getText = (...sels) => {
                    for (const s of sels) {
                        const el = card.querySelector(s);
                        if (el) return el.textContent.trim();
                    }
                    return '';
                };

                const name = getText(
                    '[class*="product-name"], [class*="ProductName"], [class*="title"], h2, h3, h4, [data-testid*="name"]'
                );
                if (!name) return null;

                const priceText = getText(
                    '[class*="price"]:not([class*="old"]):not([class*="original"]), [data-testid*="price"], [class*="Price"]'
                );
                const price = priceText.match(/[\d,\.]+/)?.[0]?.replace(',', '.') || '';

                const pricePerKgText = getText('[class*="price-per"], [class*="unit-price"], [class*="PricePerUnit"]');
                const pricePerKg = pricePerKgText || '';

                const oldPriceText = getText('[class*="old-price"], [class*="original-price"], [class*="OldPrice"], s');
                const oldPrice = oldPriceText.match(/[\d,\.]+/)?.[0]?.replace(',', '.') || '';

                const brand = getText('[class*="brand"], [class*="Brand"], [data-testid*="brand"]');
                const weight = getText('[class*="weight"], [class*="Weight"], [class*="quantity"], [class*="Quantity"]');
                const badge = getText('[class*="badge"], [class*="promo"], [class*="offer"], [class*="discount"]');

                const imgEl = card.querySelector('img');
                const img = imgEl?.src || imgEl?.getAttribute('data-src') || '';

                const linkEl = card.querySelector('a[href*="/product"], a[href*="/products"], a[href]');
                const url = linkEl?.href || '';

                return { name, price, pricePerKg, oldPrice, brand, weight, promo: badge, img, url };
            }).filter(Boolean);

            // Pagination
            const totalEl = document.querySelector('[class*="total"], [class*="count"], [class*="results"]');
            const totalText = totalEl?.textContent || '';
            const totalMatch = totalText.match(/(\d[\d.]*)/);
            const total = totalMatch ? parseInt(totalMatch[1].replace('.', '')) : 0;

            const nextEl = document.querySelector('a[rel="next"], [class*="next"]:not([disabled]), button[aria-label*="next"]:not([disabled])');
            const hasNextPage = !!nextEl;

            const pageEls = [...document.querySelectorAll('[class*="pagination"] a, [class*="Pagination"] a')]
                .map(el => parseInt(el.textContent.trim()))
                .filter(n => !isNaN(n) && n > 0);
            const totalPages = pageEls.length ? Math.max(...pageEls) : (hasNextPage ? pageNum + 1 : pageNum);

            return { items, hasNextPage, totalPages };
        }, pageNum);

        log.info(`Found ${items.length} products | page ${pageNum}/${totalPages}`);

        for (const item of items) {
            if (collected >= maxItems) break;
            await Actor.pushData({
                ...item,
                supermarket: 'Esselunga',
                categoria: cat || '',
                _scrapeUrl: request.url,
            });
            collected++;
        }

        // Queue next page
        if (hasNextPage && collected < maxItems) {
            const nextPage = pageNum + 1;
            const nextUrl = new URL(request.url);
            nextUrl.searchParams.set('page', nextPage);
            await addRequests([{
                url: nextUrl.toString(),
                userData: { ...request.userData, page: nextPage },
            }]);
        }
    },

    failedRequestHandler({ request, log }) {
        log.error(`Failed: ${request.url}`);
    },
});

await crawler.run(startUrls);
console.log(`Done. Total saved: ${collected} products.`);
await Actor.exit();
