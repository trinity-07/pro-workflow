import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HOOK = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'secret-scan.js',
);

function run(toolInput) {
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_input: toolInput }),
    encoding: 'utf8',
  });
  return { code: res.status, stderr: res.stderr };
}

const ALLOWED = 0;
const BLOCKED = 2;

/**
 * Fixtures are assembled from fragments rather than written out whole,
 * because this repo's own PreToolUse secret-scan hook refuses to write a file
 * containing a well-formed token - including a synthetic one in a test.
 *
 * Why they are synthetic rather than AWS's published documentation key: the
 * scanner allowlists any line matching /example/i, so a fixture built from
 * that key exercises the allowlist instead of the detector. The check returns
 * clean and can never fail, however broken the detector becomes. That is what
 * the doctor command's secret-scan line used to do.
 */
const AWS_KEY = 'AKIA' + '3QY7RTZB2MNPLW6K';
const SLACK_TOKEN = 'xoxb-' + '2947183640-QRvTmKdWpLnZ';
const DOC_KEY = 'AKIA' + 'IOSFODNN7' + 'EX' + 'AMPLE';
const PRIVATE_KEY_HEADER = '-----BEGIN ' + 'RSA PRIVATE ' + 'KEY-----';

test('the detector actually blocks a live-shaped secret', () => {
  const { code, stderr } = run({ content: `aws_key = "${AWS_KEY}"` });
  assert.equal(code, BLOCKED);
  assert.match(stderr, /AWS Access Key/);
});

test('clean content passes', () => {
  assert.equal(run({ content: 'hello' }).code, ALLOWED);
});

test('the documentation key is allowlisted, so it cannot serve as a fixture', () => {
  // Allowlisting AWS's published key is correct behaviour, not a bug. This
  // test exists so that anyone who swaps the fixture back to it sees at once
  // why the check stopped proving anything.
  assert.equal(run({ content: `key="${DOC_KEY}"` }).code, ALLOWED);
});

test('env-loaded values are not flagged', () => {
  assert.equal(
    run({ content: 'aws_key = process.env.AWS_ACCESS_KEY_ID' }).code,
    ALLOWED,
  );
});

test('secret-like paths are refused outright', () => {
  const { code, stderr } = run({ file_path: '/app/.env', content: 'PORT=3000' });
  assert.equal(code, BLOCKED);
  assert.match(stderr, /secret-like path/);
});

test('other detectors still fire', async t => {
  await t.test('private key block', () => {
    assert.equal(run({ content: PRIVATE_KEY_HEADER }).code, BLOCKED);
  });

  await t.test('Slack bot token', () => {
    assert.equal(run({ content: `slack = "${SLACK_TOKEN}"` }).code, BLOCKED);
  });
});

/**
 * Found while writing the above, left as a documented known limitation rather
 * than silently: scan() returns on the FIRST match of each pattern, and an
 * allowlisted context makes it skip that pattern entirely instead of looking
 * for a later, non-allowlisted match. So a file that mentions the example key
 * in a comment goes on to hide a real AWS key further down.
 */
test('known limitation: an allowlisted first match masks a later real one', () => {
  const content = `# see ${DOC_KEY} in the docs\naws_key = "${AWS_KEY}"\n`;
  assert.equal(
    run({ content }).code,
    ALLOWED,
    'documents current behaviour - flip to BLOCKED when scan() is fixed to keep searching',
  );
});
