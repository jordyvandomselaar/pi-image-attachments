import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readImageContentFromPath } from "../src/image-content.ts";
import { registerImageAttachmentsExtension, type ExtensionContextLike } from "../src/extension-runtime.ts";
import { PREFER_INLINE_SCREENSHOT_PROMPT } from "../src/prompt.ts";

class FakeBaseEditor {
	text = "";
	showingAutocomplete = false;

	setText(text: string): void {
		this.text = text;
	}

	getText(): string {
		return this.text;
	}

	insertTextAtCursor(text: string): void {
		this.text += text;
	}

	getExpandedText(): string {
		return this.text;
	}

	handleInput(_data: string): void {}

	isShowingAutocomplete(): boolean {
		return this.showingAutocomplete;
	}
}

function createKeybindings(actions: string[] = ["tui.input.submit"]): { matches(data: string, action: string): boolean } {
	return {
		matches: (data, action) => data === "SUBMIT" && actions.includes(action),
	};
}

function createMockPi() {
	const handlers = new Map<string, Array<(event: any, ctx: ExtensionContextLike) => any>>();
	const sentMessages: Array<{ content: unknown; options: unknown }> = [];
	return {
		handlers,
		sentMessages,
		pi: {
			on(event: string, handler: (event: any, ctx: ExtensionContextLike) => any) {
				const current = handlers.get(event) ?? [];
				current.push(handler);
				handlers.set(event, current);
			},
			sendUserMessage(content: unknown, options?: unknown) {
				sentMessages.push({ content, options });
			},
		},
	};
}

function createContext(cwd: string, isIdle = true) {
	let editorFactory: ((...args: any[]) => any) | undefined;
	const widgets: Array<{ key: string; content: string[] | undefined }> = [];
	const ctx: ExtensionContextLike = {
		cwd,
		isIdle: () => isIdle,
		ui: {
			setWidget(key, content) {
				widgets.push({ key, content });
			},
			setEditorComponent(factory) {
				editorFactory = factory ?? undefined;
			},
		},
	};
	return { ctx, widgets, getEditorFactory: () => editorFactory };
}

describe("extension-runtime", () => {
	test("registers lifecycle handlers and prompt guidance", async () => {
		const { pi, handlers } = createMockPi();
		registerImageAttachmentsExtension(pi as any, {
			BaseEditor: FakeBaseEditor as any,
			resolveCwd: () => "/cwd",
			looksLikeImagePath: () => false,
			readImageContentFromPath: () => null,
			loadImageContentFromPath: async () => null,
		});

		const promptResult = await handlers.get("before_agent_start")?.[0]?.({}, createContext("/cwd").ctx);
		expect(promptResult).toEqual({ systemPrompt: PREFER_INLINE_SCREENSHOT_PROMPT });
		expect(handlers.has("session_start")).toBe(true);
		expect(handlers.has("session_switch")).toBe(true);
		expect(handlers.has("tool_result")).toBe(true);
		expect(handlers.has("input")).toBe(true);
	});

	test("transforms queued submissions and clears the widget", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-image-runtime-"));
		const imagePath = path.join(dir, "sample.png");
		fs.writeFileSync(imagePath, Buffer.from("runtime-image"));

		const { pi, handlers } = createMockPi();
		registerImageAttachmentsExtension(pi as any, {
			BaseEditor: FakeBaseEditor as any,
			resolveCwd: () => dir,
			looksLikeImagePath: (filePath) => filePath.endsWith(".png") && fs.existsSync(filePath),
			readImageContentFromPath,
			loadImageContentFromPath: async (filePath) => readImageContentFromPath(filePath),
		});

		const { ctx, widgets, getEditorFactory } = createContext(dir);
		await handlers.get("session_start")?.[0]?.({}, ctx);
		const editor = getEditorFactory()?.({}, {}, createKeybindings(), {});
		editor.insertTextAtCursor("Explain ");
		editor.insertTextAtCursor(imagePath);
		editor.handleInput("SUBMIT");

		const transform = await handlers.get("input")?.[0]?.({ text: "Explain [Image #1]", images: [] }, ctx);
		expect(transform).toEqual({
			action: "transform",
			text: "Explain",
			images: [readImageContentFromPath(imagePath)],
		});
		expect(widgets.at(-1)).toEqual({ key: "image-attachments", content: undefined });
	});

	test("sends image-only drafts as steer messages when the agent is busy", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-image-runtime-busy-"));
		const imagePath = path.join(dir, "sample.png");
		fs.writeFileSync(imagePath, Buffer.from("busy-image"));

		const { pi, handlers, sentMessages } = createMockPi();
		registerImageAttachmentsExtension(pi as any, {
			BaseEditor: FakeBaseEditor as any,
			resolveCwd: () => dir,
			looksLikeImagePath: (filePath) => filePath.endsWith(".png") && fs.existsSync(filePath),
			readImageContentFromPath,
			loadImageContentFromPath: async (filePath) => readImageContentFromPath(filePath),
		});

		const { ctx, getEditorFactory } = createContext(dir, false);
		await handlers.get("session_start")?.[0]?.({}, ctx);
		const editor = getEditorFactory()?.({}, {}, createKeybindings(["submit"]), {});
		editor.insertTextAtCursor(imagePath);
		editor.handleInput("SUBMIT");

		expect(sentMessages).toEqual([
			{
				content: [readImageContentFromPath(imagePath)],
				options: { deliverAs: "steer" },
			},
		]);
	});

	test("upgrades screenshot tool results, continues untouched input, and resets widgets on session switch", async () => {
		const { pi, handlers } = createMockPi();
		registerImageAttachmentsExtension(pi as any, {
			BaseEditor: FakeBaseEditor as any,
			resolveCwd: () => "/cwd",
			looksLikeImagePath: () => false,
			readImageContentFromPath: () => null,
			loadImageContentFromPath: async (filePath) =>
				filePath.endsWith("shot.png") ? { type: "image", data: filePath, mimeType: "image/png" } : null,
		});

		const result = await handlers.get("tool_result")?.[0]?.(
			{
				toolName: "mcp",
				details: { tool: "take_screenshot" },
				content: [{ type: "text", text: "Saved screenshot to shot.png." }],
				isError: false,
			},
			createContext("/cwd").ctx,
		);
		expect(result).toEqual({
			content: [
				{ type: "text", text: "Saved screenshot to shot.png." },
				{ type: "image", data: "/cwd/shot.png", mimeType: "image/png" },
			],
		});

		const continueResult = await handlers.get("input")?.[0]?.({ text: "plain text", images: [] }, createContext("/cwd").ctx);
		expect(continueResult).toEqual({ action: "continue" });

		const { ctx, widgets } = createContext("/cwd");
		await handlers.get("session_switch")?.[0]?.({}, ctx);
		expect(widgets.at(-1)).toEqual({ key: "image-attachments", content: undefined });
	});
});
