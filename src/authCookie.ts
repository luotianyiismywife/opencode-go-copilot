import * as vscode from "vscode";

// ── Types ──

export interface WorkspaceRef {
    id: string;   // wrk_xxx
    name: string; // e.g. "Default", "123"
    slug: string | null;
}

export interface StoredKey {
    id: string;   // key_xxx
    name: string;
    key: string;  // sk-... (full value)
}

// ── Constants ──

const OPEnCODE_BASE = "https://opencode.ai";
const CREATE_KEY_NAME = "Vscode_Copilot_Key";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

/**
 * Stable _server ID hashes determined by inspecting opencode.ai pages.
 */
const KEY_SERVER_ID = "444825072757feb3b2ec98a3260e2c32488cb05899076c0afb36b9eb5142bc62";

const SECRET_COOKIE_KEY = "opencodego.authCookie";
const SECRET_WORKSPACE_KEY = "opencodego.workspaceId";
const SECRET_WORKSPACE_NAME_KEY = "opencodego.workspaceName";

// ── Cookie Normalization ──

/**
 * Normalize auth cookie input. Accepts:
 *   - Raw "auth=xxx" value
 *   - Full "Cookie: auth=xxx" string
 *   - Just the value "xxx" (will prefix with "auth=")
 */
export function normalizeCookie(cookie: string): string {
    const trimmed = cookie.trim();
    if (!trimmed) return "";

    if (trimmed.toLowerCase().startsWith("cookie:")) {
        return trimmed.slice(7).trim();
    }

    let normalized = trimmed;
    if (/^auth\s*[:=]\s*"?/.test(normalized)) {
        normalized = normalized.replace(/^auth\s*[:=]\s*"?/, "auth=").replace(/"$/, "");
    }

    if (normalized.includes("auth=")) {
        return normalized;
    }

    if (normalized.includes("=")) {
        return normalized;
    }

    return `auth=${normalized}`;
}

// ── SSR Data Parsing ──

/** Regex to match workspace refs in SSR data. */
const WS_SSR_RE = /\{id:"(wrk_[^"]+)",name:"([^"]*)",slug:([^}]+)\}/g;

/** Regex to match API key entries in SSR data. */
const KEY_SSR_RE = /\{id:"(key_[^"]+)",name:"([^"]*)",key:"(sk-[A-Za-z0-9]+)"/g;

/** Regex to extract workspace ID from /zh/go page SSR. */
const CHECK_LOGGED_IN_RE = /\$R\[\d+\]\(\$R\[\d+\],"(wrk_[A-Za-z0-9]+)"/;

/**
 * Extract workspace refs from SSR data embedded in page HTML.
 */
function extractSsrWorkspaceRefs(html: string): WorkspaceRef[] {
    const refs: WorkspaceRef[] = [];
    let match: RegExpExecArray | null;
    while ((match = WS_SSR_RE.exec(html)) !== null) {
        refs.push({
            id: match[1],
            name: match[2],
            slug: match[3] === "null" ? null : match[3],
        });
    }
    return refs;
}

/**
 * Extract API key entries from SSR data embedded in page HTML.
 */
function extractSsrKeys(html: string): StoredKey[] {
    const keys: StoredKey[] = [];
    let match: RegExpExecArray | null;
    while ((match = KEY_SSR_RE.exec(html)) !== null) {
        keys.push({ id: match[1], name: match[2], key: match[3] });
    }
    return keys;
}

// ── HTTP Helpers ──

async function fetchText(url: string, cookie: string): Promise<string> {
    const resp = await fetch(url, {
        headers: {
            Cookie: cookie,
            "User-Agent": USER_AGENT,
            Accept: "text/html, application/xhtml+xml, application/javascript",
        },
    });
    if (resp.status === 401 || resp.status === 403) {
        throw new Error("cookie-rejected");
    }
    if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}`);
    }
    return resp.text();
}

// ── Discovery Flow ──

/**
 * Step 1: Fetch /zh/go and extract a workspace ID from SSR.
 * The checkLoggedIn.get[] SSR data contains the user's current workspace ID.
 */
async function getWorkspaceIdFromGoPage(cookie: string): Promise<string | undefined> {
    const html = await fetchText(`${OPEnCODE_BASE}/zh/go`, cookie);
    const match = CHECK_LOGGED_IN_RE.exec(html);
    return match?.[1];
}

/**
 * Step 2: Fetch a workspace's /go page to get the full workspace list from SSR.
 */
async function fetchWorkspaceRefs(cookie: string, workspaceId: string): Promise<WorkspaceRef[]> {
    const html = await fetchText(
        `${OPEnCODE_BASE}/workspace/${encodeURIComponent(workspaceId)}/go`,
        cookie,
    );
    return extractSsrWorkspaceRefs(html);
}

/**
 * Check whether a workspace has an active Go subscription.
 */
async function checkGoSubscription(cookie: string, workspaceId: string): Promise<boolean> {
    try {
        const html = await fetchText(
            `${OPEnCODE_BASE}/workspace/${encodeURIComponent(workspaceId)}/go`,
            cookie,
        );
        return /rollingUsage/.test(html);
    } catch {
        return false;
    }
}

/**
 * Auto-discover workspace with Go subscription.
 *
 * Flow:
 *   1. GET /zh/go → extract workspace ID (checkLoggedIn SSR)
 *   2. GET /workspace/{wsId}/go → extract full workspace list
 *   3. Check each workspace for active Go subscription
 *   4. Return first one with Go; if none has Go, return first workspace
 *
 * Returns { workspace, hasGo } or undefined if cookie is invalid.
 */
export interface DiscoverResult {
    workspace: WorkspaceRef;
    hasGo: boolean;
}

export async function discoverGoWorkspace(cookie: string): Promise<DiscoverResult | undefined> {
    try {
        // Step 1: Get initial workspace ID from /zh/go
        const initialWsId = await getWorkspaceIdFromGoPage(cookie);
        if (!initialWsId) return undefined;

        // Step 2: Get full workspace list
        const refs = await fetchWorkspaceRefs(cookie, initialWsId);
        if (refs.length === 0) return undefined;

        // Step 3: Check each workspace for Go subscription
        for (const ws of refs) {
            const hasGo = await checkGoSubscription(cookie, ws.id);
            if (hasGo) {
                return { workspace: ws, hasGo: true };
            }
        }

        // Step 4: No workspace has Go — return the first one
        return { workspace: refs[0], hasGo: false };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message === "cookie-rejected") {
            return undefined; // caller distinguishes by undefined return
        }
        throw err;
    }
}

// ── API Key Management ──

/**
 * Fetch all API keys for a workspace from the keys page SSR data.
 */
export async function fetchKeysPage(cookie: string, workspaceId: string): Promise<StoredKey[]> {
    const html = await fetchText(
        `${OPEnCODE_BASE}/workspace/${encodeURIComponent(workspaceId)}/keys`,
        cookie,
    );
    return extractSsrKeys(html);
}

/**
 * Create a new API key in the specified workspace.
 * POST to _server → follow 302 → parse key from final page SSR.
 */
export async function createApiKey(
    cookie: string,
    workspaceId: string,
    keyName: string = CREATE_KEY_NAME,
): Promise<string | undefined> {
    const createUrl = `${OPEnCODE_BASE}/_server?id=${KEY_SERVER_ID}`;
    const body = new URLSearchParams({ name: keyName, workspaceID: workspaceId });

    const resp = await fetch(createUrl, {
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Cookie: cookie,
            "User-Agent": USER_AGENT,
        },
        body: body.toString(),
        redirect: "follow",
    });

    if (!resp.ok) return undefined;

    const finalHtml = await resp.text();
    const keys = extractSsrKeys(finalHtml);
    return keys.find((k) => k.name === keyName)?.key;
}

/**
 * Find existing key by name, or create one if not found.
 * Falls back to first available key if name not found.
 * Returns { key, created } indicating whether the key was newly created.
 */
export async function fetchOrCreateApiKey(
    cookie: string,
    workspaceId: string,
    keyName: string = CREATE_KEY_NAME,
): Promise<{ key: string; created: boolean } | undefined> {
    const keys = await fetchKeysPage(cookie, workspaceId);

    const existing = keys.find((k) => k.name === keyName);
    if (existing) return { key: existing.key, created: false };

    if (keys.length > 0) return { key: keys[0].key, created: false };

    const newKey = await createApiKey(cookie, workspaceId, keyName);
    return newKey ? { key: newKey, created: true } : undefined;
}

// ── SecretStorage Helpers ──

export async function getStoredAuthCookie(secrets: vscode.SecretStorage): Promise<string | undefined> {
    const cookie = await secrets.get(SECRET_COOKIE_KEY);
    return cookie?.trim() || undefined;
}

export async function storeAuthCookie(secrets: vscode.SecretStorage, cookie: string): Promise<void> {
    await secrets.store(SECRET_COOKIE_KEY, normalizeCookie(cookie));
}

export async function deleteAuthCookie(secrets: vscode.SecretStorage): Promise<void> {
    await secrets.delete(SECRET_COOKIE_KEY);
}

// ── Workspace ID Storage ──

export async function getStoredWorkspaceId(secrets: vscode.SecretStorage): Promise<string | undefined> {
    return (await secrets.get(SECRET_WORKSPACE_KEY)) || undefined;
}

export async function storeWorkspaceId(secrets: vscode.SecretStorage, workspaceId: string): Promise<void> {
    await secrets.store(SECRET_WORKSPACE_KEY, workspaceId);
}

export async function deleteWorkspaceId(secrets: vscode.SecretStorage): Promise<void> {
    await secrets.delete(SECRET_WORKSPACE_KEY);
}

export async function getStoredWorkspaceName(secrets: vscode.SecretStorage): Promise<string | undefined> {
    return (await secrets.get(SECRET_WORKSPACE_NAME_KEY)) || undefined;
}

export async function storeWorkspaceName(secrets: vscode.SecretStorage, name: string): Promise<void> {
    await secrets.store(SECRET_WORKSPACE_NAME_KEY, name);
}

export async function deleteWorkspaceName(secrets: vscode.SecretStorage): Promise<void> {
    await secrets.delete(SECRET_WORKSPACE_NAME_KEY);
}
