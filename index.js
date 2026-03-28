const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const https = require('https');

const app = express();
const PORT = Number(process.env.PORT) || 3002;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';

app.use(express.json({ limit: '5mb' }));
app.use(express.static('public'));

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'itecify-sandbox', port: PORT });
});

app.post('/api/ai', async (req, res) => {
  const prompt = req.body?.prompt || '';
  // Accept key from env var OR from the browser-sent header (for client-configured keys)
  const apiKey = OPENAI_API_KEY || req.headers['x-openai-key'] || '';

  if (!apiKey) {
    return res.json({ response: 'Error: No OpenAI API key configured.\n\nOptions:\n1. Set env var: set OPENAI_API_KEY=sk-...\n2. In the app: open "Code Assistant" → click "🔑 Set OpenAI API Key"' });
  }

  const payload = JSON.stringify({
    model: 'gpt-3.5-turbo',
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 500,
    temperature: 0.7
  });

  const options = {
    hostname: 'api.openai.com',
    port: 443,
    path: '/v1/chat/completions',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
      'Authorization': `Bearer ${apiKey}`
    }
  };

  try {
    const request = https.request(options, (response) => {
      let data = '';
      response.on('data', chunk => data += chunk);
      response.on('end', () => {
        if (response.statusCode !== 200) {
          return res.json({ response: `OpenAI API Error ${response.statusCode}: ${data}` });
        }
        try {
          const json = JSON.parse(data);
          const answer = json.choices?.[0]?.message?.content || 'No response from AI';
          res.json({ response: answer });
        } catch (err) {
          res.json({ response: `Parse error: ${err.message}` });
        }
      });
    });

    request.on('error', (err) => {
      res.json({ response: `AI Error: ${err.message}` });
    });

    request.write(payload);
    request.end();
  } catch (err) {
    res.json({ response: `AI Error: ${err.message}` });
  }
});

function withTempFile(ext, content) {
  const name = `itecify-${Date.now()}-${Math.random().toString(16).slice(2)}.${ext}`;
  const filePath = path.join(os.tmpdir(), name);
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}

function cleanupPath(filePath) {
  try { fs.unlinkSync(filePath); } catch (err) { /* ignore */ }
}

const EXEC_TIMEOUT_MS = 10000; // 10 seconds max execution time

function runCommand(lang, code) {
  return new Promise((resolve) => {
    let proc;
    let tempFiles = [];
    let finished = false;

    const done = (err, stdout, stderr, exitCode) => {
      if (finished) return;
      finished = true;
      tempFiles.forEach(cleanupPath);
      resolve({ ok: !err && exitCode === 0, stdout, stderr, code: exitCode });
    };

    const killOnTimeout = (childProc, label) => {
      return setTimeout(() => {
        if (!finished) {
          try { childProc.kill('SIGKILL'); } catch (_) {}
          done(null, '', `${label} timed out after ${EXEC_TIMEOUT_MS / 1000}s`, 124);
        }
      }, EXEC_TIMEOUT_MS);
    };

    const attachRunProcess = (exePath) => {
      const run = spawn(exePath, [], { stdio: ['ignore', 'pipe', 'pipe'] });
      const timer = killOnTimeout(run, 'execution');
      let out = '', err = '';
      run.stdout.on('data', d => out += d.toString());
      run.stderr.on('data', d => err += d.toString());
      run.on('error', (e) => { clearTimeout(timer); done(e, '', e.message, 500); });
      run.on('close', (s) => { clearTimeout(timer); done(null, out, err, s); });
    };

    if (lang === 'nodejs') {
      proc = spawn('node', ['-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
    } else if (lang === 'python') {
      proc = spawn('python', ['-c', code], { stdio: ['ignore', 'pipe', 'pipe'] });
    } else if (lang === 'rust') {
      const src = withTempFile('rs', code);
      const exeName = `itecify-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const exe = path.join(os.tmpdir(), exeName);
      tempFiles.push(src, exe);
      let compileStderr = '';
      proc = spawn('rustc', [src, '-o', exe], { stdio: ['ignore', 'pipe', 'pipe'] });
      proc.stderr.on('data', d => compileStderr += d.toString());
      proc.on('error', (e) => done(e, '', e.message, 500));
      proc.on('close', (status) => {
        if (status !== 0) return done(null, '', compileStderr || 'rustc compile failed', status);
        attachRunProcess(exe);
      });
      return;
    } else if (lang === 'c' || lang === 'cpp') {
      const ext = lang === 'c' ? 'c' : 'cpp';
      const src = withTempFile(ext, code);
      const exeName = `itecify-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const exe = path.join(os.tmpdir(), exeName);
      tempFiles.push(src, exe);
      const compiler = lang === 'c' ? 'gcc' : 'g++';
      let compileStderr = '';
      proc = spawn(compiler, [src, '-o', exe], { stdio: ['ignore', 'pipe', 'pipe'] });
      proc.stderr.on('data', d => compileStderr += d.toString());
      proc.on('error', (e) => done(e, '', e.message, 500));
      proc.on('close', (status) => {
        if (status !== 0) return done(null, '', compileStderr || `${compiler} compile failed`, status);
        attachRunProcess(exe);
      });
      return;
    } else if (lang === 'csharp') {
      const src = withTempFile('cs', code);
      const exeName = `itecify-${Date.now()}-${Math.random().toString(16).slice(2)}.exe`;
      const dll = path.join(os.tmpdir(), exeName);
      tempFiles.push(src, dll);
      let compileStderr = '';
      proc = spawn('mcs', [src, '-out:' + dll], { stdio: ['ignore', 'pipe', 'pipe'] });
      proc.stderr.on('data', d => compileStderr += d.toString());
      proc.on('error', (e) => done(e, '', e.message, 500));
      proc.on('close', (status) => {
        if (status !== 0) return done(null, '', compileStderr || 'mcs compile failed', status);
        const run = spawn('mono', [dll], { stdio: ['ignore', 'pipe', 'pipe'] });
        const timer = killOnTimeout(run, 'mono execution');
        let out = '', err = '';
        run.stdout.on('data', d => out += d.toString());
        run.stderr.on('data', d => err += d.toString());
        run.on('error', (e) => { clearTimeout(timer); done(e, '', e.message, 500); });
        run.on('close', (s) => { clearTimeout(timer); done(null, out, err, s); });
      });
      return;
    } else if (lang === 'html' || lang === 'css') {
      return resolve({ ok: false, stdout: '', stderr: 'HTML/CSS should be handled by the browser, not the backend', code: 400 });
    } else {
      return resolve({ ok: false, stdout: '', stderr: 'Unsupported language: ' + lang, code: 400 });
    }

    let stdout = '', stderr = '';
    const timer = killOnTimeout(proc, lang);
    proc.stdout.on('data', chunk => stdout += chunk.toString());
    proc.stderr.on('data', chunk => stderr += chunk.toString());
    proc.on('error', (err) => { clearTimeout(timer); done(err, '', err.message, 500); });
    proc.on('close', (code) => { clearTimeout(timer); done(null, stdout, stderr, code); });
  });
}

function sanitizeInput(code) {
  // simple guard
  if (typeof code !== 'string') return '';
  if (code.length > 200000) return code.slice(0, 200000);
  return code;
}

app.post('/api/sandbox/run', async (req, res) => {
  const { language, code } = req.body || {};
  if (!language || !code) return res.status(400).json({ error: 'language and code required' });
  const clean = sanitizeInput(code);
  const result = await runCommand(language, clean);
  res.json(result);
});

app.post('/api/sandbox/run/chain', async (req, res) => {
  const { steps } = req.body || {};
  if (!Array.isArray(steps) || !steps.length) {
    return res.status(400).json({ error: 'steps required' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const send = (evt, data) => {
    res.write(`event: ${evt}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  let results = [];

  for (let i=0; i<steps.length; i++) {
    const step = steps[i];
    if (!step || !step.language || !step.code) continue;
    send('step-start', { index:i, language: step.language, label: step.fileName || step.language });
    const run = await runCommand(step.language, sanitizeInput(step.code));
    send('chunk', { index:i, text: run.stdout || '' });
    if (run.stderr) send('chunk', { index:i, text: run.stderr });
    send('step-done', { index:i, exitCode: run.code });
    results.push({ ...step, exitCode: run.code });
    if (!run.ok) break;
  }

  send('done', { ok: true, results });
  res.end();
});

app.listen(PORT, () => {
  console.log(`itecify sandbox listening http://localhost:${PORT}`);
});
