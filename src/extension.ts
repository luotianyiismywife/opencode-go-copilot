import * as vscode from "vscode";
import { OpenCodeGoChatModelProvider } from "./provider";
import { initStatusBar } from "./statusBar";
import { logger } from "./logger";
import { l10n, l10nFormat } from "./localize";
import type { ModelPreset } from "./types";
import { abortCommitGeneration, generateCommitMsg } from "./gitCommit/commitMessageGenerator";
import { TokenizerManager } from "./tokenizer/tokenizerManager";

export function activate(context: vscode.ExtensionContext) {
    // Initialize logger
    logger.init();

    // Initialize TokenizerManager with extension path
    TokenizerManager.initialize(context.extensionPath);

    const tokenCountStatusBarItem: vscode.StatusBarItem = initStatusBar(context);
    const provider = new OpenCodeGoChatModelProvider(context.secrets, tokenCountStatusBarItem);

    // Register the OpenCode Go provider under the vendor id used in package.json
    vscode.lm.registerLanguageModelChatProvider("opencodego", provider);

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
            const currentTemp = config.get<number | null>("opencodego.temperature", null);
            const currentTopP = config.get<number | null>("opencodego.top_p", null);

            const currentTempStr = currentTemp !== null ? String(currentTemp) : "—";
            const currentTopPStr = currentTopP !== null ? String(currentTopP) : "—";

            // Build preset QuickPick items with embedded presetId for reliable matching
            interface PresetQuickPickItem extends vscode.QuickPickItem {
                presetId?: string;
            }

            const presetItems: PresetQuickPickItem[] = presets.map((p) => ({
                label: `${p.label}（${p.temperature}, ${p.top_p !== undefined ? p.top_p : "—"}）`,
                presetId: p.id,
            }));

            const customItem: PresetQuickPickItem = {
                label: "$(pencil) " + l10n("Custom (manual input temp,top_p)"),
            };

            const items: PresetQuickPickItem[] = [
                ...presetItems,
                { label: "", kind: vscode.QuickPickItemKind.Separator },
                customItem,
                {
                    label: l10nFormat("Current temp: {0}, top_p: {1}", currentTempStr, currentTopPStr),
                    kind: vscode.QuickPickItemKind.Separator,
                },
            ];

            const title = l10n("Set Model Preset") + " — " + l10nFormat("Current temp: {0}, top_p: {1}", currentTempStr, currentTopPStr);

            const picked = await vscode.window.showQuickPick(items, {
                title,
                placeHolder: l10n("Select a preset (temp, top_p)"),
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
                    await config.update("opencodego.top_p", matchedPreset.top_p, vscode.ConfigurationTarget.Global);
                    vscode.window.showInformationMessage(
                        l10nFormat("Set to temp: {0}, top_p: {1} ({2})", String(matchedPreset.temperature), String(matchedPreset.top_p), matchedPreset.label)
                    );
                }
            } else {
                // User chose "Custom (manual input)"
                const currentVal = currentTemp !== null && currentTopP !== null
                    ? `${currentTemp},${currentTopP}`
                    : "";
                const inputValue = await vscode.window.showInputBox({
                    title: l10n("Enter temperature and top_p"),
                    prompt: l10n("Enter temp,top_p (comma separated), e.g.: 0.7,0.95"),
                    value: currentVal,
                    validateInput: (val: string) => {
                        const parts = val.split(",");
                        if (parts.length !== 2) {
                            return l10n("Please enter two numbers separated by a comma");
                        }
                        const temp = parseFloat(parts[0].trim());
                        const topP = parseFloat(parts[1].trim());
                        if (isNaN(temp) || temp < 0 || temp > 2) {
                            return l10n("Temperature must be between 0.0 and 2.0");
                        }
                        if (isNaN(topP) || topP < 0 || topP > 1) {
                            return l10n("top_p must be between 0.0 and 1.0");
                        }
                        return null;
                    },
                    ignoreFocusOut: true,
                });
                if (inputValue !== undefined) {
                    const parts = inputValue.split(",");
                    const tempNum = parseFloat(parts[0].trim());
                    const topPNum = parseFloat(parts[1].trim());
                    await config.update("opencodego.modelPreset", "custom", vscode.ConfigurationTarget.Global);
                    await config.update("opencodego.temperature", tempNum, vscode.ConfigurationTarget.Global);
                    await config.update("opencodego.top_p", topPNum, vscode.ConfigurationTarget.Global);
                    vscode.window.showInformationMessage(
                        l10nFormat("Set to temp: {0}, top_p: {1} (custom)", String(tempNum), String(topPNum))
                    );
                }
            }
        })
    );

    // Dispose logger on deactivate
    context.subscriptions.push({
        dispose: () => logger.dispose(),
    });
}

export function deactivate() { }
