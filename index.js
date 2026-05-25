 const express = require('express');
  const { chromium } = require('playwright');
  const RecaptchaSolver = require('recaptcha-solver');

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
          '--no-sandbox', '--disable-setuid-sandbox',
          '--disable-dev-shm-usage', '--no-first-run', '--no-zygote',
          '--disable-blink-features=AutomationControlled',
        ],
      });

      const ctx = await browser.newContext({
        userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        locale: 'es-CO',
        timezoneId: 'America/Bogota',
        viewport: { width: 1280, height: 800 },
      });

      const page = await ctx.newPage();

      // PASO 1: Aceptar términos
      await page.goto('https://antecedentes.policia.gov.co:7005/WebJudicial/index.xhtml', {
        waitUntil: 'domcontentloaded', timeout: 30000,
      });
      await page.waitForSelector('#aceptaOption\\:0', { timeout: 15000 });
      await page.locator('#aceptaOption\\:0').click();
      await page.waitForTimeout(500);
      await page.locator('#continuarBtn').click();
      await page.waitForURL('**/formAntecedentes.xhtml', { timeout: 15000 });
      await page.waitForLoadState('domcontentloaded');
      await page.waitForTimeout(2000);
      console.log('[PASO 1] Términos aceptados');

      // PASO 2: Llenar cédula
      await page.waitForSelector('#cedulaInput', { timeout: 10000 });
      await page.selectOption('#cedulaTipo', 'cc');
      await page.fill('#cedulaInput', cedula);
      console.log('[PASO 2] Cédula ingresada:', cedula);

      // PASO 3: Resolver CAPTCHA automáticamente
      console.log('[PASO 3] Resolviendo CAPTCHA...');
      const solver = new RecaptchaSolver(page);
      await solver.solve();
      console.log('[PASO 3] CAPTCHA resuelto');

      // PASO 4: Esperar que el poll detecte el CAPTCHA y muestre resultados
      await Promise.race([
        page.waitForSelector(':text("asuntos pendientes")', { timeout: 30000 }),
        page.waitForSelector(':text("no tiene asuntos")', { timeout: 30000 }),
        page.waitForSelector(':text("no encontrado")', { timeout: 30000 }),
        page.waitForTimeout(20000),
      ]).catch(() => {});

      const html = await page.content();
      const texto = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      console.log('[PASO 4] Resultado:', texto.slice(0, 400));

      return res.json(parseResult(html, cedula));

    } catch (err) {
      console.error('[ERROR]', err.message);
      return res.status(500).json({ error: err.message });
    } finally {
      if (browser) await browser.close().catch(() => {});
    }
  });

  function parseResult(html, cedula) {
    const lower = (html || '').toLowerCase();
    const ts = new Date().toISOString();
    const nombreMatch = html.match(/Apellidos y Nombres[:\s]+([A-ZÁÉÍÓÚÑ\s]+?)(?:<|\n|$)/i);
    const nombrePolicia = nombreMatch ? nombreMatch[1].trim() : null;

    if (lower.includes('no tiene asuntos pendientes')) {
      return { cedula, cedula_existe: true, nombre_policia: nombrePolicia, tiene_antecedentes: false, estado: 'limpio', mensaje: 'Sin asuntos pendientes judiciales', consultado_en: ts };
    }
    if (lower.includes('tiene asuntos pendientes') || lower.includes('registra antecedentes')) {
      return { cedula, cedula_existe: true, nombre_policia: nombrePolicia, tiene_antecedentes: true, estado: 'alerta', mensaje: 'ALERTA: Tiene asuntos pendientes', consultado_en: ts };
    }
    if (lower.includes('no encontrado') || lower.includes('no se encontró')) {
      return { cedula, cedula_existe: false, nombre_policia: null, tiene_antecedentes: null, estado: 'no_encontrado', mensaje: 'Cédula NO existe en el sistema', consultado_en: ts };
    }

    const snippet = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 400);
    console.log('[NO RECONOCIDO]', snippet);
    return { cedula, tiene_antecedentes: null, estado: 'indeterminado', mensaje: 'No se pudo determinar. Verifica manualmente.', consultado_en: ts };
  }

  const PORT = process.env.PORT || 10000;
  app.listen(PORT, () => console.log(`Servidor antecedentes activo en puerto ${PORT}`));
