import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readImageContentFromPath } from "../src/image-content.ts";
import type { EditorFactory } from "../src/editor-factory.ts";
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

class FakePreviousEditor {
	text = "";
	inputs: string[] = [];

	setText(text: string): void {
		this.text = text;
	}

	getText(): string {
		return this.text;
	}

	handleInput(data: string): void {
		this.inputs.push(data);
	}

	previousEditorBehavior(): string {
		return "previous editor active";
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

function createContext(cwd: string, isIdle = true, initialEditorFactory?: EditorFactory) {
	let editorFactory = initialEditorFactory;
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
			getEditorComponent() {
				return editorFactory;
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

		const promptResult = await handlers
			.get("before_agent_start")?.[0]?.({ systemPrompt: "Base prompt" }, createContext("/cwd").ctx);
		expect(promptResult).toEqual({ systemPrompt: `Base prompt\n\n${PREFER_INLINE_SCREENSHOT_PROMPT}` });
		expect(handlers.has("session_start")).toBe(true);
		expect(handlers.has("session_switch")).toBe(true);
		expect(handlers.has("tool_result")).toBe(true);
		expect(handlers.has("input")).toBe(true);
	});

	test("keeps the previous editor across lifecycle reinstall while image hooks use the standard constructor", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-image-runtime-"));
		const imagePath = path.join(dir, "sample.png");
		fs.writeFileSync(imagePath, Buffer.from("runtime-image"));
		const previousEditorArgs: Parameters<EditorFactory>[] = [];
		const previousEditorFactory: EditorFactory = (tui, theme, keybindings) => {
			previousEditorArgs.push([tui, theme, keybindings]);
			return new FakePreviousEditor();
		};

		const { pi, handlers } = createMockPi();
		registerImageAttachmentsExtension(pi as any, {
			BaseEditor: FakeBaseEditor as any,
			resolveCwd: () => dir,
			looksLikeImagePath: (filePath) => filePath.endsWith(".png") && fs.existsSync(filePath),
			readImageContentFromPath,
			loadImageContentFromPath: async (filePath) => readImageContentFromPath(filePath),
		});

		const { ctx, widgets, getEditorFactory } = createContext(dir, true, previousEditorFactory);
		await handlers.get("session_start")?.[0]?.({}, ctx);
		await handlers.get("session_switch")?.[0]?.({}, ctx);
		const editor = getEditorFactory()?.({}, {}, createKeybindings()) as FakePreviousEditor & {
			insertTextAtCursor(text: string): void;
		};
		expect(previousEditorArgs.at(-1)).toHaveLength(3);
		expect(editor).toBeInstanceOf(FakePreviousEditor);
		expect(editor.previousEditorBehavior()).toBe("previous editor active");

		editor.setText("Explain ");
		const widgetCountBeforePaste = widgets.length;
		editor.insertTextAtCursor(imagePath);
		expect(widgets.slice(widgetCountBeforePaste)).toEqual([
			{ key: "image-attachments", content: ["Attached images:", "[Image #1] sample.png"] },
		]);

		editor.handleInput("SUBMIT");
		expect(editor.inputs).toEqual(["SUBMIT"]);

		const transform = await handlers.get("input")?.[0]?.({ text: "Explain [Image #1]", images: [] }, ctx);
		expect(transform).toEqual({
			action: "transform",
			text: "Explain",
			images: [readImageContentFromPath(imagePath)],
		});
		expect(widgets.at(-1)).toEqual({ key: "image-attachments", content: undefined });
	});

	test("sends image-only drafts with the correct idle and busy delivery modes", async () => {
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

		const busyContext = createContext(dir, false);
		await handlers.get("session_start")?.[0]?.({}, busyContext.ctx);
		const busyEditor = busyContext.getEditorFactory()?.({}, {}, createKeybindings());
		busyEditor.insertTextAtCursor(imagePath);
		busyEditor.handleInput("SUBMIT");

		const idleContext = createContext(dir, true);
		await handlers.get("session_switch")?.[0]?.({}, idleContext.ctx);
		const idleEditor = idleContext.getEditorFactory()?.({}, {}, createKeybindings());
		idleEditor.insertTextAtCursor(imagePath);
		idleEditor.handleInput("SUBMIT");

		expect(sentMessages).toEqual([
			{
				content: [readImageContentFromPath(imagePath)],
				options: { deliverAs: "steer" },
			},
			{
				content: [readImageContentFromPath(imagePath)],
				options: undefined,
			},
		]);
	});

	test("wires screenshot tool results, continues untouched input, and resets widgets on session switch", async () => {
		const { pi, handlers } = createMockPi();
		const loadedPaths: string[] = [];
		const loadedImage = { type: "image", data: "loaded-shot", mimeType: "image/png" } as const;
		registerImageAttachmentsExtension(pi as any, {
			BaseEditor: FakeBaseEditor as any,
			resolveCwd: () => "/cwd",
			looksLikeImagePath: () => false,
			readImageContentFromPath: () => null,
			loadImageContentFromPath: async (filePath) => {
				loadedPaths.push(filePath);
				return loadedImage;
			},
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
		expect(loadedPaths).toEqual(["/cwd/shot.png"]);
		expect(result?.content).toContain(loadedImage);

		const continueResult = await handlers.get("input")?.[0]?.({ text: "plain text", images: [] }, createContext("/cwd").ctx);
		expect(continueResult).toEqual({ action: "continue" });

		const { ctx, widgets } = createContext("/cwd");
		await handlers.get("session_switch")?.[0]?.({}, ctx);
		expect(widgets.at(-1)).toEqual({ key: "image-attachments", content: undefined });
	});
});
