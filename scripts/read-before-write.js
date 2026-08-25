#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const os = require('os');

function getTempDir() {
  return path.join(os.tmpdir(), 'pro-workflow');
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

async function main() {
  let input = '';
  try {
    input = fs.readFileSync(0, 'utf8');
  } catch (e) {
    process.exit(0);
  }

  let parsed;
  try {
    parsed = JSON.parse(input);
  } catch (e) {
    process.exit(0);
  }

  // The hook payload's session_id is the only id stable across a session. process.ppid
  // is a fresh shim process on every hook invocation, so the Read that records a file
  // and the Write that checks for it would never share a tracking file.
  const rawSessionId = parsed.session_id || process.env.CLAUDE_SESSION_ID || 'default';
  // Sanitize sessionId to prevent path traversal
  const sessionId = String(rawSessionId).replace(/[^a-zA-Z0-9_-]/g, '') || 'default';
  const tempDir = getTempDir();
  ensureDir(tempDir);

  const readTrackFile = path.join(tempDir, `reads-${sessionId}.json`);

  const tool = parsed.tool_name || parsed.tool || '';
  const toolInput = parsed.tool_input || {};

  let readFiles = {};
  if (fs.existsSync(readTrackFile)) {
    try {
      readFiles = JSON.parse(fs.readFileSync(readTrackFile, 'utf8'));
    } catch (e) {
      readFiles = {};
    }
  }

  if (tool === 'Read') {
    const filePath = toolInput.file_path || '';
    if (filePath) {
      const normalizedPath = path.resolve(filePath);
      readFiles[normalizedPath] = Date.now();
      fs.writeFileSync(readTrackFile, JSON.stringify(readFiles));
    }
    process.exit(0);
  }

  if (tool === 'Write' || tool === 'Edit') {
    const filePath = toolInput.file_path || '';
    if (!filePath) {
      process.exit(0);
    }

    if (tool === 'Write' && !fs.existsSync(filePath)) {
      process.exit(0);
    }

    const normalizedPath = path.resolve(filePath);
    if (!readFiles[normalizedPath]) {
      console.error(`[TokenEfficiency] Warning: ${tool} on ${path.basename(filePath)} without reading it first. Read the file before modifying.`);
    }
  }

  process.exit(0);
}

main().catch(() => process.exit(0));