const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const https = require('https');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const http = require('http');
const encoding = require('lib0/encoding');
const decoding = require('lib0/decoding');
const syncProtocol = require('y-protocols/sync');
const awarenessProtocol = require('y-protocols/awareness');

const app = express();
const PORT = Number(process.env.PORT) || 3002;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const JWT_SECRET = process.env.JWT_SECRET || 'strong-jwt-secret';
const JWT_EXPIRES_IN = '2h';

const users = [];
const workspaces = [];  // {id, name, ownerId, members:[userId]}
const files = [];       // {id, workspaceId, name, language, code, createdAt, updatedAt}

const DATABASE_FILE = path.join(__dirname, 'database.json');

// Yjs WebSocket storage: {`${workspaceId}/${fileId}`: Set of clients}
const yjs_rooms = new Map();

function loadDatabase() {
  try {
    if (fs.existsSync(DATABASE_FILE)) {
      const data = fs.readFileSync(DATABASE_FILE, 'utf8');
      const parsed = JSON.parse(data);
      users.length = 0;
      users.push(...(parsed.users || []));
      workspaces.length = 0;
      workspaces.push(...(parsed.workspaces || []));
      files.length = 0;
      files.push(...(parsed.files || []));
      console.log(`✓ Database loaded: ${users.length} users, ${workspaces.length} workspaces, ${files.length} files`);
    } else {
      console.log('ℹ No database file found, starting fresh');
    }
  } catch (err) {
    console.warn('⚠ Error loading database:', err.message);
  }
}

function saveDatabase() {
  try {
    const data = JSON.stringify({ users, workspaces, files }, null, 2);
    fs.writeFileSync(DATABASE_FILE, data, 'utf8');
  } catch (err) {
    console.error('✗ Error saving database:', err.message);
  }
}

function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

function generateToken(user) {
  return jwt.sign({ id: user.id, username: user.username, email: user.email }, JWT_SECRET, {
    expiresIn: JWT_EXPIRES_IN,
  });
}

function authenticateJWT(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authorization header missing or invalid' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    return next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function getUserById(id) {
  return users.find((u) => u.id === id);
}

function canAccessWorkspace(userId, workspaceId) {
  const workspace = workspaces.find((w) => w.id === workspaceId);
  if (!workspace) return false;
  return workspace.members.includes(userId);
}

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

app.post('/api/auth/register', (req, res) => {
  const { username, email, password } = req.body || {};
  if (!username || !email || !password) {
    return res.status(400).json({ error: 'username, email and password are required' });
  }
  if (users.some((u) => u.username === username || u.email === email)) {
    return res.status(409).json({ error: 'User already exists' });
  }
  const user = {
    id: 'user-' + Date.now() + '-' + Math.random().toString(16).slice(2),
    username,
    email,
    password: hashPassword(password)
  };
  users.push(user);
  saveDatabase();
  const token = generateToken(user);
  res.json({ message: 'Registered', token, user: { id: user.id, username: user.username, email: user.email } });
});

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'username and password are required' });
  }
  const user = users.find((u) => u.username === username || u.email === username);
  if (!user || user.password !== hashPassword(password)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const token = generateToken(user);
  res.json({ message: 'Logged in', token, user: { id: user.id, username: user.username, email: user.email } });
});

app.post('/api/workspaces', authenticateJWT, (req, res) => {
  const { name } = req.body || {};
  if (!name) {
    return res.status(400).json({ error: 'Workspace name is required' });
  }
  const workspace = {
    id: 'ws-' + Date.now() + '-' + Math.random().toString(16).slice(2),
    name,
    ownerId: req.user.id,
    members: [req.user.id]
  };
  workspaces.push(workspace);
  saveDatabase();
  res.json({ message: 'Workspace created', workspace });
});

app.post('/api/workspaces/:workspaceId/add-member', authenticateJWT, (req, res) => {
  const { workspaceId } = req.params;
  const { identifier } = req.body || {}; // username or email
  if (!identifier) {
    return res.status(400).json({ error: 'identifier is required' });
  }
  const workspace = workspaces.find((w) => w.id === workspaceId);
  if (!workspace) {
    return res.status(404).json({ error: 'Workspace not found' });
  }
  if (workspace.ownerId !== req.user.id) {
    return res.status(403).json({ error: 'Only workspace owner can add members' });
  }
  const userToAdd = users.find((u) => u.username === identifier || u.email === identifier);
  if (!userToAdd) {
    return res.status(404).json({ error: 'User not found' });
  }
  if (!workspace.members.includes(userToAdd.id)) {
    workspace.members.push(userToAdd.id);
    saveDatabase();
  }
  res.json({ message: 'Member added', workspace });
});

app.get('/api/workspaces/:workspaceId', authenticateJWT, (req, res) => {
  const workspace = workspaces.find((w) => w.id === req.params.workspaceId);
  if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
  if (!canAccessWorkspace(req.user.id, workspace.id)) return res.status(403).json({ error: 'Forbidden' });
  res.json({ workspace });
});

app.get('/api/workspaces', authenticateJWT, (req, res) => {
  const mine = workspaces.filter((w) => w.members.includes(req.user.id));
  res.json({ workspaces: mine });
});

app.get('/api/workspaces/:workspaceId/members', authenticateJWT, (req, res) => {
  const workspace = workspaces.find((w) => w.id === req.params.workspaceId);
  if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
  if (!canAccessWorkspace(req.user.id, workspace.id)) return res.status(403).json({ error: 'Forbidden' });
  
  const members = workspace.members.map(userId => {
    const user = users.find(u => u.id === userId);
    return user ? { id: user.id, username: user.username, email: user.email } : null;
  }).filter(Boolean);
  
  res.json({ members });
});

// ============ FILE API ============

// List files in a workspace
app.get('/api/workspaces/:workspaceId/files', authenticateJWT, (req, res) => {
  const workspace = workspaces.find((w) => w.id === req.params.workspaceId);
  if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
  if (!canAccessWorkspace(req.user.id, workspace.id)) return res.status(403).json({ error: 'Forbidden' });
  
  const workspaceFiles = files.filter(f => f.workspaceId === req.params.workspaceId);
  res.json({ files: workspaceFiles });
});

// Create a new file
app.post('/api/workspaces/:workspaceId/files', authenticateJWT, (req, res) => {
  const workspace = workspaces.find((w) => w.id === req.params.workspaceId);
  if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
  if (!canAccessWorkspace(req.user.id, workspace.id)) return res.status(403).json({ error: 'Forbidden' });
  
  const { name, language, code } = req.body || {};
  if (!name) return res.status(400).json({ error: 'File name is required' });
  
  const file = {
    id: 'file-' + Date.now() + '-' + Math.random().toString(16).slice(2),
    workspaceId: req.params.workspaceId,
    name: name.trim(),
    language: language || 'nodejs',
    code: code || '',
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  
  files.push(file);
  saveDatabase();
  
  // Broadcast to all connected clients in this workspace via WebSocket
  broadcastToWorkspace(workspace.id, {
    type: 'file-created',
    file: file
  });
  
  res.json({ message: 'File created', file });
});

// Get a single file
app.get('/api/files/:fileId', authenticateJWT, (req, res) => {
  const file = files.find((f) => f.id === req.params.fileId);
  if (!file) return res.status(404).json({ error: 'File not found' });
  
  if (!canAccessWorkspace(req.user.id, file.workspaceId)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  
  res.json({ file });
});

// Update a file
app.put('/api/files/:fileId', authenticateJWT, (req, res) => {
  const file = files.find((f) => f.id === req.params.fileId);
  if (!file) return res.status(404).json({ error: 'File not found' });
  
  if (!canAccessWorkspace(req.user.id, file.workspaceId)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  
  const { name, language, code } = req.body || {};
  
  if (name !== undefined) file.name = name.trim();
  if (language !== undefined) file.language = language;
  if (code !== undefined) file.code = code;
  file.updatedAt = Date.now();
  
  saveDatabase();
  
  // Broadcast update to all connected clients in this workspace
  broadcastToWorkspace(file.workspaceId, {
    type: 'file-updated',
    file: { ...file }
  });
  
  res.json({ message: 'File updated', file });
});

// Delete a file
app.delete('/api/files/:fileId', authenticateJWT, (req, res) => {
  const fileIndex = files.findIndex((f) => f.id === req.params.fileId);
  if (fileIndex === -1) return res.status(404).json({ error: 'File not found' });
  
  const file = files[fileIndex];
  
  if (!canAccessWorkspace(req.user.id, file.workspaceId)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  
  const workspaceId = file.workspaceId;
  files.splice(fileIndex, 1);
  saveDatabase();
  
  // Broadcast deletion to all connected clients in this workspace
  broadcastToWorkspace(workspaceId, {
    type: 'file-deleted',
    fileId: req.params.fileId
  });
  
  res.json({ message: 'File deleted' });
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
const IS_WINDOWS = process.platform === 'win32';
// On Windows, GCC/G++/rustc automatically append .exe to output files with no extension
const EXE_EXT = IS_WINDOWS ? '.exe' : '';

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
          try { childProc.kill(); } catch (_) {} // kill() works cross-platform; SIGKILL does not exist on Windows
          done(null, '', `${label} timed out after ${EXEC_TIMEOUT_MS / 1000}s`, 124);
        }
      }, EXEC_TIMEOUT_MS);
    };

    const attachRunProcess = (exePath) => {
      // shell:true needed on Windows to execute binaries in arbitrary temp paths
      const run = spawn(exePath, [], { stdio: ['ignore', 'pipe', 'pipe'], shell: IS_WINDOWS });
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
      // Try python aliases in order; self-contained with return so it never
      // conflicts with the fall-through bottom listener block.
      const pyAliases = IS_WINDOWS ? ['python', 'python3'] : ['python3', 'python'];
      const tryPython = (idx) => {
        if (idx >= pyAliases.length) {
          return done(null, '', 'Python interpreter not found. Install Python and ensure it is in PATH.', 1);
        }
        const p = spawn(pyAliases[idx], ['-c', code], { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '', errStr = '';
        const t = killOnTimeout(p, pyAliases[idx]);
        p.stdout.on('data', d => out += d.toString());
        p.stderr.on('data', d => errStr += d.toString());
        p.on('error', (e) => {
          clearTimeout(t);
          if (e.code === 'ENOENT') { tryPython(idx + 1); }
          else { done(e, '', e.message, 500); }
        });
        p.on('close', (s) => { clearTimeout(t); done(null, out, errStr, s); });
      };
      tryPython(0);
      return;
    } else if (lang === 'rust') {
      const src = withTempFile('rs', code);
      const exeName = `itecify-${Date.now()}-${Math.random().toString(16).slice(2)}${EXE_EXT}`;
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
      const exeName = `itecify-${Date.now()}-${Math.random().toString(16).slice(2)}${EXE_EXT}`;
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
    proc.on('error', (e) => { clearTimeout(timer); done(e, '', e.message, 500); });
    proc.on('close', (code) => { clearTimeout(timer); done(null, stdout, stderr, code); });
  });
}

function sanitizeInput(code) {
  // simple guard
  if (typeof code !== 'string') return '';
  if (code.length > 200000) return code.slice(0, 200000);
  return code;
}

app.post('/api/sandbox/run', authenticateJWT, async (req, res) => {
  const { language, code, workspaceId } = req.body || {};
  if (!language || !code || !workspaceId) return res.status(400).json({ error: 'language, code and workspaceId are required' });
  if (!canAccessWorkspace(req.user.id, workspaceId)) {
    return res.status(403).json({ error: 'User not part of workspace' });
  }
  const clean = sanitizeInput(code);
  const result = await runCommand(language, clean);
  res.json(result);
});

app.post('/api/sandbox/run/chain', authenticateJWT, async (req, res) => {
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

// Create HTTP server and attach WebSocket server
const server = http.createServer(app);

// Yjs WebSocket server - handles CRDT document sync
const yjsWss = new WebSocketServer({ noServer: true });

// Sync WebSocket server - handles file create/delete/rename notifications
const syncWss = new WebSocketServer({ noServer: true });

// Handle WebSocket upgrade for /yjs path (Yjs CRDT sync)
server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const pathParts = url.pathname.split('/');
  
  // /yjs/workspaceId/fileId - Yjs document sync
  if (pathParts[1] === 'yjs' && pathParts.length >= 4) {
    const workspaceId = pathParts[2];
    const fileId = pathParts[3];
    const token = url.searchParams.get('token');
    
    if (!workspaceId || !fileId || !token) {
      socket.destroy();
      return;
    }
    
    // Verify JWT token
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      request.user = decoded;
    } catch (err) {
      console.warn('WebSocket auth failed:', err.message);
      socket.destroy();
      return;
    }
    
    // Check workspace access
    const workspace = workspaces.find(w => w.id === workspaceId);
    if (!workspace || !workspace.members.includes(decoded.id)) {
      console.warn('WebSocket: No access to workspace', workspaceId);
      socket.destroy();
      return;
    }
    
    // Modify URL to use room name as expected by y-websocket
    request.url = `/${workspaceId}/${fileId}`;
    
    yjsWss.handleUpgrade(request, socket, head, (ws) => {
      yjsWss.emit('connection', ws, request);
    });
  }
  // /sync/workspaceId - File sync notifications
  else if (pathParts[1] === 'sync' && pathParts.length >= 3) {
    const workspaceId = pathParts[2];
    const token = url.searchParams.get('token');
    
    if (!workspaceId || !token) {
      socket.destroy();
      return;
    }
    
    // Verify JWT token
    let decoded;
    try {
      decoded = jwt.verify(token, JWT_SECRET);
      request.user = decoded;
    } catch (err) {
      socket.destroy();
      return;
    }
    
    // Check workspace access
    const workspace = workspaces.find(w => w.id === workspaceId);
    if (!workspace || !workspace.members.includes(decoded.id)) {
      socket.destroy();
      return;
    }
    
    syncWss.handleUpgrade(request, socket, head, (ws) => {
      syncWss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

// Setup Yjs WebSocket connections with proper CRDT sync
// Message types for y-websocket protocol
const messageSync = 0;
const messageAwareness = 1;

yjsWss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const roomName = url.pathname.slice(1); // Remove leading /
  
  console.log(`✓ Yjs client connected: ${roomName}`);
  
  // Get or create Yjs document for this room
  if (!yjs_docs.has(roomName)) {
    const Y = require('yjs');
    yjs_docs.set(roomName, {
      doc: new Y.Doc(),
      awareness: new awarenessProtocol.Awareness(new Y.Doc()),
      clients: new Set()
    });
  }
  
  const room = yjs_docs.get(roomName);
  room.clients.add(ws);
  
  // Send sync step 1 to new client
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, messageSync);
  syncProtocol.writeSyncStep1(encoder, room.doc);
  ws.send(encoding.toUint8Array(encoder));
  
  // Send awareness state
  const awarenessEncoder = encoding.createEncoder();
  encoding.writeVarUint(awarenessEncoder, messageAwareness);
  encoding.writeVarUint8Array(awarenessEncoder, awarenessProtocol.encodeAwarenessUpdate(
    room.awareness,
    Array.from(room.awareness.getStates().keys())
  ));
  ws.send(encoding.toUint8Array(awarenessEncoder));
  
  // Handle incoming messages
  ws.on('message', (message) => {
    try {
      const buf = new Uint8Array(message);
      const decoder = decoding.createDecoder(buf);
      const messageType = decoding.readVarUint(decoder);
      
      if (messageType === messageSync) {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, messageSync);
        const syncMessageType = syncProtocol.readSyncMessage(decoder, encoder, room.doc, ws);
        
        // If sync step 2 or update, broadcast to all other clients
        if (syncMessageType === syncProtocol.messageYjsSyncStep2 ||
            syncMessageType === syncProtocol.messageYjsUpdate) {
          const update = encoding.toUint8Array(encoder);
          room.clients.forEach(client => {
            if (client !== ws && client.readyState === 1) {
              client.send(update);
            }
          });
        }
        
        // Always send response to sender
        if (encoding.length(encoder) > 1) {
          ws.send(encoding.toUint8Array(encoder));
        }
      }
      else if (messageType === messageAwareness) {
        const update = decoding.readVarUint8Array(decoder);
        awarenessProtocol.applyAwarenessUpdate(room.awareness, update, ws);
        
        // Broadcast to all other clients
        room.clients.forEach(client => {
          if (client !== ws && client.readyState === 1) {
            const encoder = encoding.createEncoder();
            encoding.writeVarUint(encoder, messageAwareness);
            encoding.writeVarUint8Array(encoder, update);
            client.send(encoding.toUint8Array(encoder));
          }
        });
      }
    } catch (err) {
      console.warn('Yjs message error:', err.message);
    }
  });
  
  // Listen for document updates
  const updateHandler = (update, origin) => {
    if (origin !== ws) {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, messageSync);
      syncProtocol.writeUpdate(encoder, update);
      room.clients.forEach(client => {
        if (client.readyState === 1) {
          client.send(encoding.toUint8Array(encoder));
        }
      });
    }
  };
  room.doc.on('update', updateHandler);
  
  // Listen for awareness updates
  const awarenessChangeHandler = ({ added, updated, removed }, origin) => {
    const changedClients = added.concat(updated, removed);
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, messageAwareness);
    encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(
      room.awareness,
      changedClients
    ));
    const message = encoding.toUint8Array(encoder);
    room.clients.forEach(client => {
      if (client.readyState === 1) {
        client.send(message);
      }
    });
  };
  room.awareness.on('update', awarenessChangeHandler);
  
  ws.on('close', () => {
    room.clients.delete(ws);
    console.log(`✓ Yjs client disconnected: ${roomName} (${room.clients.size} remaining)`);
    
    // Remove from awareness
    awarenessProtocol.removeAwarenessStates(room.awareness, [room.doc.clientID], null);
    
    // Clean up empty rooms
    if (room.clients.size === 0) {
      room.doc.off('update', updateHandler);
      room.awareness.off('update', awarenessChangeHandler);
    }
  });
});

// Map of room name -> { doc, awareness, clients }
const yjs_docs = new Map();

// Setup Sync WebSocket connections for file notifications
syncWss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathParts = url.pathname.split('/');
  const workspaceId = pathParts[2];
  const roomId = `sync-${workspaceId}`;
  
  if (!yjs_rooms.has(roomId)) {
    yjs_rooms.set(roomId, new Set());
  }
  yjs_rooms.get(roomId).add(ws);
  
  console.log(`✓ Sync client connected: ${workspaceId} (${yjs_rooms.get(roomId).size} clients)`);
  
  ws.on('close', () => {
    const room = yjs_rooms.get(roomId);
    if (room) {
      room.delete(ws);
      if (room.size === 0) {
        yjs_rooms.delete(roomId);
      }
    }
  });
});

// Broadcast to sync room
function broadcastToWorkspace(workspaceId, message) {
  const roomId = `sync-${workspaceId}`;
  const room = yjs_rooms.get(roomId);
  if (room) {
    const msgStr = JSON.stringify(message);
    room.forEach(client => {
      if (client.readyState === 1) {
        try {
          client.send(msgStr);
        } catch (err) {
          console.warn('Broadcast error:', err.message);
        }
      }
    });
  }
}

server.listen(PORT, '0.0.0.0', () => {
  loadDatabase();
  const localIP = Object.values(require('os').networkInterfaces())
    .flat()
    .filter(addr => addr.family === 'IPv4' && !addr.internal)
    .map(addr => addr.address)[0] || 'localhost';
  console.log(`✓ itecify sandbox listening on http://localhost:${PORT}`);
  console.log(`✓ WebSocket available on ws://localhost:${PORT}/yjs/{workspaceId}/{fileId}`);
  console.log(`  From another PC: http://${localIP}:${PORT}`);
  console.log(`  WebSocket from other PC: ws://${localIP}:${PORT}/yjs/{workspaceId}/{fileId}`);
});
