#!/usr/bin/env bash
# Load stories from a JSON file into the TaskBoard and wire up dependencies.
#
# Usage:
#   ./scripts/load-stories.sh <stories.json>
#
# Environment:
#   TASKBOARD_URL   (default: http://localhost:5173)
#   TASKBOARD_TOKEN (default: dev-token)
#   GITEA_OWNER     Gitea username/org to prefix bare repo names (default: gitea)

set -euo pipefail

STORIES_FILE="${1:?Usage: $0 <stories.json>}"
if [ ! -f "$STORIES_FILE" ]; then
  echo "File not found: $STORIES_FILE" >&2
  exit 1
fi

TASKBOARD_URL="${TASKBOARD_URL:-http://localhost:5173}"
TASKBOARD_TOKEN="${TASKBOARD_TOKEN:-dev-token}"
GITEA_OWNER="${GITEA_OWNER:-gitea}"

AUTH="Authorization: Bearer $TASKBOARD_TOKEN"
CT="Content-Type: application/json"

echo "Loading stories from $STORIES_FILE"
echo "  TaskBoard: $TASKBOARD_URL"
echo "  Gitea owner: $GITEA_OWNER"
echo ""

MAPPING_FILE=$(mktemp)
trap 'rm -f "$MAPPING_FILE"' EXIT

# Phase 1: create all tickets, build prefix->id mapping
python3 -c "
import json, sys, subprocess

stories_file = sys.argv[1]
taskboard_url = sys.argv[2]
token = sys.argv[3]
gitea_owner = sys.argv[4]
mapping_file = sys.argv[5]

with open(stories_file) as f:
    stories = json.load(f)

print(f'Found {len(stories)} stories')
print()

mapping = {}  # title_prefix -> ticket_id
ticket_order = []  # [(index, ticket_id, title)]

for i, s in enumerate(stories):
    repo = s.get('repo', '')
    if repo and '/' not in repo:
        s['repo'] = f'{gitea_owner}/{repo}'

    payload = {
        'title': s['title'],
        'status': s.get('status', 'Backlog'),
        'priority': s.get('priority', 0),
        'repo': s.get('repo', ''),
        'labels': s.get('labels', []),
        'acceptance_criteria': s.get('acceptance_criteria', []),
        'test_plan': s.get('test_plan', ''),
        'description': s.get('description', ''),
    }

    import urllib.request
    req = urllib.request.Request(
        f'{taskboard_url}/tickets',
        data=json.dumps(payload).encode(),
        headers={'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'},
        method='POST',
    )
    try:
        with urllib.request.urlopen(req) as resp:
            result = json.loads(resp.read())
    except Exception as e:
        print(f'  FAILED to create: {s[\"title\"]} ({e})')
        ticket_order.append((i, None, s['title']))
        continue

    ticket_id = result.get('id', '')
    if not ticket_id:
        print(f'  FAILED to create: {s[\"title\"]} (no id in response)')
        ticket_order.append((i, None, s['title']))
        continue

    print(f'  Created {ticket_id}: {s[\"title\"]}')
    ticket_order.append((i, ticket_id, s['title']))

    # Extract prefix (e.g. 'T-ED-1' from 'T-ED-1: Project Scaffolding...')
    title = s['title']
    colon_pos = title.find(':')
    prefix = title[:colon_pos].strip() if colon_pos > 0 else title.split()[0] if title else ''
    if prefix:
        mapping[prefix] = ticket_id

# Write mapping for phase 2
with open(mapping_file, 'w') as f:
    json.dump({'mapping': mapping, 'order': [(i, tid, t) for i, tid, t in ticket_order]}, f)

print()
print('Setting up dependencies...')

for i, s in enumerate(stories):
    deps = s.get('depends_on', [])
    if not deps:
        continue

    ticket_id = ticket_order[i][1]
    if not ticket_id:
        continue

    blocked_by = [mapping[d] for d in deps if d in mapping]
    if not blocked_by:
        continue

    dep_payload = json.dumps({'blocked_by': blocked_by}).encode()
    req = urllib.request.Request(
        f'{taskboard_url}/tickets/{ticket_id}/deps',
        data=dep_payload,
        headers={'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'},
        method='PUT',
    )
    try:
        with urllib.request.urlopen(req) as resp:
            resp.read()
        prefix = s['title'][:s['title'].find(':')].strip() if ':' in s['title'] else s['title'][:10]
        dep_prefixes = [d for d in deps if d in mapping]
        print(f'  {prefix} blocked_by {dep_prefixes}')
    except Exception as e:
        print(f'  FAILED to set deps for {ticket_id}: {e}')

print()
print(f'Done. Loaded {sum(1 for _, tid, _ in ticket_order if tid)} stories.')
" "$STORIES_FILE" "$TASKBOARD_URL" "$TASKBOARD_TOKEN" "$GITEA_OWNER" "$MAPPING_FILE"

echo ""
echo "Pick-next:"
curl -s "$TASKBOARD_URL/pick-next" -H "$AUTH" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print('  ticket_id:', d.get('ticket_id'), '| reason:', d.get('reason',''))"
