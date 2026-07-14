/**
 * End-to-end usage fetch test.
 * Imports the actual TypeScript functions (compiled to out/).
 *
 * Run with: node scripts/test-usage.mjs
 * Requires: AUTH_COOKIE env var, or paste when prompted.
 */

import { createInterface } from 'node:readline';
import { normalizeCookie, discoverGoWorkspace } from '../out/authCookie.js';
import { fetchGoUsage, formatGoUsage } from '../out/usageFetcher.js';

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

async function main() {
    console.log('═══════════════════════════════════════════');
    console.log('  Go Usage Fetch Test');
    console.log('═══════════════════════════════════════════\n');

    const rawCookie = await promptForCookie();
    if (!rawCookie) { console.error('✗ No cookie.'); process.exit(1); }

    const cookie = normalizeCookie(rawCookie);
    if (!cookie) { console.error('✗ Invalid cookie.'); process.exit(1); }

    // Phase 1: Discover workspace
    console.log('[Phase 1] Discover workspace\n');
    const discover = await discoverGoWorkspace(cookie);
    if (!discover) {
        console.error('✗ Cookie rejected or no workspace found.');
        process.exit(1);
    }

    const { workspace, hasGo } = discover;
    console.log(`  → Selected: "${workspace.name}" (${workspace.id}), Go: ${hasGo}\n`);

    if (!hasGo) {
        console.log('✗ This workspace does not have Go subscription.');
        process.exit(1);
    }

    // Phase 2: Fetch usage
    console.log('[Phase 2] Fetch usage data\n');
    const usage = await fetchGoUsage(cookie, workspace.id);

    // Phase 3: Display result
    console.log('[Phase 3] Result\n');
    console.log(formatGoUsage(usage));
}

main().catch(err => {
    if (err.message === 'cookie-rejected') {
        console.error('\n✗ Cookie rejected (HTTP 401/403). The auth cookie is invalid or expired.');
    } else {
        console.error(`\n✗ Error: ${err.message}`);
    }
    process.exit(1);
});
