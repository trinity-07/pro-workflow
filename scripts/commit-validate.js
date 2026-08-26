#!/usr/bin/env node
const TYPES = ['feat', 'fix', 'refactor', 'test', 'docs', 'chore', 'perf', 'ci', 'style', 'build', 'revert'];
const PATTERN = new RegExp(`^(${TYPES.join('|')})(\\([\\w\\-.,/ ]+\\))?!?: .+`);
const MAX_SUMMARY = 72;

function readStdin() {
  return new Promise(resolve => {
    let data = '';
    process.stdin.on('data', c => { data += c; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(''));
  });
}

/**
 * Split a command into its heredoc (if any) and the command text with that
 * heredoc's span removed.
 *
 * Everything inside a heredoc body is data, not shell syntax: a `-m`, a
 * `--message`, or the literal words `git commit` written there are prose in
 * someone's commit message or file content, not flags and not a commit. Every
 * pattern test in this hook that asks "what shape is this command" must run
 * against `scan`, never the raw string.
 */
function stripHeredoc(command) {
  const heredoc = command.match(/<<-?\s*'?([A-Za-z_][A-Za-z0-9_]*)'?\s*\n([\s\S]*?)\n\s*\1\s*$/m);
  const scan = heredoc
    ? command.slice(0, heredoc.index) + command.slice(heredoc.index + heredoc[0].length)
    : command;
  return { heredoc, scan };
}

/**
 * Reduce a command to its shell SHAPE: the text that the shell would actually
 * execute as syntax, with every container of user data removed.
 *
 * Three containers have each shipped as a separate bug in this file, because
 * each fix removed one container instead of naming the class:
 *
 *   1. a heredoc body                  cat > f <<'EOF' ... git commit ... EOF
 *   2. a quoted argument               echo "git commit -m wip"
 *   3. a comment                       ls -la # git commit -m wip
 *
 * All three are text the user is writing, printing, searching for or
 * disabling. None of them is a commit. A shape test that runs against the raw
 * command string cannot tell the difference, so it must run against this.
 *
 * Quoted spans collapse to a single space rather than vanishing, so that
 * `git commit -m "x"` still reads as three tokens and not two.
 */
function shellShape(command) {
  const { scan } = stripHeredoc(command || '');
  let out = '';
  let i = 0;

  while (i < scan.length) {
    const ch = scan[i];

    if (ch === '\\') { out += ' '; i += 2; continue; }

    if (ch === "'") {
      const end = scan.indexOf("'", i + 1);
      i = end === -1 ? scan.length : end + 1;
      out += ' ';
      continue;
    }

    if (ch === '"') {
      i += 1;
      while (i < scan.length && scan[i] !== '"') i += scan[i] === '\\' ? 2 : 1;
      i += 1;
      out += ' ';
      continue;
    }

    // A `#` only opens a comment at the start of a word.
    if (ch === '#' && (out === '' || /\s/.test(out[out.length - 1]))) {
      const nl = scan.indexOf('\n', i);
      if (nl === -1) break;
      i = nl;
      continue;
    }

    out += ch;
    i += 1;
  }

  return out;
}

// Global git flags that consume the token after them. `git -C /repo commit`
// is a commit; a regex that skips only `-\S+` reads `/repo` as the subcommand
// and lets the whole thing through ungraded.
const GIT_FLAGS_WITH_VALUE = new Set([
  '-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env',
]);

/**
 * Is this shell shape a `git commit` invocation? Walks tokens rather than
 * pattern-matching the string, so global flags and their values are skipped
 * without guessing at their spelling.
 */
function isGitCommit(shape) {
  const tokens = shape.split(/[\s;|&()]+/).filter(Boolean);

  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i] !== 'git' && !tokens[i].endsWith('/git')) continue;

    let j = i + 1;
    while (j < tokens.length && tokens[j].startsWith('-')) {
      const flag = tokens[j].split('=')[0];
      j += GIT_FLAGS_WITH_VALUE.has(flag) && !tokens[j].includes('=') ? 2 : 1;
    }
    if (tokens[j] === 'commit') return true;
  }

  return false;
}

function extractMessage(command) {
  if (!command) return { msg: null, form: 'empty' };

  const { heredoc: heredocAny, scan } = stripHeredoc(command);

  const shortFlag = scan.match(/(?:^|\s)-m\s+(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|(\S+))/);
  if (shortFlag) {
    const raw = shortFlag[1] || shortFlag[2] || shortFlag[3] || '';
    return { msg: raw.replace(/\\"/g, '"').replace(/\\'/g, "'"), form: '-m' };
  }

  const longFlag = scan.match(/--message(?:=|\s+)(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|(\S+))/);
  if (longFlag) {
    const raw = longFlag[1] || longFlag[2] || longFlag[3] || '';
    return { msg: raw.replace(/\\"/g, '"').replace(/\\'/g, "'"), form: '--message' };
  }

  if (heredocAny) return { msg: heredocAny[2].split('\n')[0], form: 'heredoc' };

  if (/(?:^|\s)-F(?:\s+\S+|=\S+)/.test(scan) || /--file(?:=|\s+)\S+/.test(scan)) {
    return { msg: null, form: 'file' };
  }

  if (isGitCommit(shellShape(command))) {
    const afterCommit = scan.split(/\bcommit\b/)[1] || '';
    const hasExplicitFlag = /(?:-m|--message|-F|--file|--amend)\b/.test(afterCommit);
    if (!hasExplicitFlag) return { msg: null, form: 'editor' };
    return { msg: null, form: 'unknown' };
  }

  return { msg: null, form: 'empty' };
}

function validate(msg) {
  const firstLine = msg.split('\n')[0].trim();
  if (!PATTERN.test(firstLine)) {
    return { ok: false, reason: `Commit message must follow conventional commits: <type>(<scope>): <summary>. Valid types: ${TYPES.join(', ')}.` };
  }
  const summary = firstLine.split(':').slice(1).join(':').trim();
  if (summary.length > MAX_SUMMARY) {
    return { ok: false, reason: `Commit summary is ${summary.length} chars, must be <= ${MAX_SUMMARY}.` };
  }
  return { ok: true };
}

(async () => {
  const raw = await readStdin();
  let input = {};
  try { input = JSON.parse(raw); } catch {}
  const command = input?.tool_input?.command || '';
  // Only grade actual commits. extractMessage() matches heredocs and -m before
  // it checks for `git commit`, so without this gate a plain `cat > f <<'EOF'`
  // or `python3 -m pip install x` is parsed as a commit message and rejected.
  // The gate reads the command's shell SHAPE, not its text: `git commit` sitting
  // in a heredoc body, a quoted argument or a comment is data, not a commit.
  if (!isGitCommit(shellShape(command))) process.exit(0);
  const { msg, form } = extractMessage(command);

  if (msg === null) {
    if (form === 'file' || form === 'editor') process.exit(0);
    if (form === 'unknown') {
      console.error(`[pro-workflow] commit-validate: could not parse commit message from command; skipping validation. Review before pushing.`);
      process.exit(0);
    }
    process.exit(0);
  }

  const result = validate(msg);
  if (result.ok) process.exit(0);
  console.error(`[pro-workflow] commit-validate: ${result.reason}`);
  process.exit(2);
})();
