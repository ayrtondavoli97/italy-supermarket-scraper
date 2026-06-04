/**
 * Italy Supermarket Deals Scraper
 * Diagnostic build: stores HTML, screenshots, DOM controls and network traces in run storage.
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
    diagnosticMode = true,
    proxyConfig: proxyConfigInput,
} = input;

const proxyConfiguration = proxyConfigInput
    ? await Actor.createProxyConfiguration(proxyConfigInput)
    : undefined;

console.log(`Catena="${catena}" | Categoria="${categoria || 'tutte'}" | Max=${maxItems} | Diagnostics=${diagnosticMode}`);
console.log('DIAGNOSTICS: al termine apri Storage > Key-value store e scarica i record con prefisso debug_.');

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
const diagnosticManifest = [];

const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    launchContext: { launchOptions: { headless: true } },
    requestHandlerTimeoutSecs: 180,
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
        const networkTrace = [];
        const consoleTrace = [];

        log.info(`${chainName} type=${pageType} page=${pageNum} | ${request.url}`);
        attachDiagnosticsListeners(page, networkTrace, consoleTrace, apiOffers, chainName, log);

        await page.waitForLoadState('domcontentloaded').catch(() => {});
        await dismissCookies(page, log);
        await page.waitForTimeout(1500);

        if (diagnosticMode) {
            await saveForensicSnapshot(page, chain, `${pageType}_BEFORE_ACTION`, pageNum, networkTrace, consoleTrace, log);
        }

        if (pageType === 'index' && collected < maxItems) {
            const controls = await inspectFlyerControls(page);
            log.info(`FORENSIC: found ${controls.length} controls containing Sfoglia/Volantino`);
            controls.forEach((control, i) => log.info(`FORENSIC control[${i}]: ${JSON.stringify(control).substring(0, 500)}`));
            if (diagnosticMode) {
                await storeJson(`debug_${chain}_SFOGLIA_CONTROLS`, controls);
                addManifest(`debug_${chain}_SFOGLIA_CONTROLS`, 'Lista completa pulsanti/link Sfoglia e relativo HTML/attributi');
            }

            const discovered = await discoverFlyerLinks(page, log);
            if (diagnosticMode) {
                await storeJson(`debug_${chain}_DISCOVERED_LINKS`, discovered);
                addManifest(`debug_${chain}_DISCOVERED_LINKS`, 'URL volantino trovati prima del click');
            }

            if (discovered.length > 0) {
                log.info(`Full flyer links found: ${discovered.length} | ${discovered.slice(0, 3).join(', ')}`);
                await addRequests(discovered.map((url, i) => ({
                    url,
                    uniqueKey: `flyer:${chain}:${url}`,
                    userData: { chain, chainName, pageType: 'flyer', pageNum: i + 1 },
                })));
            } else {
                const openedPage = await tryOpenFlyerControls(page, chain, networkTrace, consoleTrace, log);
                if (openedPage) {
                    workingPage = openedPage;
                    currentPageType = 'flyer';
                    if (workingPage !== page) {
                        attachDiagnosticsListeners(workingPage, networkTrace, consoleTrace, apiOffers, chainName, log);
                    }
                    await workingPage.waitForLoadState('domcontentloaded').catch(() => {});
                    await workingPage.waitForTimeout(2000);
                    log.info(`Full flyer candidate after click: ${workingPage.url()}`);
                } else {
                    log.warning('No page/modal/iframe/state change detected after every Sfoglia click.');
                }
            }
        }

        if (currentPageType === 'flyer') {
            await expandFlyer(workingPage, log);
        }

        if (diagnosticMode) {
            await saveForensicSnapshot(workingPage, chain, `${currentPageType}_AFTER_ACTION`, pageNum, networkTrace, consoleTrace, log);
        }

        const embeddedOffers = await extractOffersFromEmbeddedJson(workingPage, chainName, log);
        const domOffers = await parseOffersFromDom(workingPage, chainName, log);
        const textOffers = await parseOffersText(workingPage, chainName, log);
        let items = mergeUniqueOffers([...apiOffers, ...embeddedOffers, ...domOffers, ...textOffers]);

        if (categoria) {
            const needle = categoria.toLowerCase();
            items = items.filter((item) => item.categoria?.toLowerCase().includes(needle) || item.name?.toLowerCase().includes(needle));
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
    },

    failedRequestHandler({ request, log }) {
        log.error(`Failed: ${request.url}`);
    },
});

await crawler.run(startUrls);
if (diagnosticMode) {
    await storeJson('debug_MANIFEST_DOWNLOAD_THESE_FILES', diagnosticManifest);
    console.log('DIAGNOSTICS READY: Storage > Key-value store > scarica debug_MANIFEST_DOWNLOAD_THESE_FILES e tutti i file debug_* del supermercato testato.');
}
console.log(`Done. Total saved: ${collected} offers.`);
await Actor.exit();

function attachDiagnosticsListeners(page, networkTrace, consoleTrace, apiOffers, chainName, log) {
    page.on('request', (req) => {
        if (networkTrace.length >= 500) return;
        const url = req.url();
        const resourceType = req.resourceType();
        if (/volantin|flyer|lidl|pdf|\.json|api|catalog|promo|brochure|leaflet|image|\.jpg|\.png/i.test(url) || ['xhr', 'fetch', 'document'].includes(resourceType)) {
            networkTrace.push({ event: 'request', resourceType, method: req.method(), url });
        }
    });
    page.on('response', async (response) => {
        const url = response.url();
        const contentType = response.headers()['content-type'] || '';
        const resourceType = response.request().resourceType();
        if (networkTrace.length < 500 && (/volantin|flyer|lidl|pdf|\.json|api|catalog|promo|brochure|leaflet|image|\.jpg|\.png/i.test(url) || ['xhr', 'fetch', 'document'].includes(resourceType))) {
            networkTrace.push({ event: 'response', resourceType, status: response.status(), contentType, url });
        }
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
    page.on('console', (message) => {
        if (consoleTrace.length < 200) consoleTrace.push({ type: message.type(), text: message.text().substring(0, 1000) });
    });
}

async function inspectFlyerControls(page) {
    return page.evaluate(() => {
        const wanted = /sfoglia|volantino/i;
        const nodes = [...document.querySelectorAll('a, button, [role="button"], [onclick], [data-href], [data-url]')]
            .filter((el) => wanted.test((el.textContent || '').trim()));
        return nodes.slice(0, 30).map((el, index) => {
            const attrs = Object.fromEntries([...el.attributes].map((attr) => [attr.name, attr.value]));
            const rect = el.getBoundingClientRect();
            let container = el;
            for (let i = 0; container.parentElement && i < 4; i++) container = container.parentElement;
            return {
                index,
                tag: el.tagName,
                text: (el.textContent || '').replace(/\s+/g, ' ').trim().substring(0, 200),
                href: el.href || '',
                attrs,
                visible: Boolean(rect.width && rect.height),
                rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
                outerHTML: el.outerHTML.substring(0, 2000),
                containerHTML: container.outerHTML.substring(0, 4000),
            };
        });
    }).catch(() => []);
}

async function discoverFlyerLinks(page, log) {
    const links = await page.evaluate(() => {
        const matchText = /sfoglia|apri\s+(il\s+)?volantino|visualizza\s+(il\s+)?volantino/i;
        const nodes = [...document.querySelectorAll('a[href], [data-href], [data-url], [onclick]')]
            .filter((el) => matchText.test((el.textContent || '').trim()));
        const urls = [];
        for (const el of nodes) {
            let href = el.href || el.dataset?.href || el.dataset?.url || '';
            if (!href && el.getAttribute('onclick')) {
                const match = el.getAttribute('onclick').match(/https?:\/\/[^'"\s)]+|\/[A-Za-z0-9_/?=&%.-]+/);
                href = match?.[0] || '';
            }
            if (!href) continue;
            try { urls.push(new URL(href, location.href).href); } catch { /* ignore */ }
        }
        return [...new Set(urls)];
    }).catch(() => []);
    log.info(`Clickable flyer href targets: ${links.length}`);
    return links.slice(0, 10);
}

async function tryOpenFlyerControls(page, chain, networkTrace, consoleTrace, log) {
    const selector = 'a:has-text("Sfoglia"), button:has-text("Sfoglia"), [role="button"]:has-text("Sfoglia")';
    const controls = page.locator(selector);
    const count = await controls.count().catch(() => 0);
    log.info(`FORENSIC: attempting clicks on ${count} Sfoglia control(s)`);
    const initialUrl = page.url();
    const initialHtml = await page.content().catch(() => '');
    const initialFrames = page.frames().map((frame) => frame.url());

    for (let i = 0; i < Math.min(count, 6); i++) {
        try {
            const control = controls.nth(i);
            if (!(await control.isVisible({ timeout: 2000 }))) {
                log.info(`FORENSIC click[${i}]: not visible`);
                continue;
            }
            const label = ((await control.innerText().catch(() => '')) || '').trim();
            log.info(`FORENSIC click[${i}]: clicking "${label}"`);
            const popupPromise = page.context().waitForEvent('page', { timeout: 5000 }).catch(() => null);
            await control.click({ timeout: 5000, force: true });
            const popup = await popupPromise;
            await page.waitForTimeout(1800);
            if (popup) {
                log.info(`FORENSIC click[${i}]: popup opened ${popup.url()}`);
                if (diagnosticMode) await saveForensicSnapshot(popup, chain, `CLICK_${i}_POPUP`, 1, networkTrace, consoleTrace, log);
                return popup;
            }
            const afterUrl = page.url();
            const afterHtml = await page.content().catch(() => '');
            const afterFrames = page.frames().map((frame) => frame.url());
            const modals = await page.evaluate(() => [...document.querySelectorAll('[role="dialog"], dialog, [class*="modal" i], iframe')].map((el) => ({ tag: el.tagName, text: (el.textContent || '').substring(0, 300), html: el.outerHTML.substring(0, 1500) }))).catch(() => []);
            const result = {
                index: i,
                label,
                beforeUrl: initialUrl,
                afterUrl,
                htmlChanged: afterHtml !== initialHtml,
                htmlLengthBefore: initialHtml.length,
                htmlLengthAfter: afterHtml.length,
                framesBefore: initialFrames,
                framesAfter: afterFrames,
                modals,
            };
            await storeJson(`debug_${chain}_CLICK_${i}_RESULT`, result);
            addManifest(`debug_${chain}_CLICK_${i}_RESULT`, `Esito click sul pulsante Sfoglia numero ${i}`);
            if (diagnosticMode) await saveForensicSnapshot(page, chain, `CLICK_${i}_AFTER`, 1, networkTrace, consoleTrace, log);
            log.info(`FORENSIC click[${i}] result: urlChanged=${afterUrl !== initialUrl}, htmlChanged=${afterHtml !== initialHtml}, frames=${afterFrames.join(' | ')}, modals=${modals.length}`);
            if (afterUrl !== initialUrl || afterFrames.length > initialFrames.length || modals.length > 0 || afterHtml !== initialHtml) return page;
        } catch (error) {
            log.warning(`FORENSIC click[${i}] failed: ${error.message}`);
        }
    }
    return null;
}

async function expandFlyer(page, log) {
    for (let cycle = 0; cycle < 6; cycle++) {
        const clicked = await page.evaluate(() => {
            const labels = /mostra\s+altro|carica\s+altro|vedi\s+altro|show\s+more/i;
            const button = [...document.querySelectorAll('button, a, [role="button"]')].find((el) => labels.test((el.textContent || '').trim()));
            if (button) { button.click(); return true; }
            return false;
        }).catch(() => false);
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
        await page.waitForTimeout(clicked ? 1400 : 800);
    }
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
    log.info('Flyer expansion/scroll completed');
}

async function saveForensicSnapshot(page, chain, label, pageNum, networkTrace, consoleTrace, log) {
    try {
        const prefix = `debug_${chain}_${label}_P${pageNum}`;
        const html = await page.content();
        const text = await page.evaluate(() => document.body.innerText).catch(() => '');
        const resources = await page.evaluate(() => performance.getEntriesByType('resource').map((entry) => ({ name: entry.name, initiatorType: entry.initiatorType, duration: Math.round(entry.duration) }))).catch(() => []);
        const frames = page.frames().map((frame) => frame.url());
        const scripts = await page.evaluate(() => [...document.querySelectorAll('script')].map((script) => ({ src: script.src || '', type: script.type || '', textPreview: script.src ? '' : (script.textContent || '').substring(0, 300) })).slice(0, 100)).catch(() => []);
        const storage = await page.evaluate(() => ({ localStorage: Object.fromEntries(Object.entries(localStorage)), sessionStorage: Object.fromEntries(Object.entries(sessionStorage)) })).catch(() => ({}));
        const controls = await inspectFlyerControls(page);
        const metadata = { url: page.url(), label, pageNum, htmlLength: html.length, textLength: text.length, frames, controls, scripts, storage, resources, networkTrace, consoleTrace };

        await Actor.setValue(`${prefix}_FULL_HTML`, html, { contentType: 'text/html' });
        await Actor.setValue(`${prefix}_FULL_TEXT`, text, { contentType: 'text/plain' });
        await storeJson(`${prefix}_METADATA`, metadata);
        const screenshot = await page.screenshot({ fullPage: true });
        await Actor.setValue(`${prefix}_FULL_SCREEN`, screenshot, { contentType: 'image/png' });

        addManifest(`${prefix}_FULL_HTML`, `HTML pagina ${label}`);
        addManifest(`${prefix}_FULL_TEXT`, `Testo integrale pagina ${label}`);
        addManifest(`${prefix}_METADATA`, `DOM, script, frame, storage e network trace ${label}`);
        addManifest(`${prefix}_FULL_SCREEN`, `Screenshot integrale pagina ${label}`);
        log.info(`FORENSIC saved: ${prefix}_FULL_HTML, _FULL_TEXT, _METADATA, _FULL_SCREEN`);
    } catch (error) {
        log.warning(`Forensic snapshot failed (${label}): ${error.message}`);
    }
}

function addManifest(key, description) {
    if (!diagnosticManifest.some((item) => item.key === key)) diagnosticManifest.push({ key, description });
}

async function storeJson(key, data) {
    await Actor.setValue(key, JSON.stringify(data, null, 2), { contentType: 'application/json' });
}

function extractOffersFromJson(json, chainName) {
    const arrays = [];
    const scan = (value, depth = 0) => {
        if (!value || depth > 6) return;
        if (Array.isArray(value)) { arrays.push(value); for (const child of value.slice(0, 5)) scan(child, depth + 1); return; }
        if (typeof value === 'object') for (const child of Object.values(value)) scan(child, depth + 1);
    };
    scan(json);
    const output = [];
    for (const arr of arrays) {
        for (const product of arr) {
            if (!product || typeof product !== 'object' || Array.isArray(product)) continue;
            const name = product.name || product.title || product.description || product.nome || product.label || '';
            const price = product.price ?? product.salePrice ?? product.offerPrice ?? product.prezzoOfferta ?? product.prezzo;
            if (!name || price === undefined || price === null) continue;
            output.push({ name: String(name).trim(), catena: chainName, categoria: product.category || product.categoria || '', priceOffer: normalizePrice(price), priceOriginal: normalizePrice(product.originalPrice ?? product.regularPrice ?? product.prezzoOriginale ?? ''), discount: String(product.discount ?? product.sconto ?? product.percentOff ?? ''), validFrom: product.validFrom || product.startDate || product.dal || '', validTo: product.validTo || product.endDate || product.al || '', img: product.image || product.imageUrl || product.img || '', url: product.url || product.link || '' });
        }
    }
    return mergeUniqueOffers(output);
}

async function extractOffersFromEmbeddedJson(page, chainName, log) {
    const values = await page.evaluate(() => [...document.querySelectorAll('script[type="application/ld+json"], script#__NEXT_DATA__, script[type="application/json"]')].map((script) => script.textContent).filter(Boolean).map((text) => { try { return JSON.parse(text); } catch { return null; } }).filter(Boolean)).catch(() => []);
    const offers = values.flatMap((value) => extractOffersFromJson(value, chainName));
    log.info(`Embedded JSON offers: ${offers.length}`);
    return offers;
}

async function parseOffersFromDom(page, chainName, log) {
    const offers = await page.evaluate((name) => {
        const priceRx = /(?:€\s*)?(\d{1,4}[,.]\d{2})(?:\s*€)?/;
        const selectors = ['[class*="product" i]', '[class*="offer" i]', '[class*="promo" i]', '[class*="deal" i]', 'article', '[data-product]', '[itemtype*="Product"]'];
        const nodes = [...new Set(selectors.flatMap((selector) => [...document.querySelectorAll(selector)]))];
        const out = [];
        for (const node of nodes) {
            const text = (node.innerText || '').replace(/\s+/g, ' ').trim();
            const match = text.match(priceRx);
            if (!match || text.length > 350) continue;
            const titleNode = node.querySelector('h1, h2, h3, h4, [class*="title" i], [class*="name" i], strong');
            const productName = (titleNode?.textContent || text.split(match[0])[0]).replace(/\s+/g, ' ').trim();
            if (!productName || productName.length < 3 || productName.length > 120) continue;
            out.push({ name: productName, catena: name, categoria: '', priceOffer: match[1].replace(',', '.'), priceOriginal: '', discount: '', validFrom: '', validTo: '', img: node.querySelector('img')?.src || '', url: node.querySelector('a[href]')?.href || '' });
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
    const priceLineIndices = lines.map((line, index) => priceRegex.test(line) ? index : -1).filter((index) => index >= 0);
    log.info(`Text length=${rawText.length}; lines=${lines.length}; price lines=${priceLineIndices.length}`);
    const navSkip = new Set(['Home', 'Anteprima', 'Discount', 'Elettronica', 'Animali', 'Bricolage', 'Salute e Benessere', 'Ultimi Volantini', 'Back to School', 'Iper e Super', 'Cura casa e corpo', 'beta', 'Sfoglia', 'Attivo', 'Scaduto', 'La tua lista della spesa']);
    const isFormat = (value) => /\d+\s*(ml|g|kg|l|lt|pz|cl)/i.test(value) || /^\d+x/i.test(value);
    const items = [];
    for (const i of priceLineIndices) {
        const previous = lines[i - 1] || '';
        const beforePrevious = lines[i - 2] || '';
        let name = '';
        let format = '';
        if (isFormat(previous) && beforePrevious && !navSkip.has(beforePrevious)) { format = previous; name = beforePrevious; }
        else if (previous && !navSkip.has(previous) && !isFormat(previous) && !/^\d/.test(previous) && !/^pag\./i.test(previous)) name = previous;
        name = name.replace(/^[^\w\u00C0-\u024F]+/, '').trim();
        if (!name || name.length < 3) continue;
        items.push({ name, catena: chainName, categoria: '', priceOffer: normalizePrice(lines[i]), priceOriginal: '', discount: '', validFrom: '', validTo: '', img: '', url: '', format });
    }
    log.info(`Text parsed offers: ${items.length}`);
    return mergeUniqueOffers(items);
}

function normalizePrice(value) { return String(value ?? '').replace(/€/g, '').trim().replace(',', '.'); }
function itemKey(item) { return `${String(item.catena).toLowerCase()}|${String(item.name).toLowerCase().replace(/\s+/g, ' ').trim()}|${normalizePrice(item.priceOffer)}`; }
function mergeUniqueOffers(items) { const map = new Map(); for (const item of items) { if (!item?.name || !item.priceOffer) continue; const key = itemKey(item); if (!map.has(key)) map.set(key, item); } return [...map.values()]; }

async function dismissCookies(page, log) {
    try {
        for (const frame of page.frames()) {
            if (frame.url().includes('sourcepoint') || frame.url().includes('sp-')) {
                const button = frame.locator('button:has-text("Continua senza accettare"), button:has-text("Rifiuta")').first();
                if (await button.isVisible({ timeout: 2000 })) { await button.click(); log.info('Cookie dismissed via iframe'); return; }
            }
        }
    } catch { /* ignore */ }
    for (const text of ['Accetta tutti', 'Accetta', 'OK', 'Continua', 'Accept all', 'Acconsento']) {
        try {
            const button = page.locator(`button:has-text("${text}")`).first();
            if (await button.isVisible({ timeout: 1500 })) { await button.click(); await page.waitForTimeout(500); log.info(`Cookie dismissed: "${text}"`); return; }
        } catch { /* ignore */ }
    }
}
