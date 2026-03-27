const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { PassThrough } = require('stream');
const Docker = require('dockerode');

const docker = new Docker();

/** Limite implicite (Smart Resource Limits) */
const DEFAULT_LIMITS = {
  memoryBytes: 128 * 1024 * 1024,
  nanoCpus: 1_000_000_000,
  timeoutMs: 30_000,
};

const RUNTIMES = {
  nodejs: {
    image: 'node:20-alpine',
    filename: 'main.js',
    cmd: ['node', '/app/main.js'],
  },
  python: {
    image: 'python:3.12-alpine',
    filename: 'main.py',
    cmd: ['python', '/app/main.py'],
  },
  rust: {
    image: 'rust:1.76-alpine',
    filename: 'main.rs',
    cmd: ['sh', '-lc', 'rustc /app/main.rs -O -o /tmp/a && /tmp/a'],
  },
  c: {
    image: 'gcc:13',
    filename: 'main.c',
    cmd: ['sh', '-lc', 'gcc /app/main.c -O2 -o /tmp/a && /tmp/a'],
  },
  cpp: {
    image: 'gcc:13',
    filename: 'main.cpp',
    cmd: ['sh', '-lc', 'g++ /app/main.cpp -O2 -std=c++20 -o /tmp/a && /tmp/a'],
  },
  csharp: {
    image: 'mono:6',
    filename: 'main.cs',
    cmd: ['sh', '-lc', 'mcs /app/main.cs -out:/tmp/a.exe && mono /tmp/a.exe'],
  },
};

const pulled = new Set();

async function ensureImage(image) {
  if (pulled.has(image)) return;
  await new Promise((resolve, reject) => {
    docker.pull(image, (err, stream) => {
      if (err) return reject(err);
      docker.modem.followProgress(stream, (e) => (e ? reject(e) : resolve()));
    });
  });
  pulled.add(image);
}

function normalizeHostPathForDocker(p) {
  return path.resolve(p);
}

/**
 * @param {object} opts
 * @param {string} opts.language - nodejs | python | rust | c | cpp | csharp
 * @param {string} opts.code
 * @param {number} [opts.memoryBytes]
 * @param {number} [opts.nanoCpus]
 * @param {number} [opts.timeoutMs]
 * @param {(chunk: Buffer, stream: 'stdout'|'stderr') => void} [opts.onChunk]
 * @returns {Promise<{ exitCode: number, output: string }>}
 */
async function runInSandbox(opts) {
  const {
    language,
    code,
    memoryBytes = DEFAULT_LIMITS.memoryBytes,
    nanoCpus = DEFAULT_LIMITS.nanoCpus,
    timeoutMs = DEFAULT_LIMITS.timeoutMs,
    onChunk,
  } = opts;

  const runtime = RUNTIMES[language];
  if (!runtime) {
    const err = new Error(`Limbaj nesuportat: ${language}`);
    err.code = 'UNSUPPORTED_LANG';
    throw err;
  }

  await ensureImage(runtime.image);

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'itec-sbx-'));
  const hostPath = normalizeHostPathForDocker(workDir);
  const filePath = path.join(workDir, runtime.filename);
  await fs.writeFile(filePath, code, 'utf8');

  const binds = [`${hostPath}:/app:ro`];

  let container;
  let timer;
  try {
    container = await docker.createContainer({
      Image: runtime.image,
      Cmd: runtime.cmd,
      WorkingDir: '/app',
      HostConfig: {
        Binds: binds,
        Memory: memoryBytes,
        NanoCpus: nanoCpus,
        NetworkMode: 'none',
        AutoRemove: true,
        ReadonlyRootfs: false,
      },
      Tty: false,
    });

    const attach = await container.attach({
      stream: true,
      stdout: true,
      stderr: true,
    });

    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const chunks = [];

    const push = (buf, stream) => {
      chunks.push(buf);
      if (onChunk) onChunk(buf, stream);
    };

    stdout.on('data', (d) => push(d, 'stdout'));
    stderr.on('data', (d) => push(d, 'stderr'));

    container.modem.demuxStream(attach, stdout, stderr);

    const waitPromise = container.wait();
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(async () => {
        try {
          await container.kill();
        } catch (_) {
          /* ignore */
        }
        reject(Object.assign(new Error('Timeout sandbox'), { code: 'TIMEOUT' }));
      }, timeoutMs);
    });

    await container.start();

    let waitResult;
    try {
      waitResult = await Promise.race([waitPromise, timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
      timer = null;
    }

    const exitCode = waitResult.StatusCode ?? -1;

    return {
      exitCode,
      output: Buffer.concat(chunks).toString('utf8'),
    };
  } catch (e) {
    if (e.code === 'TIMEOUT') throw e;
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
    try {
      await fs.rm(workDir, { recursive: true, force: true });
    } catch (_) {
      /* ignore */
    }
  }
}

module.exports = {
  runInSandbox,
  RUNTIMES,
  DEFAULT_LIMITS,
};
