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
  
  if (!OPENAI_API_KEY) {
    return res.json({ response: 'Error: OPENAI_API_KEY not set. Set environment variable OPENAI_API_KEY to enable AI.\n\nTo get an API key:\n1. Visit https://platform.openai.com/api-keys\n2. Create a new API key\n3. Run: set OPENAI_API_KEY=your_key_here' });
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
      'Authorization': `Bearer ${OPENAI_API_KEY}`
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

function runCommand(lang, code) {
  return new Promise((resolve) => {
    let proc;
    let tempFiles = [];

    const done = (err, stdout, stderr, exitCode) => {
      tempFiles.forEach(cleanupPath);
      resolve({ ok: !err && exitCode === 0, stdout, stderr, code: exitCode });
    };

    if (lang === 'nodejs') {
      proc = spawn('node', ['-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
    } else if (lang === 'python') {
      proc = spawn('python', ['-c', code], { stdio: ['ignore', 'pipe', 'pipe'] });
    } else if (lang === 'rust') {
      const src = withTempFile('rs', code);
      const exe = withTempFile('exe', '');
      tempFiles.push(src, exe);
      proc = spawn('rustc', [src, '-o', exe], { stdio: ['ignore', 'pipe', 'pipe'] });
      proc.on('close', (status) => {
        if (status !== 0) return done(null, '', 'rustc failed', status);
        const run = spawn(exe, [], { stdio: ['ignore', 'pipe', 'pipe'] });
        let out='', err='';
        run.stdout.on('data', d=>out+=d.toString());
        run.stderr.on('data', d=>err+=d.toString());
        run.on('close', s=>done(null,out,err,s));
      });
      return;
    } else if (lang === 'c' || lang === 'cpp') {
      const ext = lang === 'c' ? 'c' : 'cpp';
      const src = withTempFile(ext, code);
      const exe = withTempFile('exe', '');
      tempFiles.push(src, exe);
      const compiler = lang === 'c' ? 'gcc' : 'g++';
      proc = spawn(compiler, [src, '-o', exe], { stdio: ['ignore', 'pipe', 'pipe'] });
      proc.on('close', (status) => {
        if (status !== 0) return done(null, '', compiler + ' compile failed', status);
        const run = spawn(exe, [], { stdio: ['ignore', 'pipe', 'pipe'] });
        let out='', err='';
        run.stdout.on('data', d=>out+=d.toString());
        run.stderr.on('data', d=>err+=d.toString());
        run.on('close', s=>done(null,out,err,s));
      });
      return;
    } else if (lang === 'csharp') {
      const src = withTempFile('cs', code);
      const dll = withTempFile('exe', '');
      tempFiles.push(src, dll);
      proc = spawn('mcs', [src, '-out:' + dll], { stdio: ['ignore', 'pipe', 'pipe'] });
      proc.on('close', (status) => {
        if (status !== 0) return done(null, '', 'mcs compile failed', status);
        const run = spawn('mono', [dll], { stdio: ['ignore', 'pipe', 'pipe'] });
        let out='', err='';
        run.stdout.on('data', d=>out+=d.toString());
        run.stderr.on('data', d=>err+=d.toString());
        run.on('close', s=>done(null,out,err,s));
      });
      return;
    } else if (lang === 'html' || lang === 'css') {
      return resolve({ ok: false, stdout: '', stderr: 'HTML/CSS should be handled by the browser, not the backend', code: 400 });
    } else {
      return resolve({ ok: false, stdout: '', stderr: 'Unsupported language: ' + lang, code: 400 });
    }

    let stdout = '', stderr = '';
    proc.stdout.on('data', chunk => stdout += chunk.toString());
    proc.stderr.on('data', chunk => stderr += chunk.toString());
    proc.on('error', (err) => done(err, '', err.message, 500));
    proc.on('close', (code) => done(null, stdout, stderr, code));
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
