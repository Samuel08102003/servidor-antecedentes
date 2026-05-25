const { chromium } = require('playwright-extra');
  const StealthPlugin = require('puppeteer-extra-plugin-stealth');
  chromium.use(StealthPlugin());

  const express = require('express');

  const app = express();
  app.use(express.json());

  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
  });

  app.get('/health', (_req, res) => res.json({ ok: true }));

  app.post('/consulta-antecedentes', async (req, res) => {
    const cedula = String(req.body?.cedula || '').trim();
    if (!cedula || !/^\d{5,12}$/.test(cedula)) {
      return res.status(400).json({ error: 'Cédula inválida (5-12 dígitos)' });
    }

    let browser = null;
    try {
      browser = await chromium.launch({
        headless: false,
        args: [
          '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run', '--no-zygote',
          '--disable-blink-features=AutomationControlled',
        ],
      });

      const ctx = await browser.newContext({
        userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        locale: 'es-CO',
        timezoneId: 'America/Bogota',
        viewport: { width: 1280, height: 800 },
      });

      await ctx.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        Object.defineProperty(navigator, 'languages', { get: () => ['es-CO', 'es', 'en-US'] });
        Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
        window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {}, app: {} };
        const origQuery = window.navigator.permissions.query;
        window.navigator.permissions.query = (p) =>
          p.name === 'notifications'
            ? Promise.resolve({ state: Notification.permission })
            : origQuery.call(navigator.permissions, p);
      });

      const page = await ctx.newPage();

      // PASO 1: Aceptar términos
      await page.goto('https://antecedentes.policia.gov.co:7005/WebJudicial/index.xhtml', {
        waitUntil: 'domcontentloaded', timeout: 30000,
      });
      await page.locator('#aceptaOption\\:0').click();
      await page.waitForTimeout(400);
      await page.locator('#continuarBtn').click();
      await page.waitForURL('**/antecedentes.xhtml', { timeout: 15000 });
      await page.waitForLoadState('domcontentloaded');
      await page.waitForTimeout(2000);

      // PASO 2: Llenar cédula
      await page.selectOption('#cedulaTipo', 'cc');
      await page.fill('#cedulaInput', cedula);

      // PASO 3: Resolver reCAPTCHA
      const captchaSolved = await solveRecaptcha(page);
      console.log('[CAPTCHA RESUELTO]', captchaSolved);
      if (!captchaSolved) throw new Error('No se pudo resolver el CAPTCHA');

      // PASO 4: Enviar formulario
      await page.waitForTimeout(1500);
      await page.evaluate(() => document.querySelector('#j_idt17')?.click());
      await page.waitForTimeout(5000);

      const html = await page.content();
      const texto = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      console.log('[RESULTADO]', texto.slice(0, 600));

      return res.json(parseResult(html, cedula));

    } catch (err) {
      console.error('[ERROR]', err.message);
      return res.status(500).json({ error: err.message });
    } finally {
      if (browser) await browser.close().catch(() => {});
    }
  });

  // ── Resolver reCAPTCHA ─────────────────────────────────────────────────────
  async function solveRecaptcha(page) {
    try {
      await page.waitForTimeout(4000);

      const frames = page.frames();
      console.log('[FRAMES]', frames.map(f => f.url()).join('\n'));

      const anchor = frames.find(f => /recaptcha\/api2\/anchor/.test(f.url()));
      if (!anchor) throw new Error('No se encontró iframe reCAPTCHA');

      await page.mouse.move(300 + Math.random() * 100, 400 + Math.random() * 50);
      await page.waitForTimeout(500 + Math.random() * 500);

      await anchor.locator('#recaptcha-anchor').click({ timeout: 10000 });
      await page.waitForTimeout(5000);

      const token = await page.evaluate(() =>
        document.querySelector('[name="g-recaptcha-response"]')?.value || ''
      );
      console.log('[TOKEN LENGTH]', token.length);

      if (token.length > 200) {
        console.log('[CAPTCHA] Resuelto por checkbox — stealth funcionó');
        return true;
      }

      // Si stealth no fue suficiente, intentar audio
      let bframe = null;
      for (let i = 0; i < 15; i++) {
        await page.waitForTimeout(1000);
        bframe = page.frames().find(f => /recaptcha\/api2\/bframe/.test(f.url()));
        console.log(`[CAPTCHA] Buscando bframe... intento ${i + 1}`);
        if (bframe) break;
      }

      if (bframe) {
        console.log('[CAPTCHA] bframe encontrado — intentando audio');
        return await resolverAudio(page, bframe, anchor);
      }

      console.log('[CAPTCHA] bframe nunca apareció');
      return false;

    } catch (err) {
      console.error('[CAPTCHA ERROR]', err.message);
      return false;
    }
  }

  async function resolverAudio(page, bframe, anchor) {
    try {
      await page.waitForTimeout(2000);

      const bloqueado = await bframe.locator('.rc-doscaptcha-body').isVisible().catch(() => false);
      if (bloqueado) {
        console.log('[AUDIO] Google bloqueó el desafío');
        return false;
      }

      const audioBtnVisible = await bframe.locator('#recaptcha-audio-button').isVisible().catch(() => false);
      console.log('[AUDIO BTN VISIBLE]', audioBtnVisible);

      if (!audioBtnVisible) {
        console.log('[AUDIO] No hay botón de audio');
        return false;
      }

      await bframe.locator('#recaptcha-audio-button').click({ timeout: 8000 });
      await page.waitForTimeout(5000);

      const bloqueadoDespues = await bframe.locator('.rc-doscaptcha-body').isVisible().catch(() => false);
      if (bloqueadoDespues) {
        console.log('[AUDIO] Google bloqueó después del clic');
        return false;
      }

      let audioUrl = await bframe.locator('.rc-audiochallenge-tdownload-link a')
        .getAttribute('href', { timeout: 10000 }).catch(() => null);

      if (!audioUrl) {
        audioUrl = await bframe.evaluate(() => {
          const audio = document.querySelector('audio');
          return audio?.src || audio?.querySelector('source')?.src || null;
        }).catch(() => null);
      }

      console.log('[AUDIO URL]', audioUrl ? audioUrl.slice(0, 60) : 'null');
      if (!audioUrl) throw new Error('No se encontró URL de audio');

      const respuesta = await transcribirAudio(audioUrl);
      if (!respuesta) throw new Error('Transcripción de audio falló');
      console.log('[AUDIO RESPUESTA]', respuesta);

      await bframe.locator('#audio-response').fill(respuesta.toLowerCase().trim());
      await bframe.locator('#recaptcha-verify-button').click();
      await page.waitForTimeout(2500);

      const resuelto = await anchor.locator('.recaptcha-checkbox-checkmark').isVisible().catch(() => false);

      if (!resuelto) {
        console.log('[AUDIO] Primer intento fallido, reintentando...');
        await bframe.locator('.rc-audiochallenge-play-button button').click({ timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(1500);
        const url2 = await bframe.locator('.rc-audiochallenge-tdownload-link a')
          .getAttribute('href', { timeout: 5000 }).catch(() => null);
        if (!url2) return false;
        const resp2 = await transcribirAudio(url2, 'large');
        if (!resp2) return false;
        await bframe.locator('#audio-response').fill(resp2.toLowerCase().trim());
        await bframe.locator('#recaptcha-verify-button').click();
        await page.waitForTimeout(2500);
        return await anchor.locator('.recaptcha-checkbox-checkmark').isVisible().catch(() => false);
      }

      return true;
    } catch (err) {
      console.error('[AUDIO ERROR]', err.message);
      return false;
    }
  }

  // ── Transcribir audio con Whisper ─────────────────────────────────────────
  async function transcribirAudio(url, modelo = 'base') {
    try {
      const audioResp = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0', Accept: '*/*', Referer: 'https://www.google.com/' },
      });
      if (!audioResp.ok) throw new Error(`Error descargando audio: ${audioResp.status}`);
      const buffer = await audioResp.arrayBuffer();

      const modelId = modelo === 'large' ? 'openai/whisper-large-v3' : 'openai/whisper-base';
      const HF_TOKEN = process.env.HF_TOKEN || '';
      const headers = { 'Content-Type': 'audio/mpeg' };
      if (HF_TOKEN) headers['Authorization'] = `Bearer ${HF_TOKEN}`;

      let hfResp = await fetch(`https://api-inference.huggingface.co/models/${modelId}`, {
        method: 'POST', headers, body: buffer,
      });

      if (hfResp.status === 503) {
        console.log('[WHISPER] Modelo cargando, esperando 10s...');
        await new Promise((r) => setTimeout(r, 10000));
        hfResp = await fetch(`https://api-inference.huggingface.co/models/${modelId}`, {
          method: 'POST', headers, body: buffer,
        });
      }

      const data = await hfResp.json();
      return data?.text?.trim() || null;
    } catch (err) {
      console.error('[WHISPER ERROR]', err.message);
      return null;
    }
  }

  // ── Parsear resultado ─────────────────────────────────────────────────────
  function parseResult(html, cedula) {
    const lower = html.toLowerCase();
    const ts = new Date().toISOString();

    const nombreMatch = html.match(/Apellidos y Nombres[:\s]+([A-ZÁÉÍÓÚÑ\s]+?)(?:<|\n|$)/i);
    const nombrePolicia = nombreMatch ? nombreMatch[1].trim() : null;

    if (lower.includes('no tiene asuntos pendientes')) {
      return { cedula, cedula_existe: true, nombre_policia: nombrePolicia, tiene_antecedentes: false, estado: 'limpio', mensaje: 'Cédula válida — Sin asuntos pendientes judiciales', consultado_en: ts };
    }

    if (lower.includes('tiene asuntos pendientes') || lower.includes('registra antecedentes') || lower.includes('requerimiento judicial')) {
      return { cedula, cedula_existe: true, nombre_policia: nombrePolicia, tiene_antecedentes: true, estado: 'alerta', mensaje: 'ALERTA: Tiene asuntos pendientes — NO otorgar cupo', consultado_en: ts };
    }

    if (lower.includes('no encontrado') || lower.includes('no se encontró') || lower.includes('documento no válido')) {
      return { cedula, cedula_existe: false, nombre_policia: null, tiene_antecedentes: null, estado: 'no_encontrado', mensaje: 'Cédula NO existe en el sistema de la Policía Nacional', consultado_en: ts };
    }

    const snippet = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 400);
    console.log('[NO RECONOCIDO]', snippet);
    return { cedula, tiene_antecedentes: null, estado: 'indeterminado', mensaje: 'No se pudo determinar. Verifica manualmente.', consultado_en: ts };
  }

  const PORT = process.env.PORT || 10000;
  app.listen(PORT, () => console.log(`Servidor antecedentes activo en puerto ${PORT}`));
