#!/usr/bin/env node
/**
 * Post web text editor stories to TaskBoard API.
 * Usage: node scripts/post-editor-stories.js [baseUrl]
 * Default baseUrl: http://192.168.1.182:5173
 */

const fs = require('fs');
const path = require('path');

const BASE_URL = process.argv[2] || 'http://192.168.1.182:5173';
const TOKEN = process.env.TASKBOARD_TOKEN || 'dev-token';
const REPO = 'factory-testing';

// Story index -> array of dependency story indices (0-based)
const DEPS = {
  0: [],           // T-ED-1
  1: [0],          // T-ED-2 <- T-ED-1
  2: [1],          // T-ED-3 <- T-ED-2
  3: [1],          // T-ED-4 <- T-ED-2
  4: [1, 2, 3],    // T-ED-5 <- T-ED-2, T-ED-3, T-ED-4
  5: [2, 4],       // T-ED-6 <- T-ED-3, T-ED-5
  6: [4],          // T-ED-7 <- T-ED-5
  7: [1],          // T-ED-8 <- T-ED-2
  8: [2],          // T-ED-9 <- T-ED-3
  9: [4, 6],       // T-ED-10 <- T-ED-5, T-ED-7
};

function request(method, pathname, body = null) {
  const url = `${BASE_URL}${pathname}`;
  const { spawnSync } = require('child_process');
  const args = [
    '-s', '-w', '\n%{http_code}',
    '-X', method,
    '-H', `Authorization: Bearer ${TOKEN}`,
    '-H', 'Content-Type: application/json',
    ...(body ? ['-d', JSON.stringify(body)] : []),
    url,
  ];
  const r = spawnSync('curl', args, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  if (r.error) throw r.error;
  const out = (r.stdout || '').trimEnd();
  const parts = out.split('\n');
  const code = parts.pop();
  const text = parts.join('\n');
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (_) {}
  const status = parseInt(code, 10);
  if (status < 200 || status >= 300) {
    throw new Error(`${method} ${url} → ${status}: ${text}`);
  }
  return data;
}

function main() {
  const storiesPath = path.join(__dirname, '..', 'docs', 'samples', 'stories-web-text-editor.json');
  const raw = fs.readFileSync(storiesPath, 'utf8');
  const stories = JSON.parse(raw);

  if (stories.length !== 10) {
    throw new Error(`Expected 10 stories, got ${stories.length}`);
  }

  const createdIds = [];

  for (let i = 0; i < stories.length; i++) {
    const s = stories[i];
    const body = {
      title: s.title,
      status: s.status || 'Backlog',
      priority: s.priority,
      repo: REPO,
      labels: s.labels || [],
      description: s.description || '',
      acceptance_criteria: s.acceptance_criteria || [],
      test_plan: s.test_plan || '',
    };
    const ticket = request('POST', '/tickets', body);
    createdIds.push(ticket.id);
    console.log(`Created ${ticket.id}: ${s.title.substring(0, 50)}...`);
  }

  for (let i = 0; i < stories.length; i++) {
    const depIndices = DEPS[i];
    if (!depIndices || depIndices.length === 0) continue;
    const id = createdIds[i];
    const blockedBy = depIndices.map((j) => createdIds[j]);
    request('PUT', `/tickets/${id}/deps`, { blocked_by: blockedBy });
    console.log(`${id} blocked_by [${blockedBy.join(', ')}]`);
  }

  console.log('\nDone. Created tickets:', createdIds.join(', '));
}

try {
  main();
} catch (err) {
  console.error(err);
  process.exit(1);
}
