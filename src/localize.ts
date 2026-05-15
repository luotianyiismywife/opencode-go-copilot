import * as vscode from "vscode";

/** 英文 fallback 字典：为 l10n key 提供可读的英文文本，避免直接暴露 raw key */
const en: Record<string, string> = {
};

const zhCN: Record<string, string> = {
	// statusBar
	"Token Count": "Token 计数",
	"Current model token usage": "当前模型 token 使用量",
	"Token Usage": "Token 使用量",
	"Ready": "就绪",

	// extension.ts - API key prompts
	"OpenCode Go Provider API Key": "OpenCode Go 提供商 API 密钥",
	"Update your OpenCode Go API key": "更新您的 OpenCode Go API 密钥",
	"Enter your OpenCode Go API key": "输入您的 OpenCode Go API 密钥",
	"OpenCode Go API key cleared.": "OpenCode Go API 密钥已清除。",
	"OpenCode Go API key saved.": "OpenCode Go API 密钥已保存。",

	// provider.ts
	"OpenCode Go API key not found": "未找到 OpenCode Go API 密钥",
	"Invalid base URL configuration.": "无效的 Base URL 配置。",

	// statusBar cache tooltip
	"Cache": "缓存",
	"({0} cached, {1}%)": "(已缓存 {0}, 命中率 {1}%)",
	"No changes found in any workspace repositories.": "在任何工作区仓库中均未发现更改。",
	"Git extension not found": "未找到 Git 扩展",
	"No Git repositories available": "没有可用的 Git 仓库",
	"Repository not found for provided SCM": "未找到指定 SCM 对应的仓库",
	"No models configured for commit message generation. Please set 'useForCommitGeneration' to true for at least one model in your configuration.":
		"未配置用于生成提交消息的模型。请在配置中将至少一个模型的 'useForCommitGeneration' 设为 true。",
	"Failed to generate commit message:": "生成提交消息失败：",
	"[Commit Generation Failed]": "[提交生成失败]",
	"empty API response": "API 返回为空",

	// Timeout error
	"Request timed out. The generation took too long. You can increase the timeout in settings (opencodego.requestTimeout).":
		"请求超时，生成内容过长。您可以在设置中增加超时时间（opencodego.requestTimeout）。",
	"The connection was closed by the server. The generation took too long. Please try again or request shorter content.":
		"服务端连接被关闭，生成内容过长时间过长。请重试或请求较短的内容。",

	// reasoning effort labels (keys are English fallback text)
	"Disabled": "禁用思考",
	"Thinking": "思考",
	"Low": "低",
	"Medium": "中",
	"High": "高",
	"Maximum": "极高",

	// reasoning effort descriptions (keys are English fallback text)
	"Do not enable thinking": "不启用思考",
	"Enable thinking": "启用思考",
	"Reduce thinking, faster response": "减少思考，响应更快",
	"Balance thinking and speed": "平衡思考与速度",
	"Deeper thinking, slower response": "更深入的思考，但速度较慢",
	"Maximum thinking depth, slowest response": "最大思考深度，速度最慢",

	// reasoning effort title (key is English fallback text)
	"Reasoning Effort": "推理强度",

	// extension.ts - model preset (setModelPreset command)
	"Custom (manual input temp,top_p)": "自定义（手动输入 温度,top_p）",
	"Current temp: {0}, top_p: {1}": "当前温度 {0}，top_p {1}",
	"Set Model Preset": "设置模型预设",
	"Select a preset (temp, top_p)": "选择一个档位（温度, top_p）",
	"Enter temperature and top_p": "输入温度和 top_p",
	"Enter temp,top_p (comma separated), e.g.: 0.7,0.95": "输入 温度,top_p（英文逗号分隔），如：0.7,0.95",
	"Please enter two numbers separated by a comma": "请输入两个数值，用英文逗号分隔",
	"Temperature must be between 0.0 and 2.0": "温度必须在 0.0 到 2.0 之间",
	"top_p must be between 0.0 and 1.0": "top_p 必须在 0.0 到 1.0 之间",
	"Set to temp: {0}, top_p: {1} ({2})": "已设为 温度 {0}，top_p {1}（{2}）",
	"Set to temp: {0}, top_p: {1} (custom)": "已设为 温度 {0}，top_p {1}（自定义）",
};

/**
 * Get the localized string for the given key.
 * Falls back to the key itself if no translation is available.
 */
export function l10n(key: string): string {
	const language = vscode.env.language;
	// 中文环境：优先返回中文字典，不存在则回退到 key
	if (language.toLowerCase() === "zh-cn" || language.toLowerCase().startsWith("zh")) {
		if (zhCN[key]) {
			return zhCN[key];
		}
	}
	// 非中文环境：优先使用 en 字典中的可读英文文本，回退到 key 本身
	if (en[key]) {
		return en[key];
	}
	return key;
}

/**
 * Format a localized string with replacements.
 * Usage: l10nFormat("Token Usage: {0} / {1}", "12.5K", "1M")
 */
export function l10nFormat(template: string, ...args: (string | number)[]): string {
	let str = l10n(template);
	for (let i = 0; i < args.length; i++) {
		str = str.replace(`{${i}}`, String(args[i]));
	}
	return str;
}
