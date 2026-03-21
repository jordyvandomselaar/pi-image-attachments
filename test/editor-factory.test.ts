import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createImageAttachmentEditor, type DraftAttachment, type PendingSubmission } from "../src/editor-factory.ts";
import { readImageContentFromPath } from "../src/image-content.ts";

class FakeBaseEditor {
	text = "";
	showingAutocomplete = false;
	inputs: string[] = [];

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

	handleInput(data: string): void {
		this.inputs.push(data);
	}

	isShowingAutocomplete(): boolean {
		return this.showingAutocomplete;
	}
}

function createKeybindings(actions: string[] = ["tui.input.submit"]): { matches(data: string, action: string): boolean } {
	return {
		matches: (data, action) => data === "SUBMIT" && actions.includes(action),
	};
}

describe("editor-factory", () => {
	let tempDir: string;
	let imagePath: string;
	let clipboardPath: string;
	let publishedDrafts: DraftAttachment[][];
	let queuedSubmissions: PendingSubmission[];
	let sentImageMessages: Array<Array<{ type: "image"; data: string; mimeType: string }>>;
	let deletedPaths: string[];

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-image-editor-"));
		imagePath = path.join(tempDir, "sample.png");
		clipboardPath = path.join(os.tmpdir(), `pi-clipboard-${Date.now()}.png`);
		fs.writeFileSync(imagePath, Buffer.from("sample-image"));
		fs.writeFileSync(clipboardPath, Buffer.from("clipboard-image"));
		publishedDrafts = [];
		queuedSubmissions = [];
		sentImageMessages = [];
		deletedPaths = [];
	});

	afterEach(() => {
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {}
		try {
			fs.rmSync(clipboardPath, { force: true });
		} catch {}
	});

	function createEditor(options?: {
		resizeImage?: (image: { type: "image"; data: string; mimeType: string }) => Promise<{ type: "image"; data: string; mimeType: string }>;
		autocomplete?: boolean;
		submitActions?: string[];
	}) {
		const Editor = createImageAttachmentEditor({
			BaseEditor: FakeBaseEditor as any,
			resolveCwd: () => tempDir,
			looksLikeImagePath: (filePath) => filePath.endsWith(".png") && fs.existsSync(filePath),
			readImageContentFromPath,
			maybeResizeImage: options?.resizeImage,
			unlinkFile: (filePath) => {
				deletedPaths.push(filePath);
				fs.rmSync(filePath, { force: true });
			},
		});
		const editor = new Editor({}, {}, createKeybindings(options?.submitActions), {
			publishDraft: (attachments: DraftAttachment[]) => {
				publishedDrafts.push([...attachments]);
			},
			queuePendingSubmission: (submission: PendingSubmission) => {
				queuedSubmissions.push(submission);
			},
			sendImagesOnly: (images) => {
				sentImageMessages.push(images as Array<{ type: "image"; data: string; mimeType: string }>);
			},
		}) as FakeBaseEditor;
		editor.showingAutocomplete = options?.autocomplete ?? false;
		return editor;
	}

	test("attaches pasted paths, increments placeholders, and queues stripped submissions", () => {
		const editor = createEditor();
		editor.insertTextAtCursor("Look ");
		editor.insertTextAtCursor(`"${imagePath}"`);
		const secondImagePath = path.join(tempDir, "second.png");
		fs.writeFileSync(secondImagePath, Buffer.from("second-image"));
		editor.insertTextAtCursor(secondImagePath);
		expect(editor.getText()).toBe("Look [Image #1] [Image #2] ");

		editor.setText("Look [Image #2]");
		editor.handleInput("SUBMIT");
		expect(queuedSubmissions).toEqual([
			{
				matchText: "Look [Image #2]",
				transformedText: "Look",
				images: [readImageContentFromPath(secondImagePath)!],
			},
		]);
		expect(sentImageMessages).toEqual([]);
	});

	test("accepts legacy submit action names", () => {
		const editor = createEditor({ submitActions: ["submit"] });
		editor.insertTextAtCursor(imagePath);
		editor.handleInput("SUBMIT");

		expect(sentImageMessages).toHaveLength(1);
		expect(queuedSubmissions).toEqual([]);
	});

	test("sends image-only drafts immediately", () => {
		const editor = createEditor();
		editor.insertTextAtCursor(imagePath);
		editor.handleInput("SUBMIT");

		expect(sentImageMessages).toHaveLength(1);
		expect(sentImageMessages[0]?.[0]?.mimeType).toBe("image/png");
		expect(editor.getText()).toBe("");
		expect(queuedSubmissions).toEqual([]);
	});

	test("handles bracketed paste, clipboard cleanup, and async resize outcomes", async () => {
		const editor = createEditor({
			resizeImage: async (image) => ({ ...image, data: `${image.data}-resized` }),
		});
		editor.handleInput(`\u001b[200~${clipboardPath}\u001b[201~`);

		expect(editor.getText()).toBe("[Image #1] ");
		expect(deletedPaths).toEqual([clipboardPath]);

		await Promise.resolve();
		expect(publishedDrafts.at(-1)?.[0]?.image.data.endsWith("-resized")).toBe(true);

		const rejectingEditor = createEditor({
			resizeImage: async () => {
				throw new Error("resize failed");
			},
		});
		rejectingEditor.insertTextAtCursor(imagePath);
		await Promise.resolve();
		expect(publishedDrafts.at(-1)?.[0]?.image.mimeType).toBe("image/png");
	});

	test("falls through for non-image text and ignores command submissions", () => {
		const editor = createEditor();
		editor.insertTextAtCursor("hello ");
		editor.insertTextAtCursor("not-an-image-path");
		expect(editor.getText()).toBe("hello not-an-image-path");

		editor.setText(`/command [Image #1]`);
		editor.handleInput("SUBMIT");
		editor.setText(` !ls [Image #1]`);
		editor.handleInput("SUBMIT");
		expect(queuedSubmissions).toEqual([]);
		expect(sentImageMessages).toEqual([]);
	});

	test("removing placeholders drops attachments and autocomplete bypasses submit interception", () => {
		const editor = createEditor({ autocomplete: true });
		editor.insertTextAtCursor(imagePath);
		expect(publishedDrafts.at(-1)).toHaveLength(1);

		editor.setText("just text");
		expect(publishedDrafts.at(-1)).toEqual([]);

		editor.insertTextAtCursor(imagePath);
		editor.handleInput("SUBMIT");
		expect(queuedSubmissions).toEqual([]);
	});
});
