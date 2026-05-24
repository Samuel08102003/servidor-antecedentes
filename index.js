const express = require('express');
const { chromium } = require('playwright');

const app = express();
app.use(express.json());

// CORS — permite llamadas desde el CRM HTML
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Health check para Render.com
app.get('/health', (_req, res) => res.json({ ok: true }));

// ── Endpoint principal ─────────────────────────────────────────────────────
app.post('/consulta-antecedentes', async (req, res) => {
  const cedula = String(req.body?.cedula || '').trim();

  if (!cedula || !/^\d{5,12}$/.test(cedula)) {
    return res.status(400).json({ error: 'Cédula inválida (debe tener 5-12 dígitos)' });
  }

  let browser = null;

  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--no-first-run',
        '--no-zygote',
      ],
    });

    const ctx = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      locale: 'es-CO',
      timezoneId: 'America/Bogota',
    });

    const page = await ctx.newPage();

    // ── PASO 1: Aceptar términos ─────────────────────────────────────────
    await page.goto(
      'https://antecedentes.policia.gov.co:7005/WebJudicial/index.xhtml',
      { waitUntil: 'domcontentloaded', timeout: 30000 }
    );

    await page.locator('#aceptaOption\\:0').click();
    await page.waitForTimeout(400);
    await page.locator('#continuarBtn').click();

    await page.waitForURL('**/antecedentes.xhtml', { timeout: 15000 });
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(1500);

    // ── PASO 2: Llenar cédula ────────────────────────────────────────────
    await page.selectOption('#cedulaTipo', 'cc');
    await page.fill('#cedulaInput', cedula);

    // ── PASO 3: Resolver reCAPTCHA por audio (gratis, sin API externa) ───
    const captchaSolved = await solveAudioCaptcha(page);
    if (!captchaSolved) {
      throw new Error('No se pudo resolver el CAPTCHA automáticamente');
    }

    // ── PASO 4: Enviar formulario y leer resultado ───────────────────────
    await page.waitForTimeout(2000); // esperar que limpie overlay del captcha
    // Clic por JavaScript para evitar bloqueos de elementos superpuestos
    await page.evaluate(() => {
      const btn = document.querySelector('#j_idt17');
      if (btn) btn.click();
    });
    await page.waitForTimeout(5000);

    const html = await page.content();
    return res.json(parseResult(html, cedula));

  } catch (err) {
    console.error('[ERROR]', err.message);
    return res.status(500).json({ error: err.message });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
});

// ── Resolver reCAPTCHA v2 por audio (técnica Buster, sin costo) ────────────
async function solveAudioCaptcha(page) {
  try {
    await page.waitForTimeout(2500);

    // Frame del checkbox
    const anchor = page.frame({ url: /recaptcha\/api2\/anchor/ });
    if (!anchor) throw new Error('No se encontró el iframe de reCAPTCHA (anchor)');

    // Clic en el checkbox
    await anchor.locator('#recaptcha-anchor').click({ timeout: 8000 });
    await page.waitForTimeout(2500);

    // Si se resolvió solo (puntaje de riesgo bajo), listo
    const sinDesafio = await anchor
      .locator('.recaptcha-checkbox-checkmark')
      .isVisible()
      .catch(() => false);
    if (sinDesafio) {
      console.log('[CAPTCHA] Resuelto sin desafío (puntaje de riesgo bajo)');
      return true;
    }

    // Frame del desafío
    const bframe = page.frame({ url: /recaptcha\/api2\/bframe/ });
    if (!bframe) throw new Error('No se encontró el iframe del desafío (bframe)');

    // Cambiar a desafío de audio
    await bframe.locator('#recaptcha-audio-button').click({ timeout: 8000 });
    await page.waitForTimeout(2000);

    // Obtener URL del archivo de audio
    const audioUrl = await bframe
      .locator('.rc-audiochallenge-tdownload-link a')
      .getAttribute('href', { timeout: 8000 });

    if (!audioUrl) throw new Error('No se encontró la URL del audio del CAPTCHA');
    console.log('[CAPTCHA] Audio URL obtenida');

    // Transcribir audio con Whisper (Hugging Face, gratis)
    const respuesta = await transcribirAudio(audioUrl);
    if (!respuesta) throw new Error('No se pudo transcribir el audio del CAPTCHA');

    console.log('[CAPTCHA] Texto reconocido:', respuesta);

    // Ingresar respuesta y verificar
    await bframe.locator('#audio-response').fill(respuesta.toLowerCase().trim());
    await bframe.locator('#recaptcha-verify-button').click();
    await page.waitForTimeout(2500);

    // Confirmar que quedó resuelto
    const resuelto = await anchor
      .locator('.recaptcha-checkbox-checkmark')
      .isVisible()
      .catch(() => false);

    if (!resuelto) {
      // La transcripción pudo ser inexacta — intentar con el modelo large
      console.log('[CAPTCHA] Primer intento fallido, reintentando con modelo mejorado...');
      return await reintentarAudio(page, bframe, anchor);
    }

    return true;

  } catch (err) {
    console.error('[CAPTCHA ERROR]', err.message);
    return false;
  }
}

// Reintento con modelo Whisper más preciso
async function reintentarAudio(page, bframe, anchor) {
  try {
    // Solicitar nuevo audio
    await bframe.locator('.rc-audiochallenge-play-button button').click({ timeout: 5000 });
    await page.waitForTimeout(1500);

    const audioUrl2 = await bframe
      .locator('.rc-audiochallenge-tdownload-link a')
      .getAttribute('href', { timeout: 5000 });

    if (!audioUrl2) return false;

    const respuesta2 = await transcribirAudio(audioUrl2, 'large');
    if (!respuesta2) return false;

    await bframe.locator('#audio-response').fill(respuesta2.toLowerCase().trim());
    await bframe.locator('#recaptcha-verify-button').click();
    await page.waitForTimeout(2500);

    return await anchor
      .locator('.recaptcha-checkbox-checkmark')
      .isVisible()
      .catch(() => false);

  } catch (e) {
    console.error('[RETRY ERROR]', e.message);
    return false;
  }
}

// ── Transcripción de audio gratis con Whisper (Hugging Face) ───────────────
async function transcribirAudio(url, modelo = 'base') {
  try {
    // Descargar audio del CAPTCHA
    const audioResp = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
        Accept: '*/*',
        Referer: 'https://www.google.com/',
      },
    });

    if (!audioResp.ok) throw new Error(`Error descargando audio: ${audioResp.status}`);
    const buffer = await audioResp.arrayBuffer();

    // Hugging Face Inference API — Whisper (gratis con cuenta gratuita)
    // Crea cuenta en huggingface.co, obtén token gratis en Settings → Tokens
    const HF_TOKEN = process.env.HF_TOKEN || '';
    const modelId =
      modelo === 'large'
        ? 'openai/whisper-large-v3'
        : 'openai/whisper-base';

    const headers = { 'Content-Type': 'audio/mpeg' };
    if (HF_TOKEN) headers['Authorization'] = `Bearer ${HF_TOKEN}`;

    const hfResp = await fetch(
      `https://api-inference.huggingface.co/models/${modelId}`,
      { method: 'POST', headers, body: buffer }
    );

    // Si el modelo está cargando, esperar y reintentar
    if (hfResp.status === 503) {
      console.log('[WHISPER] Modelo cargando, esperando 10s...');
      await new Promise((r) => setTimeout(r, 10000));
      const retry = await fetch(
        `https://api-inference.huggingface.co/models/${modelId}`,
        { method: 'POST', headers, body: buffer }
      );
      const data2 = await retry.json();
      return data2?.text?.trim() || null;
    }

    const data = await hfResp.json();
    return data?.text?.trim() || null;

  } catch (err) {
    console.error('[WHISPER ERROR]', err.message);
    return null;
  }
}

// ── Parsear resultado de la página de la Policía ───────────────────────────
function parseResult(html, cedula) {
  const lower = html.toLowerCase();
  const ts = new Date().toISOString();

  // Extraer nombre de la respuesta: "Apellidos y Nombres: NOMBRE COMPLETO"
  const nombreMatch = html.match(/Apellidos y Nombres[:\s]+([A-ZÁÉÍÓÚÑ\s]+?)(?:<|\n|$)/i);
  const nombrePolicia = nombreMatch ? nombreMatch[1].trim() : null;

  // Sin antecedentes — frase oficial de la Policía Nacional
  if (lower.includes('no tiene asuntos pendientes')) {
    return {
      cedula,
      cedula_existe: true,
      nombre_policia: nombrePolicia,
      tiene_antecedentes: false,
      estado: 'limpio',
      mensaje: 'Cédula válida — No tiene asuntos pendientes con las autoridades judiciales',
      consultado_en: ts,
    };
  }

  // Con antecedentes
  if (
    lower.includes('no encontrado') ||
  lower.includes('no se encontró') ||
  lower.includes('documento no válido') ||
  lower.includes('número de identificación no')
  ) {
    return {
      cedula,
      cedula_existe: true,
      nombre_policia: nombrePolicia,
      tiene_antecedentes: true,
      estado: 'alerta',
      mensaje: 'ALERTA: Tiene asuntos pendientes con autoridades judiciales — NO otorgar cupo',
      consultado_en: ts,
    };
  }

  // Cédula no encontrada / no existe en el sistema
  if (
    lower.includes('no encontrado') ||
    lower.includes('no existe') ||
    lower.includes('no se encontr') ||
    lower.includes('documento no válido') ||
    lower.includes('número de documento')
  ) {
    return {
      cedula,
      cedula_existe: false,
      nombre_policia: null,
      tiene_antecedentes: null,
      estado: 'no_encontrado',
      mensaje: 'Cédula NO existe en el sistema de la Policía Nacional',
      consultado_en: ts,
    };
  }

  // No reconocido
  const snippet = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 400);
  console.log('[RESULTADO NO RECONOCIDO]', snippet);
  return {
    cedula,
    tiene_antecedentes: null,
    estado: 'indeterminado',
    mensaje: 'No se pudo determinar. Verifica manualmente.',
    consultado_en: ts,
  };
}

// ── Iniciar servidor ───────────────────────────────────────────────────────
const PORT = process.env.PORT || 10000;
app.listen(PORT, () =>
  console.log(`Servidor antecedentes activo en puerto ${PORT}`)
);
