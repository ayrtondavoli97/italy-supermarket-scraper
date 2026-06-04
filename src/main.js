/**
 * Italy Supermarket Deals Scraper
 * Source: confrontavolantini.com chain pages and full flyers.
 * Input: catena, categoria, maxItems
 * Output: name, catena, priceOffer, priceOriginal, discount, validFrom, validTo, img, url
 */

import { Actor } from 'apify';
import { PlaywrightCrawler } from 'crawlee';

const SOURCES = {
    lidl: { url: 'https://confrontavolantini.com/lidl', name: 'Lidl' },
    eurospin: { url: 'https://confrontavolantini.com/eurospin', name: 'Eurospin' },
    conad: { url: 'https://confrontavolantini.com/conad', name: 'Conad' },
    penny: { url: 'https://confrontavolantini.com/penny', name: 'Penny Market' },
    md: { url: 'https://confrontavolantini.com/md', name: 'MD Discount' },
    aldi: { url: 'https://confrontavolantini.com/aldi', name: 'Aldi' },
    coop: { url: 'https://confrontavolantini.com/coop', name: 'Coop' },
    carrefour: { url: 'https://confrontavolantini.com/carrefour', name: 'Carrefour' },
    esselunga: { url: 'https://confrontavolantini.com/esselunga', name: 'Esselunga' },
};

await Actor.init();

const input = await Actor.getInput() ?? {};
const {
    catena = 'tutti',
    categoria = '',
    maxItems = 500,
    proxyConfig: proxyConfigInput,
} = input;

const proxyConfiguration = proxyConfigInput
    ? await Actor.createProxyConfiguration(proxyConfigInput)
    : undefined;

console.log(`Catena="${catena}" | Categoria="${categoria || 'tutte'}" | Max=${maxItems}`);

const catenaLower = String(catena).toLowerCase();
const sourcesToScrape = catenaLower === 'tutti'
    ? Object.entries(SOURCES)
    : Object.entries(SOURCES).filter(([key]) => key === catenaLower);

if (sourcesToScrape.length === 0) {
    console.error(`Catena non supportata: "${catena}". Usa: ${Object.keys(SOURCES).join(', ')} o "tutti"`);
    await Actor.exit(1);
}

const startUrls = sourcesToScrape.map(([chain, source]) => ({
    url: source.url,
    uniqueKey: `index:${chain}`,
    userData: { chain, chainName: source.name, pageType: 'index', pageNum: 1 },
}));

let collected = 0;
const savedKeys = new Set();

const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    launchContext: { launchOptions: { headless: true } },
    requestHandlerTimeoutSecs: 150,
    navigationTimeoutSecs: 45,
    maxConcurrency: 2,
    preNavigationHooks: [
        async (_context, gotoOptions) => {
            gotoOptions.waitUntil = 'domcontentloaded';
            gotoOptions.timeout = 45_000;
        },
    ],

    async requestHandler({ page, request, log, addRequests }) {
        const { chain, chainName, pageType = 'index', pageNum = 1 } = request.userData;
        let workingPage = page;
        let currentPageType = pageType;
        const apiOffers = [];

        log.info(`${chainName} type=${pageType} page=${pageNum} | ${request.url}`);

        // This captures JSON requests triggered after initial navigation: flyer opening,
        // infinite scroll and "show more" interactions.
        page.on('response', async (response) => {
            const url = response.url();
            const contentType = response.headers()['content-type'] || '';
            if (!contentType.includes('json')) return;
            try {
                const json = await response.json();
                const offers = extractOffersFromJson(json, chainName);
                if (offers.length > 0) {
                    apiOffers.push(...offers);
                    log.info(`API offers from ${url.substring(0, 110)}: ${offers.length}`);
                }
            } catch { /* non-product JSON */ }
        });

        await page.waitForLoadState('domcontentloaded').catch(() => {});
        await dismissCookies(page, log);
        await page.waitForTimeout(1500);

        if (pageType === 'index' && collected < maxItems) {
            const discovered = await discoverFlyerLinks(page, log);
            if (discovered.length > 0) {
                log.info(`Full flyer links found: ${discovered.length} | ${discovered.slice(0, 3).join(', ')}`);
                await addRequests(discovered.map((url, i) => ({
                    url,
                    uniqueKey: `flyer:${chain}:${url}`,
                    userData: { chain, chainName, pageType: 'flyer', pageNum: i + 1 },
                })));
            } else {
                // Some versions of the site expose "Sfoglia" as a JS button without href.
                // Click it in the current context and parse the destination rather than
                // stopping at the seven preview products on the landing page.
                const openedPage = await tryOpenFlyerByClick(page, log);
                if (openedPage) {
                    workingPage = openedPage;
                    currentPageType = 'flyer';
                    await workingPage.waitForLoadState('domcontentloaded').catch(() => {});
                    await workingPage.waitForTimeout(2000);
                    log.info(`Full flyer opened by click: ${workingPage.url()}`);
                } else {
                    log.warning('No full flyer link/button detected; only preview offers can be parsed from this page.');
                }
            }
        }

        if (currentPageType === 'flyer') {
            await expandFlyer(workingPage, log);
        }

        await saveDiagnostics(workingPage, chain, currentPageType, pageNum, log);

        const embeddedOffers = await extractOffersFromEmbeddedJson(workingPage, chainName, log);
        const domOffers = await parseOffersFromDom(workingPage, chainName, log);
        const textOffers = await parseOffersText(workingPage, chainName, log);
        let items = mergeUniqueOffers([...apiOffers, ...embeddedOffers, ...domOffers, ...textOffers]);

        if (categoria) {
            const needle = categoria.toLowerCase();
            items = items.filter((item) =>
                item.categoria?.toLowerCase().includes(needle)
                || item.name?.toLowerCase().includes(needle));
        }

        log.info(`${chainName} ${currentPageType} p${pageNum}: ${items.length} extracted offers`);

        for (const item of items) {
            if (collected >= maxItems) break;
            const key = itemKey(item);
            if (savedKeys.has(key)) continue;
            savedKeys.add(key);
            await Actor.pushData(item);
            collected++;
        }

        if (collected < maxItems) {
            const nextUrl = await workingPage.evaluate(() => {
                const link = document.querySelector('a[rel="next"], a[aria-label*="Successiv" i], a[aria-label*="Next" i]');
                return link?.href || null;
            }).catch(() => null);
            if (nextUrl) {
                await addRequests([{
                    url: nextUrl,
                    uniqueKey: `next:${chain}:${nextUrl}`,
                    userData: { chain, chainName, pageType: currentPageType, pageNum: pageNum + 1 },
                }]);
            }
        }
    },

    failedRequestHandler({ request, log }) {
        log.error(`Failed: ${request.url}`);
    },
});

await crawler.run(startUrls);
console.log(`Done. Total saved: ${collected} offers.`);
await Actor.exit();

async function discoverFlyerLinks(page, log) {
    await page.waitForFunction(() => {
        return [...document.querySelectorAll('a, button, [role="button"]')]
            .some((el) => /sfoglia|apri|visualizza|volantino/i.test(el.textContent || ''));
    }, { timeout: 8000 }).catch(() => {});

    const links = await page.evaluate(() => {
        const matchText = /sfoglia|apri\s+(il\s+)?volantino|visualizza\s+(il\s+)?volantino/i;
        const nodes = [...document.querySelectorAll('a[href], [data-href], [data-url], [onclick]')]
            .filter((el) => matchText.test((el.textContent || '').trim()));
        const preferred = [];
        const fallback = [];
        const seen = new Set();

        for (const el of nodes) {
            const raw = el.href || el.dataset?.href || el.dataset?.url || '';
            let href = raw;
            if (!href && el.getAttribute('onclick')) {
                const match = el.getAttribute('onclick').match(/https?:\/\/[^'"\s)]+|\/[A-Za-z0-9_/?=&%.-]+/);
                href = match?.[0] || '';
            }
            if (!href) continue;
            try { href = new URL(href, location.href).href; } catch { continue; }
            if (seen.has(href)) continue;
            seen.add(href);

            let parent = el;
            let active = false;
            for (let i = 0; parent && i < 7; i++, parent = parent.parentElement) {
                if (/attivo|valido|in corso/i.test(parent.textContent || '')) {
                    active = true;
                    break;
                }
            }
            (active ? preferred : fallback).push(href);
        }
        return [...preferred, ...fallback];
    }).catch(() => []);

    log.info(`Clickable flyer href targets: ${links.length}`);
    return [...new Set(links)].slice(0, 6);
}

async function tryOpenFlyerByClick(page, log) {
    const selector = 'a:has-text("Sfoglia"), button:has-text("Sfoglia"), [role="button"]:has-text("Sfoglia"), a:has-text("Volantino"), button:has-text("Volantino")';
    const button = page.locator(selector).first();
    try {
        if (!(await button.isVisible({ timeout: 4000 }))) return null;
        const before = page.url();
        const popupPromise = page.context().waitForEvent('page', { timeout: 5000 }).catch(() => null);
        await button.click({ timeout: 5000 });
        const popup = await popupPromise;
        if (popup) return popup;
        await page.waitForTimeout(1500);
        if (page.url() !== before) return page;
        log.warning('Sfoglia clicked, but URL did not change; continuing on rendered content.');
        return page;
    } catch (error) {
        log.warning(`Unable to click flyer button: ${error.message}`);
        return null;
    }
}

async function expandFlyer(page, log) {
    for (let cycle = 0; cycle < 6; cycle++) {
        const clicked = await page.evaluate(() => {
            const labels = /mostra\s+altro|carica\s+altro|vedi\s+altro|show\s+more/i;
            const button = [...document.querySelectorAll('button, a, [role="button"]')]
                .find((el) => labels.test((el.textContent || '').trim()));
            if (button) {
                button.click();
                return true;
            }
            return false;
        }).catch(() => false);
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
        await page.waitForTimeout(clicked ? 1400 : 800);
    }
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
    log.info('Flyer expansion/scroll completed');
}

async function saveDiagnostics(page, chain, pageType, pageNum, log) {
    try {
        const prefix = `debug_${chain}_${pageType}_p${pageNum}`;
        const html = await page.content();
        await Actor.setValue(prefix, html, { contentType: 'text/html' });
        const text = await page.evaluate(() => document.body.innerText.substring(0, 1200));
        log.info(`Preview ${pageType}:\n${text}`);
        const screenshot = await page.screenshot({ fullPage: false });
        await Actor.setValue(`${prefix}_screen`, screenshot, { contentType: 'image/png' });
    } catch (error) {
        log.warning(`Diagnostic save failed: ${error.message}`);
    }
}

function extractOffersFromJson(json, chainName) {
    const arrays = [];
    const scan = (value, depth = 0) => {
        if (!value || depth > 6) return;
        if (Array.isArray(value)) {
            arrays.push(value);
            for (const child of value.slice(0, 5)) scan(child, depth + 1);
            return;
        }
        if (typeof value === 'object') {
            for (const child of Object.values(value)) scan(child, depth + 1);
        }
    };
    scan(json);

    const output = [];
    for (const arr of arrays) {
        for (const product of arr) {
            if (!product || typeof product !== 'object' || Array.isArray(product)) continue;
            const name = product.name || product.title || product.description || product.nome || product.label || '';
            const price = product.price ?? product.salePrice ?? product.offerPrice ?? product.prezzoOfferta ?? product.prezzo;
            if (!name || price === undefined || price === null) continue;
            output.push({
                name: String(name).trim(),
                catena: chainName,
                categoria: product.category || product.categoria || '',
                priceOffer: normalizePrice(price),
                priceOriginal: normalizePrice(product.originalPrice ?? product.regularPrice ?? product.prezzoOriginale ?? ''),
                discount: String(product.discount ?? product.sconto ?? product.percentOff ?? ''),
                validFrom: product.validFrom || product.startDate || product.dal || '',
                validTo: product.validTo || product.endDate || product.al || '',
                img: product.image || product.imageUrl || product.img || '',
                url: product.url || product.link || '',
            });
        }
    }
    return mergeUniqueOffers(output);
}

async function extractOffersFromEmbeddedJson(page, chainName, log) {
    const values = await page.evaluate(() => {
        return [...document.querySelectorAll('script[type="application/ld+json"], script#__NEXT_DATA__, script[type="application/json"]')]
            .map((script) => script.textContent)
            .filter(Boolean)
            .map((text) => {
                try { return JSON.parse(text); } catch { return null; }
            })
            .filter(Boolean);
    }).catch(() => []);
    const offers = values.flatMap((value) => extractOffersFromJson(value, chainName));
    log.info(`Embedded JSON offers: ${offers.length}`);
    return offers;
}

async function parseOffersFromDom(page, chainName, log) {
    const offers = await page.evaluate((name) => {
        const priceRx = /(?:€\s*)?(\d{1,4}[,.]\d{2})(?:\s*€)?/;
        const selectors = [
            '[class*="product" i]', '[class*="offer" i]', '[class*="promo" i]',
            '[class*="deal" i]', 'article', '[data-product]', '[itemtype*="Product"]',
        ];
        const nodes = [...new Set(selectors.flatMap((selector) => [...document.querySelectorAll(selector)]))];
        const out = [];
        for (const node of nodes) {
            const text = (node.innerText || '').replace(/\s+/g, ' ').trim();
            const match = text.match(priceRx);
            if (!match || text.length > 350) continue;
            const titleNode = node.querySelector('h1, h2, h3, h4, [class*="title" i], [class*="name" i], strong');
            let productName = (titleNode?.textContent || text.split(match[0])[0]).replace(/\s+/g, ' ').trim();
            if (!productName || productName.length < 3 || productName.length > 120) continue;
            const img = node.querySelector('img')?.src || '';
            const url = node.querySelector('a[href]')?.href || '';
            out.push({ name: productName, catena: name, categoria: '', priceOffer: match[1].replace(',', '.'), priceOriginal: '', discount: '', validFrom: '', validTo: '', img, url });
        }
        return out;
    }, chainName).catch(() => []);
    log.info(`DOM card offers: ${offers.length}`);
    return mergeUniqueOffers(offers);
}

async function parseOffersText(page, chainName, log) {
    const rawText = await page.evaluate(() => document.body.innerText).catch(() => '');
    const lines = rawText.split(/[\n\r]+/).map((line) => line.trim()).filter(Boolean);
    const priceRegex = /^(?:€\s*)?\d{1,4}[,.]\d{2}(?:\s*€)?$/;
    const priceLineIndices = [];
    for (let i = 0; i < lines.length; i++) {
        if (priceRegex.test(lines[i])) priceLineIndices.push(i);
    }
    log.info(`Text length=${rawText.length}; lines=${lines.length}; price lines=${priceLineIndices.length}`);

    const navSkip = new Set(['Home', 'Anteprima', 'Discount', 'Elettronica', 'Animali', 'Bricolage',
        'Salute e Benessere', 'Ultimi Volantini', 'Back to School', 'Iper e Super',
        'Cura casa e corpo', 'beta', 'Sfoglia', 'Attivo', 'Scaduto', 'La tua lista della spesa']);
    const isFormat = (value) => /\d+\s*(ml|g|kg|l|lt|pz|cl)/i.test(value) || /^\d+x/i.test(value);
    const items = [];

    for (const i of priceLineIndices) {
        const price = normalizePrice(lines[i]);
        const previous = lines[i - 1] || '';
        const beforePrevious = lines[i - 2] || '';
        let name = '';
        let format = '';
        if (isFormat(previous) && beforePrevious && !navSkip.has(beforePrevious)) {
            format = previous;
            name = beforePrevious;
        } else if (previous && !navSkip.has(previous) && !isFormat(previous) && !/^\d/.test(previous) && !/^pag\./i.test(previous)) {
            name = previous;
        }
        name = name.replace(/^[^\w\u00C0-\u024F]+/, '').trim();
        if (!name || name.length < 3) continue;
        let validity = '';
        for (let j = Math.max(0, i - 10); j < Math.min(lines.length, i + 3); j++) {
            if (/\d{2}\/\d{2}\/\d{4}/.test(lines[j])) {
                validity = lines[j];
                break;
            }
        }
        items.push({ name, catena: chainName, categoria: '', priceOffer: price, priceOriginal: '', discount: '', validity, validFrom: '', validTo: '', img: '', url: '', format });
    }
    log.info(`Text parsed offers: ${items.length}`);
    return mergeUniqueOffers(items);
}

function normalizePrice(value) {
    return String(value ?? '').replace(/€/g, '').trim().replace(',', '.');
}

function itemKey(item) {
    return `${String(item.catena).toLowerCase()}|${String(item.name).toLowerCase().replace(/\s+/g, ' ').trim()}|${normalizePrice(item.priceOffer)}`;
}

function mergeUniqueOffers(items) {
    const map = new Map();
    for (const item of items) {
        if (!item?.name || !item.priceOffer) continue;
        const key = itemKey(item);
        if (!map.has(key)) map.set(key, item);
    }
    return [...map.values()];
}

async function dismissCookies(page, log) {
    try {
        for (const frame of page.frames()) {
            if (frame.url().includes('sourcepoint') || frame.url().includes('sp-')) {
                const button = frame.locator('button:has-text("Continua senza accettare"), button:has-text("Rifiuta")').first();
                if (await button.isVisible({ timeout: 2000 })) {
                    await button.click();
                    log.info('Cookie dismissed via iframe');
                    return;
                }
            }
        }
    } catch { /* ignore */ }
    for (const text of ['Accetta tutti', 'Accetta', 'OK', 'Continua', 'Accept all', 'Acconsento']) {
        try {
            const button = page.locator(`button:has-text("${text}")`).first();
            if (await button.isVisible({ timeout: 1500 })) {
                await button.click();
                await page.waitForTimeout(500);
                log.info(`Cookie dismissed: "${text}"`);
                return;
            }
        } catch { /* ignore */ }
    }
}
