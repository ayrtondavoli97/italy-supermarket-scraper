/**
 * Italy Supermarket Scraper — Esselunga
 * spesaonline.esselunga.it
 * Strategy: start directly on known category URLs, skip homepage discovery
 */

import { Actor } from 'apify';
import { PlaywrightCrawler } from 'crawlee';

const BASE = 'https://spesaonline.esselunga.it';
const NAV  = `${BASE}/commerce/nav/supermercato`;

// Known working category URLs discovered from previous runs
// Format: { slug, catName, storeId }
const KNOWN_CATEGORIES = [
    { slug: 'vita-allaperto',           catName: 'Vita all\'aperto',            storeId: '300000001002740' },
    { slug: 'outdoor',                  catName: 'Outdoor',                     storeId: '300000001002742' },
    { slug: 'carbonella-e-barbecue',    catName: 'Carbonella e Barbecue',       storeId: '300000001002743' },
    { slug: 'insetticidi-e-repellenti', catName: 'Insetticidi e Repellenti',    storeId: '300000001015232' },
    { slug: 'giardinaggio',             catName: 'Giardinaggio',                storeId: '300000001015226' },
    { slug: 'solari',                   catName: 'Solari',                      storeId: '600000001031689' },
    { slug: 'oli-e-abbronzanti',        catName: 'Oli e abbronzanti',           storeId: '600000001031690' },
    { slug: 'solari-viso',              catName: 'Solari viso',                 storeId: '600000001031691' },
    { slug: 'solari-corpo',             catName: 'Solari corpo',                storeId: '600000001031692' },
    { slug: 'spray-corpo',              catName: 'Spray corpo',                 storeId: '600000001031693' },
    { slug: 'protezione-bambini',       catName: 'Protezione bambini',          storeId: '600000001031695' },
    { slug: 'doposole-e-idratanti',     catName: 'Doposole e idratanti',        storeId: '600000001031696' },
    { slug: 'mondo-bimbi',              catName: 'Mondo bimbi',                 storeId: '600000001048359' },
    { slug: 'latte-bimbi',              catName: 'Latte bimbi',                 storeId: '600000001048536' },
    { slug: 'babyfood',                 catName: 'Babyfood',                    storeId: '600000001048541' },
    { slug: 'biberon-e-succhietti',     catName: 'Biberon e succhietti',        storeId: '600000001048542' },
    { slug: 'igiene-e-cura-corpo-bimbi',catName: 'Igiene e cura corpo bimbi',   storeId: '600000001048543' },
    { slug: 'pannolini-e-salviettine',  catName: 'Pannolini e salviettine',     storeId: '600000001048544' },
    { slug: 'tempo-libero-e-outdoor',   catName: 'Tempo libero e Outdoor',      storeId: '600000001048545' },
    { slug: 'multimediacancelleriagiocattoli', catName: 'Multimedia,Cancelleria,Giocattoli', storeId: '600000001048546' },
    { slug: 'tutte-le-novita',          catName: 'Tutte le novità',             storeId: '600000001048547' },
    // Main supermercato categories (to discover more, use debug_homepage KV)
    { slug: 'supermercato',             catName: 'Supermercato',                storeId: '300000001003363' },
    { slug: 'frutta-e-verdura',         catName: 'Frutta e Verdura',            storeId: '300000001002007' },
    { slug: 'carne',                    catName: 'Carne',                       storeId: '300000001002027' },
    { slug: 'pesce',                    catName: 'Pesce',                       storeId: '300000001002050' },
    { slug: 'salumi-e-formaggi',        catName: 'Salumi e Formaggi',           storeId: '300000001002033' },
    { slug: 'pane-e-pasticceria',       catName: 'Pane e Pasticceria',          storeId: '300000001021465' },
    { slug: 'bevande',                  catName: 'Bevande',                     storeId: '300000001002399' },
    { slug: 'vini-e-spumanti',          catName: 'Vini e Spumanti',             storeId: '300000001002075' },
    { slug: 'birre-e-alcolici',         catName: 'Birre e Alcolici',            storeId: '300000001002062' },
    { slug: 'pasta-riso-e-cereali',     catName: 'Pasta, Riso e Cereali',       storeId: '300000001002081' },
    { slug: 'sughi-e-conserve',         catName: 'Sughi e Conserve',            storeId: '300000001002206' },
    { slug: 'dolci-e-snack',            catName: 'Dolci e Snack',               storeId: '600000001034067' },
    { slug: 'igiene-e-cura-persona',    catName: 'Igiene e Cura Persona',       storeId: '300000001002264' },
    { slug: 'pulizia-casa',             catName: 'Pulizia Casa',                storeId: '300000001002278' },
    { slug: 'amici-animali',            catName: 'Amici Animali',               storeId: '300000001024351' },
];

await Actor.init();

const input = await Actor.getInput() ?? {};
const { categoria = '', query = '', maxItems = 2000, proxyConfig: proxyConfigInput } = input;

const proxyConfiguration = proxyConfigInput
    ? await Actor.createProxyConfiguration(proxyConfigInput)
    : undefined;

console.log(`Categoria="${categoria || 'tutte'}" | Query="${query}" | Max=${maxItems}`);

// Build start URLs
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
        if (cats.length === 0) {
            // Try as direct slug
            cats = [{ slug: categoria, catName: categoria, storeId: '300000001003363' }];
        }
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
    maxConcurrency: 3,

    async requestHandler({ page, request, log, addRequests }) {
        const { tipo, slug, catName, page: pageNum = 1 } = request.userData;
        log.info(`[${tipo}] ${catName || slug} page=${pageNum}`);

        await page.goto(request.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        await dismissCookies(page, log);
        await page.waitForTimeout(2000);

        // Save debug HTML on very first scrape
        if (pageNum === 1 && collected === 0) {
            const html = await page.content();
            await Actor.setValue(`debug_${slug}_p1`, html, { contentType: 'text/html' });
            log.info(`Debug HTML saved`);
        }

        const { items, hasNext, debugInfo } = await page.evaluate(() => {
            const g = (el, ...sels) => {
                for (const s of sels) {
                    try { const f = el.querySelector(s); if (f) return f.textContent.trim(); } catch {}
                }
                return '';
            };

            // Exclude nav/menu containers
            const excluded = new Set();
            ['nav', 'header', 'footer',
             '[class*="nav-"]', '[class*="Nav"]', '[class*="-nav"]',
             '[class*="menu"]', '[class*="Menu"]',
             '[class*="sidebar"]', '[class*="Sidebar"]',
             '[class*="breadcrumb"]', '[role="navigation"]',
             '[class*="category-list"]', '[class*="CategoryList"]',
            ].forEach(sel => {
                try { document.querySelectorAll(sel).forEach(el => excluded.add(el)); } catch {}
            });

            const isExcluded = el => {
                let cur = el;
                while (cur && cur !== document.body) {
                    if (excluded.has(cur)) return true;
                    cur = cur.parentElement;
                }
                return false;
            };

            // Find product cards
            let cards = [];

            // Try specific selectors
            for (const sel of [
                'li[class*="product"]', 'li[class*="Product"]',
                'article[class*="product"]', 'article[class*="Product"]',
                '[class*="productCard"]', '[class*="ProductCard"]',
                '[class*="product-card"]', '[class*="ProductTile"]',
                '[class*="item-card"]', '[class*="ItemCard"]',
                '[data-testid*="product"]',
            ]) {
                try {
                    const found = [...document.querySelectorAll(sel)].filter(el => !isExcluded(el));
                    if (found.length > 1) { cards = found; break; }
                } catch {}
            }

            // Fallback: li/article with € not in nav
            if (cards.length === 0) {
                cards = [...document.querySelectorAll('li, article')].filter(el => {
                    if (isExcluded(el)) return false;
                    const txt = el.textContent.trim();
                    return txt.includes('€') && txt.length > 15 && txt.length < 2000;
                });
            }

            const debugInfo = {
                cardsFound: cards.length,
                firstCardHTML: cards[0]?.outerHTML?.substring(0, 400) || 'none',
                firstCardClass: cards[0]?.className || 'none',
            };

            const items = cards.map(card => {
                const txt = card.textContent.trim();
                const name = g(card,
                    '[class*="name"]', '[class*="Name"]', '[class*="title"]', '[class*="Title"]',
                    '[class*="denomination"]', 'h2', 'h3', 'h4', 'h5',
                    '[class*="description"]', '[class*="label"]'
                );
                if (!name || name.length < 2 || name.length > 300) return null;

                const priceMatch = txt.match(/(\d{1,3}(?:[.,]\d{3})*[.,]\d{2})\s*€/);
                const price = priceMatch ? priceMatch[1].replace(',', '.') : '';

                const oldEl = card.querySelector('s, del, [class*="old"], [class*="strike"], [class*="barred"]');
                const oldPrice = oldEl?.textContent.match(/(\d+[,\.]\d{2})/)?.[1]?.replace(',', '.') || '';

                const unitMatch = txt.match(/(\d+[,\.]\d+)\s*€\s*\/\s*(kg|l|lt|g|ml|pz)/i);
                const pricePerUnit = unitMatch ? `${unitMatch[1].replace(',', '.')}€/${unitMatch[2]}` : '';

                const brand = g(card, '[class*="brand"]', '[class*="Brand"]', '[class*="manufacturer"]');
                const weight = g(card, '[class*="weight"]', '[class*="format"]', '[class*="size"]', '[class*="quantity"]');
                const promo = g(card, '[class*="badge"]', '[class*="promo"]', '[class*="offer"]', '[class*="discount"]', '[class*="tag"]');
                const img = card.querySelector('img')?.src || '';
                const link = card.querySelector('a[href*="/store/"]') || card.querySelector('a');
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

        log.info(`${slug} p${pageNum}: ${items.length} products | next=${hasNext} | cards=${debugInfo.cardsFound}`);
        log.info(`First card class: "${debugInfo.firstCardClass}"`);
        if (items.length === 0) log.info(`First card HTML: ${debugInfo.firstCardHTML}`);

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
