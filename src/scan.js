/**
 * Scan rapid înainte de rulare (extensibil pentru integrări mai serioase).
 */
const PATTERNS = {
  nodejs: [
    { re: /\bchild_process\b/, msg: 'folosire child_process' },
    { re: /\brequire\s*\(\s*['"]fs['"]\s*\)/, msg: 'acces fs' },
  ],
  python: [
    { re: /\bos\.system\b|\bsubprocess\b/, msg: 'exec procese sistem' },
    { re: /\bopen\s*\(/, msg: 'open fișiere arbitrare' },
  ],
  rust: [
    { re: /\bstd::process::Command\b/, msg: 'exec procese sistem (Command)' },
    { re: /\bCommand::new\s*\(/, msg: 'exec procese sistem (Command::new)' },
  ],
  c: [
    { re: /\bsystem\s*\(/, msg: 'exec procese sistem (system)' },
    { re: /\bpopen\s*\(/, msg: 'exec shell (popen)' },
  ],
  cpp: [
    { re: /\bsystem\s*\(/, msg: 'exec procese sistem (system)' },
    { re: /\bpopen\s*\(/, msg: 'exec shell (popen)' },
  ],
  csharp: [
    {
      re: /\bSystem\.Diagnostics\.Process\b|\bProcess\.Start\s*\(/,
      msg: 'exec procese sistem (Process.Start)',
    },
  ],
};

function quickScan(code, language) {
  const rules = PATTERNS[language] || [];
  const warnings = [];
  for (const { re, msg } of rules) {
    if (re.test(code)) warnings.push(msg);
  }
  return {
    ok: warnings.length === 0,
    warnings,
  };
}

module.exports = { quickScan };
