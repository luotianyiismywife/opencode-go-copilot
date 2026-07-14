import { normalizeCookie } from "./authCookie";
import { logger } from "./logger";

// ── Types ──

export interface UsageWindow {
    status: "ok" | "rate-limited";
    usagePercent: number;
    resetInSec: number;
}

export interface GoUsage {
    rollingUsage: UsageWindow;
    weeklyUsage: UsageWindow;
    monthlyUsage: UsageWindow;
    fetchedAt: string;
    workspaceId: string;
}

export interface WorkspaceRef {
    id: string;   // wrk_xxx
    name: string;
    slug: string | null;
}

// ── Constants ──

const DASHBOARD_BASE = "https://opencode.ai/workspace";
const WORKSPACE_SERVER_ID = "def39973159c7f0483d8793a822b8dbb10d067e12c65455fcb4608459ba0234f";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

// ── Regex ──

/** Regex to extract usage windows from SSR data in the /go page HTML. */
const RE_USAGE_WINDOW = /(rollingUsage|weeklyUsage|monthlyUsage):\$R\[\d+\]=\{status:"([^"]+)",resetInSec:(\d+),usagePercent:([\d.]+)\}/g;

/** Regex to extract workspace refs from SSR data. */
const RE_WORKSPACE_REFS = /\{id:"(wrk_[^"]+)",name:"([^"]*)",slug:([^}]+)\}/g;

// ── HTTP Helper ──

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
    if (resp.status === 404) {
        throw new Error(`Workspace not found (HTTP 404): ${url}`);
    }
    if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}: ${url}`);
    }
    return resp.text();
}

// ── Public API ──

/**
 * Fetch usage data for a specific workspace from the dashboard SSR page.
 * Requires a valid auth cookie.
 */
export async function fetchGoUsage(authCookie: string, workspaceId: string): Promise<GoUsage> {
    const cookie = normalizeCookie(authCookie);
    if (!cookie) {
        throw new Error("Auth cookie is empty.");
    }

    const url = `${DASHBOARD_BASE}/${encodeURIComponent(workspaceId)}/go`;
    logger.info("usage.fetch", { url, workspaceId });

    const html = await fetchText(url, cookie);
    return parseGoUsageHtml(html, workspaceId);
}

/**
 * Fetch workspace refs from the _server endpoint.
 */
export async function fetchWorkspaceRefs(authCookie: string): Promise<WorkspaceRef[]> {
    const cookie = normalizeCookie(authCookie);
    if (!cookie) {
        throw new Error("Auth cookie is empty.");
    }

    const url = `https://opencode.ai/_server?id=${encodeURIComponent(WORKSPACE_SERVER_ID)}`;
    logger.info("usage.fetchWorkspaceRefs", { url });

    const html = await fetchText(url, cookie);
    return parseWorkspaceRefs(html);
}

// ── Parsing ──

function parseGoUsageHtml(html: string, workspaceId: string): GoUsage {
    const windows: Record<string, UsageWindow> = {};

    RE_USAGE_WINDOW.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = RE_USAGE_WINDOW.exec(html)) !== null) {
        const key = match[1] as "rollingUsage" | "weeklyUsage" | "monthlyUsage";
        const status = match[2] as "ok" | "rate-limited";
        const resetInSec = parseInt(match[3], 10);
        const usagePercent = parseFloat(match[4]);
        windows[key] = { status, resetInSec, usagePercent };
    }

    if (!windows.rollingUsage && !windows.weeklyUsage && !windows.monthlyUsage) {
        throw new Error(
            "Could not find usage data in the dashboard page. " +
            "This may mean the auth cookie is invalid or expired."
        );
    }

    return {
        rollingUsage: windows.rollingUsage ?? { status: "ok", resetInSec: 0, usagePercent: 0 },
        weeklyUsage: windows.weeklyUsage ?? { status: "ok", resetInSec: 0, usagePercent: 0 },
        monthlyUsage: windows.monthlyUsage ?? { status: "ok", resetInSec: 0, usagePercent: 0 },
        fetchedAt: new Date().toISOString(),
        workspaceId,
    };
}

function parseWorkspaceRefs(text: string): WorkspaceRef[] {
    const refs: WorkspaceRef[] = [];

    RE_WORKSPACE_REFS.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = RE_WORKSPACE_REFS.exec(text)) !== null) {
        refs.push({
            id: match[1],
            name: match[2],
            slug: match[3] === "null" ? null : match[3],
        });
    }

    return refs;
}

// ── Formatting (for display) ──

export function formatResetTime(seconds: number): string {
    if (seconds <= 0) return "now";
    const days = Math.floor(seconds / 86400);
    if (days >= 1) {
        const hours = Math.floor((seconds % 86400) / 3600);
        return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
    }
    const hours = Math.floor(seconds / 3600);
    if (hours >= 1) {
        const minutes = Math.floor((seconds % 3600) / 60);
        return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
    }
    const minutes = Math.max(1, Math.ceil(seconds / 60));
    return `${minutes}m`;
}

/**
 * Format full usage info into a multi-line string (for tooltip/notification).
 */
export function formatGoUsage(usage: GoUsage): string {
    const lines: string[] = [];
    lines.push("─".repeat(50));
    lines.push(`  OpenCode Go Usage  (workspace: ${usage.workspaceId})`);
    lines.push(`  Fetched at: ${usage.fetchedAt}`);
    lines.push("─".repeat(50));
    lines.push("");
    lines.push(formatWindow("🔄  5h Rolling", usage.rollingUsage));
    lines.push(formatWindow("📅  Weekly", usage.weeklyUsage));
    lines.push(formatWindow("📆  Monthly", usage.monthlyUsage));
    lines.push("");
    lines.push("─".repeat(50));
    return lines.join("\n");
}

/**
 * Format a single usage window into a concise one-liner.
 */
export function formatWindow(label: string, w: UsageWindow): string {
    const pct = w.usagePercent;
    const bar = buildBar(pct);
    const resetIn = formatResetTime(w.resetInSec);
    const limited = w.status === "rate-limited" ? " ⚠️ LIMITED" : "";
    return `  ${label}:\n    ${bar} ${pct}%${limited}\n    Resets in: ${resetIn}`;
}

/**
 * Build a colored progress bar string.
 */
function buildBar(percent: number, width = 20): string {
    const filled = Math.round((percent / 100) * width);
    const empty = width - filled;
    const color = percent >= 90 ? "🔴" : percent >= 70 ? "🟡" : "🟢";
    return `${color} ${"█".repeat(filled)}${"░".repeat(empty)}`;
}

/**
 * Get a status bar icon based on usage percent.
 */
export function getUsageIcon(percent: number): string {
    if (percent >= 90) return "$(error)";       // 🔴 critical
    if (percent >= 70) return "$(warning)";     // 🟡 warning
    return "$(check)";                           // 🟢 ok
}
