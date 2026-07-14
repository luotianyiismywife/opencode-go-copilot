import * as vscode from "vscode";
import { OpenCodeGoChatModelProvider } from "./provider";
import { initStatusBar, initUsageStatusBar } from "./statusBar";
import { logger } from "./logger";
import { l10n, l10nFormat } from "./localize";
import type { ModelPreset } from "./types";
import { abortCommitGeneration, generateCommitMsg } from "./gitCommit/commitMessageGenerator";
import { TokenizerManager } from "./tokenizer/tokenizerManager";
import {
    discoverGoWorkspace,
    fetchOrCreateApiKey,
    storeAuthCookie,
    getStoredAuthCookie,
    storeWorkspaceId,
    storeWorkspaceName,
    deleteWorkspaceId,
    deleteWorkspaceName,
} from "./authCookie.js";
import { formatGoUsage } from "./usageFetcher.js";

// ---- Walkthrough / Welcome constants ----

/** memento key tracking whether the welcome walkthrough has been shown. */
const WELCOME_SHOWN_KEY = "opencodego.welcomeShown";

/** Walkthrough contribution ID (publisher.extension#walkthroughId). */
const WALKTHROUGH_ID = "OnesoftQwQ.opencode-go-copilot-provider#opencodeGoGettingStarted";

export function activate(context: vscode.ExtensionContext) {
    // Initialize logger
    logger.init();

    // Initialize TokenizerManager with extension path
    TokenizerManager.initialize(context.extensionPath);

    const tokenCountStatusBarItem: vscode.StatusBarItem = initStatusBar(context);
    const usageStatusBarItem: vscode.StatusBarItem = initUsageStatusBar(context);
    const provider = new OpenCodeGoChatModelProvider(context.secrets, tokenCountStatusBarItem, usageStatusBarItem);

    // Register the OpenCode Go provider under the vendor id used in package.json
    vscode.lm.registerLanguageModelChatProvider("opencodego", provider);

    // Helper: check if an API key is stored (without prompting)
    const hasApiKey = async (): Promise<boolean> => {
        const key = await context.secrets.get("opencodego.apiKey");
        return !!key;
    };

    // Management command to configure API key
    context.subscriptions.push(
        vscode.commands.registerCommand("opencodego.setApiKey", async () => {
            const existing = await context.secrets.get("opencodego.apiKey");
            const apiKey = await vscode.window.showInputBox({
                title: l10n("OpenCode Go Provider API Key"),
                prompt: existing ? l10n("Update your OpenCode Go API key") : l10n("Enter your OpenCode Go API key"),
                ignoreFocusOut: true,
                password: true,
                value: existing ?? "",
            });
            if (apiKey === undefined) {
                return; // user canceled
            }
            if (!apiKey.trim()) {
                await context.secrets.delete("opencodego.apiKey");
                vscode.window.showInformationMessage(l10n("OpenCode Go API key cleared."));
                return;
            }
            await context.secrets.store("opencodego.apiKey", apiKey.trim());
            vscode.window.showInformationMessage(l10n("OpenCode Go API key saved."));
        })
    );

    // Command to open the OpenCode Go website to get an API key
    context.subscriptions.push(
        vscode.commands.registerCommand("opencodego.getApiKey", () => {
            vscode.env.openExternal(vscode.Uri.parse("https://opencode.ai/auth"));
        })
    );

    // Command to open extension settings
    context.subscriptions.push(
        vscode.commands.registerCommand("opencodego.openSettings", () => {
            vscode.commands.executeCommand("workbench.action.openSettings", "@ext:OnesoftQwQ.opencode-go-copilot-provider");
        })
    );

    // Register the generateGitCommitMessage command handler
    context.subscriptions.push(
        vscode.commands.registerCommand("opencodego.generateGitCommitMessage", async (scm) => {
            generateCommitMsg(context.secrets, scm);
        }),
        vscode.commands.registerCommand("opencodego.abortGitCommitMessage", () => {
            abortCommitGeneration();
        })
    );

    // Register the setModelPreset command: user can select a preset via QuickPick
    context.subscriptions.push(
        vscode.commands.registerCommand("opencodego.setModelPreset", async () => {
            const config = vscode.workspace.getConfiguration();
            const presets = config.get<ModelPreset[]>("opencodego.modelPresets", []);
            const currentPresetId = config.get<string>("opencodego.modelPreset", "custom");
            const currentTemp = config.get<number | null>("opencodego.temperature", null);
            const currentTopP = config.get<number | null>("opencodego.top_p", null);

            interface PresetQuickPickItem extends vscode.QuickPickItem {
                presetId?: string;
            }

            // Mark the currently active preset with " (当前)"
            const presetItems: PresetQuickPickItem[] = presets.map((p) => ({
                label: `${l10n(p.label)} (${p.temperature})${p.id === currentPresetId ? l10n(" (current)") : ""}`,
                presetId: p.id,
            }));

            // Mark custom option with current values if active
            const isCustomActive = currentPresetId === "custom";
            const customLabel = "$(pencil) " + l10n("Custom (manual input)")
                + (isCustomActive
                    ? ` ${l10nFormat("(current, temperature: {0}, top_p: {1})", String(currentTemp ?? "—"), String(currentTopP ?? "—"))}`
                    : "");

            const customItem: PresetQuickPickItem = {
                label: customLabel,
            };

            const items: PresetQuickPickItem[] = [
                ...presetItems,
                { label: "", kind: vscode.QuickPickItemKind.Separator },
                customItem,
            ];

            const title = l10n("Set Model Preset");

            const picked = await vscode.window.showQuickPick(items, {
                title,
                placeHolder: l10n("Select a preset"),
                ignoreFocusOut: true,
            });

            if (!picked) {
                return;
            }

            const presetId = picked.presetId;

            if (presetId) {
                // User selected a named preset
                const matchedPreset = presets.find((p) => p.id === presetId);
                if (matchedPreset) {
                    await config.update("opencodego.modelPreset", matchedPreset.id, vscode.ConfigurationTarget.Global);
                    await config.update("opencodego.temperature", matchedPreset.temperature, vscode.ConfigurationTarget.Global);
                    vscode.window.showInformationMessage(
                        l10nFormat("Set to temperature: {0} ({1})", String(matchedPreset.temperature), l10n(matchedPreset.label))
                    );
                }
            } else {
                // User chose "Custom (manual input)"
                const currentVal = currentTemp !== null && currentTopP !== null
                    ? `${currentTemp},${currentTopP}`
                    : "";
                const inputValue = await vscode.window.showInputBox({
                    title: l10n("Enter custom temperature"),
                    prompt: l10n("Enter a single number for temperature only (<=2), or two comma-separated numbers for temperature and top_p (temp<=2, top_p<=1), e.g.: 0.7 or 0.7,0.95"),
                    value: currentVal,
                    validateInput: (val: string) => {
                        const trimmed = val.trim();
                        if (!trimmed) {
                            return l10n("Please enter at least temperature value");
                        }
                        const parts = trimmed.split(",");
                        if (parts.length > 2) {
                            return l10n("Please enter at most two numbers separated by a comma");
                        }
                        const temp = parseFloat(parts[0].trim());
                        if (isNaN(temp) || temp < 0 || temp > 2) {
                            return l10n("Temperature must be between 0.0 and 2.0");
                        }
                        if (parts.length === 2) {
                            const topP = parseFloat(parts[1].trim());
                            if (isNaN(topP) || topP < 0 || topP > 1) {
                                return l10n("top_p must be between 0.0 and 1.0");
                            }
                        }
                        return null;
                    },
                    ignoreFocusOut: true,
                });
                if (inputValue !== undefined) {
                    const trimmed = inputValue.trim();
                    const parts = trimmed.split(",");
                    const tempNum = parseFloat(parts[0].trim());
                    await config.update("opencodego.modelPreset", "custom", vscode.ConfigurationTarget.Global);
                    await config.update("opencodego.temperature", tempNum, vscode.ConfigurationTarget.Global);
                    if (parts.length === 2) {
                        const topPNum = parseFloat(parts[1].trim());
                        await config.update("opencodego.top_p", topPNum, vscode.ConfigurationTarget.Global);
                        vscode.window.showInformationMessage(
                            l10nFormat("Set to temp: {0}, top_p: {1} (custom)", String(tempNum), String(topPNum))
                        );
                    } else {
                        vscode.window.showInformationMessage(
                            l10nFormat("Set to temperature: {0} (custom)", String(tempNum))
                        );
                    }
                }
            }
        })
    );

    // ── Auth Cookie commands ──

    context.subscriptions.push(
        vscode.commands.registerCommand("opencodego.setAuthCookie", async () => {
            const existing = await context.secrets.get("opencodego.authCookie");

            // Step 1: Prompt for cookie
            const rawCookie = await vscode.window.showInputBox({
                title: l10n("OpenCode Go Auth Cookie"),
                prompt: l10n("Paste auth cookie from opencode.ai (F12 → Application → Cookies → auth)"),
                password: true,
                ignoreFocusOut: true,
                value: existing ?? "",
                placeHolder: "auth=...",
            });
            if (rawCookie === undefined) return;
            if (!rawCookie.trim()) {
                await context.secrets.delete("opencodego.authCookie");
                await deleteWorkspaceId(context.secrets);
                await deleteWorkspaceName(context.secrets);
                vscode.window.showInformationMessage(l10n("OpenCode Go auth cookie cleared."));
                return;
            }

            // Step 2: Store cookie
            await storeAuthCookie(context.secrets, rawCookie.trim());
            const cookie = await getStoredAuthCookie(context.secrets);
            if (!cookie) return;

            // Step 3: Discover workspace and fetch/create API key
            const result = await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: l10n("OpenCode Go: Configuring..."),
                    cancellable: false,
                },
                async () => {
                    const discover = await discoverGoWorkspace(cookie);
                    if (!discover) {
                        return { error: "cookie-invalid" as const };
                    }

                    const { workspace, hasGo } = discover;

                    // Step 4: Get or create API key
                    const keyResult = await fetchOrCreateApiKey(cookie, workspace.id);
                    if (!keyResult) {
                        return { error: "key-failed" as const };
                    }

                    // Step 5: Store API key and workspace info
                    await context.secrets.store("opencodego.apiKey", keyResult.key);
                    await storeWorkspaceId(context.secrets, workspace.id);
                    await storeWorkspaceName(context.secrets, workspace.name);

                    return { workspace: workspace.name, hasGo, created: keyResult.created };
                },
            );

            // Step 6: Show result notification
            if ("error" in result) {
                if (result.error === "cookie-invalid") {
                    vscode.window.showErrorMessage(l10n("Auth cookie is invalid or expired. Please check and try again."));
                } else {
                    vscode.window.showErrorMessage(l10n("Failed to create API key. Please set it manually via 'OpenCode Go: Set API Key'."));
                }
            } else {
                const wsName = result.workspace;
                const hasGoMsg = result.hasGo ? "" : l10nFormat(" ({0})", l10n("No Go subscription"));
                const msgKey = result.created ? "Created API key (Vscode_Copilot_Key) in workspace {0}{1}" : "Got API key (Vscode_Copilot_Key) from workspace {0}{1}";
                vscode.window.showInformationMessage(
                    l10nFormat(msgKey, wsName, hasGoMsg),
                );

                // Check if Zen free models are enabled
                const config = vscode.workspace.getConfiguration();
                const zenEnabled = config.get<boolean>("opencodego.enableZenFreeModels", false);
                if (!zenEnabled) {
                    const action = l10n("Enable Zen Free Models");
                    const choice = await vscode.window.showInformationMessage(
                        l10n("💡 Tip: Enable 'opencodego.enableZenFreeModels' to also use free models."),
                        action,
                    );
                    if (choice === action) {
                        await config.update("opencodego.enableZenFreeModels", true, vscode.ConfigurationTarget.Global);
                    }
                }

                // Refresh usage now that we have a cookie + workspace
                void provider.refreshUsage();
            }
        })
    );

    // ── Usage Monitor Commands ──

    context.subscriptions.push(
        vscode.commands.registerCommand("opencodego.showGoUsage", async () => {
            const usage = provider.getLastUsage();
            if (!usage) {
                const cookie = await context.secrets.get("opencodego.authCookie");
                if (!cookie) {
                    vscode.window.showInformationMessage(
                        "No usage data available. Configure an auth cookie first via 'OpenCode Go: Set Auth Cookie'."
                    );
                    return;
                }
                await provider.refreshUsage();
                const freshUsage = provider.getLastUsage();
                if (!freshUsage) {
                    vscode.window.showWarningMessage("Failed to fetch usage data. Check your auth cookie.");
                    return;
                }
                vscode.window.showInformationMessage(
                    formatGoUsage(freshUsage),
                    { modal: false }
                );
                return;
            }
            vscode.window.showInformationMessage(
                formatGoUsage(usage),
                { modal: false }
            );
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand("opencodego.refreshGoUsage", async () => {
            await provider.refreshUsage();
            const usage = provider.getLastUsage();
            if (usage) {
                vscode.window.showInformationMessage(
                    `Usage refreshed: 5h ${usage.rollingUsage.usagePercent}% | Weekly ${usage.weeklyUsage.usagePercent}% | Monthly ${usage.monthlyUsage.usagePercent}%`
                );
            }
        })
    );

    // Start usage monitor (periodic dashboard refresh)
    provider.startUsageMonitor();

    // Listen for config changes to enable/disable usage monitor
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration("opencodego.enableUsageMonitor") ||
                event.affectsConfiguration("opencodego.usageMonitorInterval")) {
                if (vscode.workspace.getConfiguration().get<boolean>("opencodego.enableUsageMonitor", true)) {
                    provider.startUsageMonitor();
                    void provider.refreshUsage();
                } else {
                    provider.stopUsageMonitor();
                    usageStatusBarItem.hide();
                }
            }
        })
    );

    // Dispose usage monitor on deactivate
    context.subscriptions.push({
        dispose: () => provider.disposeUsageMonitor(),
    });

    // Show welcome walkthrough on first install (when no API key is configured)
    showWelcomeIfNeeded(context);

    // Dispose logger on deactivate
    context.subscriptions.push({
        dispose: () => logger.dispose(),
    });
}

/**
 * Show the welcome walkthrough on first activation if no API key is configured.
 * Once shown (or if a key already exists) the flag is persisted so it won't
 * reappear after subsequent reloads.
 */
async function showWelcomeIfNeeded(context: vscode.ExtensionContext): Promise<void> {
    try {
        if (context.globalState.get<boolean>(WELCOME_SHOWN_KEY)) {
            return;
        }
        const apiKey = await context.secrets.get("opencodego.apiKey");
        if (apiKey) {
            // API key already set — no need to show welcome
            await context.globalState.update(WELCOME_SHOWN_KEY, true);
            return;
        }
        await vscode.commands.executeCommand("workbench.action.openWalkthrough", WALKTHROUGH_ID, false);
        await context.globalState.update(WELCOME_SHOWN_KEY, true);
    } catch (error) {
        logger.warn("Failed to show welcome walkthrough", { error: String(error) });
    }
}

export function deactivate() { }
