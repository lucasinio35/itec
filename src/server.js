const express = require('express');
const path = require('path');
const { runInSandbox, RUNTIMES, DEFAULT_LIMITS } = require('./sandbox');
const { quickScan } = require('./scan');

const app = express();
const PORT = Number(process.env.PORT) || 3100;

app.use(express.json({ limit: '512kb' }));
app.use(express.static('public'));

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'app.html'));
});

/**
 * Blocuri AI în cod, delimitate cu markeri pe linii.
 * Rulează numai conținutul blocurilor cu status="accepted".
 *
 * Format:
 *   //__AI_BLOCK_START__:<id>:<lang>:<status>
 *   <block content>
 *   //__AI_BLOCK_END__:<id>
 */
function sanitizeCode(code) {
  if (typeof code !== 'string') return '';
  const START = '//__AI_BLOCK_START__:';
  const END_PREFIX = '//__AI_BLOCK_END__:';
  let idx = 0;
  let out = '';

  while (idx < code.length) {
    const startPos = code.indexOf(START, idx);
    if (startPos === -1) {
      out += code.slice(idx);
      break;
    }

    out += code.slice(idx, startPos);

    const lineEnd = code.indexOf('\n', startPos);
    if (lineEnd === -1) break;
    const headerLine = code.slice(startPos, lineEnd).trim();
    // headerLine like: //__AI_BLOCK_START__:<id>:<lang>:<status>
    const parts = headerLine.split(':');
    const blockId = parts[1];
    const lang = parts[2];
    const status = parts[3] || 'pending';

    const endMarker = `${END_PREFIX}${blockId}`;
    const contentStart = lineEnd + 1;
    const endPos = code.indexOf(endMarker, contentStart);
    if (endPos === -1) break;

    const content = code.slice(contentStart, endPos);
    if (status === 'accepted') out += content;

    // skip end marker line (+ trailing newline)
    const endLineEnd = code.indexOf('\n', endPos);
    idx = endLineEnd === -1 ? endPos + endMarker.length : endLineEnd + 1;

    // keep lang var used (avoid lint complaints in future)
    void lang;
  }
  return out;
}

function failDockerUnavailable(resOrSend, asStream) {
  const payload = {
    error:
      'Docker nu este disponibil. Pornește Docker Desktop și încearcă din nou.',
    code: 'DOCKER_UNAVAILABLE',
  };
  if (asStream) {
    resOrSend('error', payload);
    return;
  }
  resOrSend.status(503).json(payload);
}

function runFailedFromError(err) {
  if (err.code === 'TIMEOUT') return { status: 504, payload: { error: err.message, code: err.code } };
  if (err.code === 'ENOENT' || /docker/i.test(String(err.message))) {
    return { status: 503, payload: { error: 'Docker unavailable', code: 'DOCKER_UNAVAILABLE' } };
  }
  return { status: 500, payload: { error: err.message || 'Eroare la rulare sandbox' } };
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'itecify-sandbox' });
});

app.get('/api/sandbox/runtimes', (_req, res) => {
  res.json({
    languages: Object.keys(RUNTIMES),
    defaults: DEFAULT_LIMITS,
  });
});

/**
 * Rulare sincronă: întreg output-ul după ce se oprește containerul.
 */
app.post('/api/sandbox/run', async (req, res) => {
  const {
    language,
    code,
    memoryBytes,
    nanoCpus,
    timeoutMs,
    skipScan,
  } = req.body || {};

  if (typeof code !== 'string') {
    return res.status(400).json({ error: 'Câmpul code (string) este obligatoriu.' });
  }

  if (!language || !RUNTIMES[language]) {
    return res.status(400).json({
      error: 'Limbaj invalid.',
      allowed: Object.keys(RUNTIMES),
    });
  }

  if (!skipScan) {
    const clean = sanitizeCode(code);
    const scan = quickScan(clean, language);
    if (!scan.ok) {
      return res.status(400).json({
        error: 'Scan: posibile riscuri',
        warnings: scan.warnings,
      });
    }
  }

  try {
    const clean = sanitizeCode(code);
    const result = await runInSandbox({
      language,
      code: clean,
      memoryBytes,
      nanoCpus,
      timeoutMs,
    });
    res.json(result);
  } catch (err) {
    if (err.code === 'ENOENT' || /docker/i.test(String(err.message))) return failDockerUnavailable(res, false);
    const failed = runFailedFromError(err);
    console.error(err);
    res.status(failed.status).json(failed.payload);
  }
});

/**
 * Streaming SSE: stdout/stderr pe măsură ce vin din container.
 */
app.post('/api/sandbox/run/stream', async (req, res) => {
  const {
    language,
    code,
    memoryBytes,
    nanoCpus,
    timeoutMs,
    skipScan,
  } = req.body || {};

  if (typeof code !== 'string') {
    return res.status(400).json({ error: 'Câmpul code (string) este obligatoriu.' });
  }

  if (!language || !RUNTIMES[language]) {
    return res.status(400).json({
      error: 'Limbaj invalid.',
      allowed: Object.keys(RUNTIMES),
    });
  }

  if (!skipScan) {
    const clean = sanitizeCode(code);
    const scan = quickScan(clean, language);
    if (!scan.ok) {
      return res.status(400).json({
        error: 'Scan: posibile riscuri',
        warnings: scan.warnings,
      });
    }
  }

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const send = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const clean = sanitizeCode(code);
    const result = await runInSandbox({
      language,
      code: clean,
      memoryBytes,
      nanoCpus,
      timeoutMs,
      onChunk: (buf, stream) => {
        send('chunk', { stream, text: buf.toString('utf8') });
      },
    });
    send('done', { exitCode: result.exitCode });
    res.end();
  } catch (err) {
    if (err.code === 'TIMEOUT') {
      send('error', { code: 'TIMEOUT', message: err.message });
    } else if (err.code === 'ENOENT' || /docker/i.test(String(err.message))) {
      failDockerUnavailable(send, true);
    } else {
      send('error', { message: err.message || String(err) });
    }
    res.end();
  }
});

/**
 * Rulează mai multe limbaje în același flux de terminal (SSE), secvențial.
 * Body: { steps: [{ language, code, fileName? }], timeoutMs, memoryBytes, nanoCpus, skipScan }
 */
app.post('/api/sandbox/run/chain', async (req, res) => {
  const { steps, timeoutMs, memoryBytes, nanoCpus, skipScan } = req.body || {};
  if (!Array.isArray(steps) || steps.length === 0) {
    return res.status(400).json({ error: 'steps trebuie să fie un array ne-gol.' });
  }

  for (const step of steps) {
    if (!step || typeof step.code !== 'string' || !step.language || !RUNTIMES[step.language]) {
      return res.status(400).json({
        error: 'Fiecare step trebuie să aibă language valid și code (string).',
        allowed: Object.keys(RUNTIMES),
      });
    }
    if (!skipScan) {
      const clean = sanitizeCode(step.code);
      const scan = quickScan(clean, step.language);
      if (!scan.ok) {
        return res.status(400).json({
          error: `Scan: posibile riscuri în step ${step.fileName || step.language}`,
          warnings: scan.warnings,
        });
      }
    }
  }

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const send = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  let aborted = false;
  req.on('close', () => {
    aborted = true;
  });

  const results = [];
  for (let i = 0; i < steps.length; i += 1) {
    if (aborted) break;
    const step = steps[i];
    const label = step.fileName || `${step.language}-${i + 1}`;
    send('step-start', { index: i, language: step.language, label });
    try {
      const clean = sanitizeCode(step.code);
      const result = await runInSandbox({
        language: step.language,
        code: clean,
        timeoutMs,
        memoryBytes,
        nanoCpus,
        onChunk: (buf, stream) => {
          send('chunk', {
            index: i,
            language: step.language,
            label,
            stream,
            text: buf.toString('utf8'),
          });
        },
      });
      results.push({ index: i, language: step.language, label, exitCode: result.exitCode });
      send('step-done', { index: i, language: step.language, label, exitCode: result.exitCode });
    } catch (err) {
      if (err.code === 'ENOENT' || /docker/i.test(String(err.message))) {
        failDockerUnavailable(send, true);
      } else if (err.code === 'TIMEOUT') {
        send('error', { code: 'TIMEOUT', message: `${label}: ${err.message}` });
      } else {
        send('error', { message: `${label}: ${err.message || String(err)}` });
      }
      send('done', { ok: false, results });
      res.end();
      return;
    }
  }

  send('done', { ok: true, results });
  res.end();
});

const server = app.listen(PORT, () => {
  console.log(`itecify sandbox http://localhost:${PORT}`);
});

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(
      `Portul ${PORT} este ocupat. Pornește cu PORT=3002 (sau alt port liber).`,
    );
    process.exit(1);
  }
  console.error(err);
  process.exit(1);
});
