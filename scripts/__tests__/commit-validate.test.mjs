import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HOOK = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'commit-validate.js',
);

/**
 * Run the hook the way Claude Code runs it: a PreToolUse payload on stdin.
 * Exit 2 means "blocked"; exit 0 means "allowed through".
 */
function run(command) {
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_input: { command } }),
    encoding: 'utf8',
  });
  return { code: res.status, stderr: res.stderr };
}

const ALLOWED = 0;
const BLOCKED = 2;

/**
 * The invariant, stated once so it does not have to be rediscovered a fourth
 * time: this hook grades commit MESSAGES, and the only thing that decides
 * whether a Bash command is a commit at all is the command's shell shape --
 * the unquoted, uncommented, heredoc-free text. Everything else in the
 * command string is data the user is writing, printing, searching for or
 * commenting out. Data is never graded.
 *
 * Each case below is one container in which commit-like text can sit without
 * being a commit. Three of them shipped as bugs before anyone named the class.
 */
test('text that merely mentions a commit is never graded', async t => {
  await t.test('echoed commit invocation', () => {
    const { code } = run(`echo "git commit -m 'wip'"`);
    assert.equal(code, ALLOWED);
  });

  await t.test('commit invocation as a quoted argument to another tool', () => {
    const { code } = run(`rg 'git commit -m wip' docs/`);
    assert.equal(code, ALLOWED);
  });

  await t.test('commit invocation inside a double-quoted argument', () => {
    const { code } = run(`python3 -c "print('git commit -m wip')"`);
    assert.equal(code, ALLOWED);
  });

  await t.test('commented-out commit invocation', () => {
    const { code } = run(`ls -la # git commit -m wip`);
    assert.equal(code, ALLOWED);
  });

  await t.test('whole-line comment', () => {
    const { code } = run(`# git commit -m wip\nls -la`);
    assert.equal(code, ALLOWED);
  });

  await t.test('heredoc body quoting a commit invocation', () => {
    const { code } = run(
      `cat > notes.md <<'EOF'\nRun git commit -m "wip" when done.\nEOF`,
    );
    assert.equal(code, ALLOWED);
  });
});

test('real commits are still graded', async t => {
  await t.test('non-conventional short flag is blocked', () => {
    const { code, stderr } = run(`git commit -m "wip"`);
    assert.equal(code, BLOCKED);
    assert.match(stderr, /conventional commits/);
  });

  await t.test('conventional short flag passes', () => {
    const { code } = run(`git commit -m "fix(hook): stop grading quoted text"`);
    assert.equal(code, ALLOWED);
  });

  await t.test('non-conventional long flag is blocked', () => {
    const { code } = run(`git commit --message="wip"`);
    assert.equal(code, BLOCKED);
  });

  await t.test('over-length summary is blocked', () => {
    const summary = 'x'.repeat(73);
    const { code, stderr } = run(`git commit -m "fix: ${summary}"`);
    assert.equal(code, BLOCKED);
    assert.match(stderr, /73 chars/);
  });

  await t.test('a real commit whose message quotes a commit invocation', () => {
    const { code } = run(
      `git commit -m "docs(hook): explain why 'git commit -m x' in prose is not a commit"`,
    );
    assert.equal(code, ALLOWED);
  });

  await t.test('a real commit with a trailing comment is still graded', () => {
    const { code } = run(`git commit -m "wip" # cleanup later`);
    assert.equal(code, BLOCKED);
  });

  await t.test('git -C <path> commit is still recognised', () => {
    const { code } = run(`git -C /tmp/repo commit -m "wip"`);
    assert.equal(code, BLOCKED);
  });

  await t.test('a commit whose message arrives on stdin is graded on the heredoc', () => {
    // `-F -` means the heredoc IS the message, so it is graded like any other.
    assert.equal(run(`git commit -F - <<'EOF'\nwip\nEOF`).code, BLOCKED);
    assert.equal(
      run(`git commit -F - <<'EOF'\nfix(hook): grade shape, not text\nEOF`).code,
      ALLOWED,
    );
  });

  await t.test('a commit reading its message from a real file is deferred to', () => {
    assert.equal(run(`git commit -F .git/COMMIT_EDITMSG`).code, ALLOWED);
  });
});

test('non-commit Bash is never touched', async t => {
  await t.test('plain command', () => {
    assert.equal(run(`npm test`).code, ALLOWED);
  });

  await t.test('python3 -m, which once parsed as a -m message', () => {
    assert.equal(run(`python3 -m pip install requests`).code, ALLOWED);
  });

  await t.test('empty command', () => {
    assert.equal(run(``).code, ALLOWED);
  });
});
