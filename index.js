const express = require('express');
  const axios = require('axios');
  const https = require('https');

  const app = express();
  app.use(express.json());

  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
  });

  app.get('/health', (_req, res) => res.json({ ok: true }));

  const agent = new https.Agent({ rejectUnauthorized: false });
  const BASE = 'https://antecedentes.policia.gov.co:7005/WebJudicial';

  app.post('/consulta-antecedentes', async (req, res) => {
    const cedula = String(req.body?.cedula || '').trim();
    if (!cedula || !/^\d{5,12}$/.test(cedula)) {
      return res.status(400).json({ error: 'Cédula inválida (5-12 dígitos)' });
    }

    try {
      // PASO 1: Cargar index
      const r1 = await axios.get(`${BASE}/index.xhtml`, {
        httpsAgent: agent,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      });
      const cookies1 = (r1.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
      const vs1 = extraerViewState(r1.data);
      console.log('[PASO 1] OK');

      // PASO 2: Aceptar términos
      const params2 = new URLSearchParams();
      params2.append('form', 'form');
      params2.append('aceptaOption', 'true');
      params2.append('continuarBtn', 'continuarBtn');
      params2.append('javax.faces.ViewState', vs1);

      const r2 = await axios.post(`${BASE}/index.xhtml`, params2.toString(), {
        httpsAgent: agent,
        maxRedirects: 10,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Cookie': cookies1,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      });
      const cookies2 = [cookies1, ...(r2.headers['set-cookie'] || []).map(c => c.split(';')[0])].join('; ');
      console.log('[PASO 2] OK');

      // PASO 3: GET antecedentes
      const r3 = await axios.get(`${BASE}/antecedentes.xhtml`, {
        httpsAgent: agent,
        headers: { 'Cookie': cookies2, 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      });
      const cookies3 = [cookies2, ...(r3.headers['set-cookie'] || []).map(c => c.split(';')[0])].join('; ');
      const vs3 = extraerViewState(r3.data);

      // Ver todos los campos del formulario
      const selects = r3.data.match(/<select[^>]*>/gi) || [];
      const buttons = r3.data.match(/<(?:input|button)[^>]*(?:submit|button|CommandButton)[^>]*>/gi) || [];
      console.log('[PASO 3] ViewState:', vs3?.slice(0, 30));
      console.log('[PASO 3] Selects:', selects.join('\n'));
      console.log('[PASO 3] Buttons:', buttons.join('\n'));

      // PASO 4: Enviar consulta con nombres correctos
      const params4 = new URLSearchParams();
      params4.append('formAntecedentes', 'formAntecedentes');
      params4.append('cedulaInput', cedula);
      params4.append('cedulaTipo', 'cc');
      params4.append('j_idt17', 'j_idt17');
      params4.append('g-recaptcha-response', '');
      params4.append('javax.faces.ViewState', vs3);

      const r4 = await axios.post(`${BASE}/antecedentes.xhtml`, params4.toString(), {
        httpsAgent: agent,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Cookie': cookies3,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      });

      console.log('[PASO 4] Status:', r4.status);
      const snippet = r4.data.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 600);
      console.log('[PASO 4] TEXTO:', snippet);

      return res.json(parseResult(r4.data, cedula));

    } catch (err) {
      console.error('[ERROR]', err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  function extraerViewState(html) {
    const match = html.match(/javax\.faces\.ViewState[^>]*value="([^"]+)"/);
    return match ? match[1] : null;
  }

  function parseResult(html, cedula) {
    const lower = (html || '').toLowerCase();
    const ts = new Date().toISOString();
    const nombreMatch = html.match(/Apellidos y Nombres[:\s]+([A-ZÁÉÍÓÚÑ\s]+?)(?:<|\n|$)/i);
    const nombrePolicia = nombreMatch ? nombreMatch[1].trim() : null;

    if (lower.includes('no tiene asuntos pendientes')) {
      return { cedula, cedula_existe: true, nombre_policia: nombrePolicia, tiene_antecedentes: false, estado: 'limpio', mensaje: 'Sin
   asuntos pendientes judiciales', consultado_en: ts };
    }
    if (lower.includes('tiene asuntos pendientes') || lower.includes('registra antecedentes')) {
      return { cedula, cedula_existe: true, nombre_policia: nombrePolicia, tiene_antecedentes: true, estado: 'alerta', mensaje:
  'ALERTA: Tiene asuntos pendientes', consultado_en: ts };
    }
    if (lower.includes('no encontrado') || lower.includes('no se encontró')) {
      return { cedula, cedula_existe: false, nombre_policia: null, tiene_antecedentes: null, estado: 'no_encontrado', mensaje:
  'Cédula NO existe en el sistema', consultado_en: ts };
    }

    const snippet = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 400);
    console.log('[NO RECONOCIDO]', snippet);
    return { cedula, tiene_antecedentes: null, estado: 'indeterminado', mensaje: 'No se pudo determinar. Verifica manualmente.',
  consultado_en: ts };
  }

  const PORT = process.env.PORT || 10000;
  app.listen(PORT, () => console.log(`Servidor antecedentes activo en puerto ${PORT}`));
