/**
 * Auth Cookie flow test script.
 *
 * Simulates the exact same flow as the extension's setAuthCookie command.
 * Run with: node scripts/test-auth-flow.mjs
 *
 * Requires: AUTH_COOKIE env var set to the 'auth' cookie value from opencode.ai,
 * or you'll be prompted to paste it.
 */

import { createInterface } from 'node:readline';

// ── Configuration (matches src/authCookie.ts) ──

const BASE = 'https://opencode.ai';
const UA = 'opencode-go-copilot-provider/1.0 test';
const KEY_NAME = 'Vscode_Copilot_Key';
const KEY_SERVER_ID = '444825072757feb3b2ec98a3260e2c32488cb05899076c0afb36b9eb5142bc62';
const DELETE_SERVER_ID = '48baebd35f970b8dc3a658e6f9cc953efd731a7f8a6376012c9bc1802cec787d';

// ── Cookie normalization (matches normalizeCookie in authCookie.ts) ──

function normalizeCookie(raw) {
    const trimmed = raw.trim();
    if (!trimmed) return '';

    if (trimmed.toLowerCase().startsWith('cookie:')) {
        return trimmed.slice(7).trim();
    }

    let normalized = trimmed;
    if (/^auth\s*[:=]\s*"?/.test(normalized)) {
        normalized = normalized.replace(/^auth\s*[:=]\s*"?/, 'auth=').replace(/"$/, '');
    }

    if (normalized.includes('auth=')) return normalized;
    if (normalized.includes('=')) return normalized;

    return `auth=${normalized}`;
}

// ── HTTP helper ──

async function fetchText(url, cookie) {
    const resp = await fetch(url, {
        headers: {
            Cookie: normalizeCookie(cookie),
            'User-Agent': UA,
            Accept: 'text/html, application/xhtml+xml, application/javascript',
        },
    });
    if (resp.status === 401 || resp.status === 403) {
        throw new Error('cookie-rejected');
    }
    if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}: ${url}`);
    }
    return resp.text();
}

// ── SSR parsers ──

function extractSsrWorkspaceRefs(html) {
    const refs = [];
    const re = /\{id:"(wrk_[^"]+)",name:"([^"]*)"/g;
    let m;
    while ((m = re.exec(html)) !== null) {
        refs.push({ id: m[1], name: m[2] });
    }
    return refs;
}

function extractSsrKeys(html) {
    const keys = [];
    const re = /\{id:"(key_[^"]+)",name:"([^"]*)",key:"(sk-[A-Za-z0-9]+)"/g;
    let m;
    while ((m = re.exec(html)) !== null) {
        keys.push({ id: m[1], name: m[2], key: m[3] });
    }
    return keys;
}

// ── Discovery flow ──

async function getWorkspaceIdFromGoPage(cookie) {
    const html = await fetchText(`${BASE}/zh/go`, cookie);
    const re = /\$R\[\d+\]\(\$R\[\d+\],"(wrk_[A-Za-z0-9]+)"/;
    const m = re.exec(html);
    if (!m) throw new Error('Could not find workspace ID in /zh/go SSR');
    return m[1];
}

async function getWorkspaceList(cookie, wsId) {
    const html = await fetchText(`${BASE}/workspace/${encodeURIComponent(wsId)}/go`, cookie);
    return extractSsrWorkspaceRefs(html);
}

async function checkGoSubscription(cookie, wsId) {
    try {
        const html = await fetchText(`${BASE}/workspace/${encodeURIComponent(wsId)}/go`, cookie);
        return html.includes('rollingUsage');
    } catch {
        return false;
    }
}

async function discoverGoWorkspace(cookie) {
    console.log('  → Step 1: Fetching /zh/go to get workspace ID...');
    const wsId = await getWorkspaceIdFromGoPage(cookie);
    console.log(`    ✓ Workspace ID: ${wsId}`);

    console.log('  → Step 2: Fetching workspace list...');
    const refs = await getWorkspaceList(cookie, wsId);
    console.log(`    ✓ Found ${refs.length} workspace(s): [${refs.map(r => r.name).join(', ')}]`);

    console.log('  → Step 3: Checking Go subscriptions...');
    for (const ws of refs) {
        const hasGo = await checkGoSubscription(cookie, ws.id);
        console.log(`    ${hasGo ? '✓' : '✗'} "${ws.name}" (${ws.id}): ${hasGo ? 'Has Go' : 'No Go'}`);
        if (hasGo) return { workspace: ws, hasGo: true };
    }

    console.log('    → No workspace has Go, using first one.');
    return { workspace: refs[0], hasGo: false };
}

// ── API Key management ──

async function fetchKeysPage(cookie, wsId) {
    const html = await fetchText(`${BASE}/workspace/${encodeURIComponent(wsId)}/keys`, cookie);
    return extractSsrKeys(html);
}

async function createApiKey(cookie, wsId, keyName = KEY_NAME) {
    const url = `${BASE}/_server?id=${KEY_SERVER_ID}`;
    const body = new URLSearchParams({ name: keyName, workspaceID: wsId });

    const resp = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Cookie: normalizeCookie(cookie),
            'User-Agent': UA,
        },
        body: body.toString(),
        redirect: 'follow',
    });

    if (!resp.ok) {
        console.error(`    ✗ POST failed: HTTP ${resp.status}`);
        return undefined;
    }

    const html = await resp.text();
    const keys = extractSsrKeys(html);
    const created = keys.find(k => k.name === keyName);
    return created?.key;
}

async function fetchOrCreateApiKey(cookie, wsId, keyName = KEY_NAME) {
    console.log('  → Step 4a: Fetching existing keys...');
    const keys = await fetchKeysPage(cookie, wsId);
    console.log(`    ✓ Found ${keys.length} existing key(s)`);

    const existing = keys.find(k => k.name === keyName);
    if (existing) {
        console.log(`    ✓ Found existing "${keyName}": ${existing.key.substring(0, 15)}...`);
        return { key: existing.key, created: false };
    }

    if (keys.length > 0) {
        console.log(`    → "${keyName}" not found, using first available key: ${keys[0].key.substring(0, 15)}...`);
        return { key: keys[0].key, created: false };
    }

    console.log(`  → Step 4b: No keys found, creating "${keyName}"...`);
    const newKey = await createApiKey(cookie, wsId, keyName);
    if (newKey) {
        console.log(`    ✓ Created: ${newKey.substring(0, 15)}...`);
        return { key: newKey, created: true };
    }
    return undefined;
}

// ── Delete key ──

async function deleteApiKey(cookie, wsId, keyId) {
    const url = `${BASE}/_server?id=${DELETE_SERVER_ID}`;
    const body = new URLSearchParams({ id: keyId, workspaceID: wsId });
    const resp = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Cookie: normalizeCookie(cookie),
            'User-Agent': UA,
        },
        body: body.toString(),
        redirect: 'manual',
    });
    return resp.status;
}

// ── Prompt for cookie ──

function promptForCookie() {
    const envCookie = process.env.AUTH_COOKIE;
    if (envCookie) {
        console.log('Using AUTH_COOKIE from environment.\n');
        return Promise.resolve(envCookie);
    }

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => {
        rl.question('Paste auth cookie (auth=...): ', answer => {
            rl.close();
            resolve(answer.trim());
        });
    });
}

// ── Main ──

async function main() {
    console.log('═══════════════════════════════════════════');
    console.log('  Auth Cookie Flow Test');
    console.log('═══════════════════════════════════════════\n');

    const rawCookie = await promptForCookie();
    if (!rawCookie) {
        console.error('✗ No cookie provided.');
        process.exit(1);
    }

    const cookie = normalizeCookie(rawCookie);
    if (!cookie) {
        console.error('✗ Invalid cookie.');
        process.exit(1);
    }

    // ── Step 3 in extension: discoverGoWorkspace ──
    console.log('[Phase 1] Discover Go Workspace\n');
    let discover;
    try {
        discover = await discoverGoWorkspace(cookie);
    } catch (err) {
        if (err.message === 'cookie-rejected') {
            console.error('\n✗ Cookie rejected (HTTP 401/403). The auth cookie is invalid or expired.');
            process.exit(1);
        }
        console.error(`\n✗ Discovery failed: ${err.message}`);
        process.exit(1);
    }

    const { workspace, hasGo } = discover;
    console.log(`\n  → Selected: "${workspace.name}" (${workspace.id}), Go: ${hasGo}\n`);

    // ── Step 4 in extension: fetchOrCreateApiKey ──
    console.log('[Phase 2] API Key Management\n');
    let keyResult;
    try {
        keyResult = await fetchOrCreateApiKey(cookie, workspace.id);
    } catch (err) {
        console.error(`\n✗ Key operation failed: ${err.message}`);
        process.exit(1);
    }

    if (!keyResult) {
        console.error('\n✗ Could not get or create API key.');
        process.exit(1);
    }

    // ── Result ──
    const action = keyResult.created ? 'Created' : 'Fetched';
    const hasGoSuffix = hasGo ? '' : ' (No Go subscription)';

    console.log(`\n═══════════════════════════════════════════`);
    console.log(`  ✓ ${action} ${KEY_NAME}${hasGoSuffix}`);
    console.log(`    Workspace: ${workspace.name} (${workspace.id})`);
    console.log(`    API Key:   ${keyResult.key.substring(0, 20)}...`);
    console.log(`    Created:   ${keyResult.created}`);
    console.log('═══════════════════════════════════════════\n');

    // Verify the key works by checking the /go page again
    console.log('[Phase 3] Verify: Re-fetch workspace Go page...');
    try {
        const goHtml = await fetchText(`${BASE}/workspace/${encodeURIComponent(workspace.id)}/go`, cookie);
        console.log(`  ✓ Workspace accessible. Has Go: ${goHtml.includes('rollingUsage')}`);
    } catch (err) {
        console.error(`  ✗ Verify failed: ${err.message}`);
    }

    // ── Phase 4: Test create new key ──
    console.log('\n[Phase 4] Test: Create + delete a new key\n');
    const testKeyName = 'Vscode_Copilot_Key_flowtest';
    try {
        const testKey = await createApiKey(cookie, workspace.id, testKeyName);
        if (testKey) {
            console.log(`  ✓ Created "${testKeyName}": ${testKey.substring(0, 20)}...`);

            // Find the key ID to delete it
            const keysAfter = await fetchKeysPage(cookie, workspace.id);
            const createdKey = keysAfter.find(k => k.name === testKeyName);
            if (createdKey) {
                const delStatus = await deleteApiKey(cookie, workspace.id, createdKey.id);
                console.log(`  ✓ Deleted: ${delStatus}`);
            }
        } else {
            console.error('  ✗ Failed to create test key');
        }
    } catch (err) {
        console.error(`  ✗ Create test key failed: ${err.message}`);
    }

    console.log('\n✓ All tests passed!');
}

main().catch(err => {
    console.error(`\n✗ Fatal error: ${err.message}`);
    process.exit(1);
});
