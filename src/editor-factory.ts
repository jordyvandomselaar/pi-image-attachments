import path from "node:path";
import type { ImageContent } from "./content.ts";
import {
	createImagePlaceholder,
	isClipboardTempFile,
	normalizePastedPath,
	removeImagePlaceholders,
	resolveMaybeRelativePath,
	sortByPlaceholderNumber,
} from "./path-utils.ts";

export type PendingSubmission = {
	matchText: string;
	transformedText: string;
	images: ImageContent[];
};

export type DraftAttachment = {
	placeholder: string;
	image: ImageContent;
	label: string;
	originalPath: string;
};

export type EditorHooks = {
	publishDraft: (attachments: DraftAttachment[]) => void;
	queuePendingSubmission: (submission: PendingSubmission) => void;
	sendImagesOnly: (images: ImageContent[]) => void;
};

type RuntimeKeybindings = {
	matches(data: string, action: string): boolean;
};

export type EditorBase = {
	setText(text: string): void;
	getText(): string;
	insertTextAtCursor?(text: string): void;
	handleInput(data: string): void;
	getExpandedText?(): string;
	isShowingAutocomplete?(): boolean;
};

export type EditorBaseConstructor = new (...args: any[]) => EditorBase;

export type EditorFactory = (tui: any, theme: any, keybindings: any) => EditorBase;

export type ImageAttachmentBehaviorDeps = {
	resolveCwd: () => string;
	looksLikeImagePath: (filePath: string) => boolean;
	readImageContentFromPath: (filePath: string) => ImageContent | null;
	maybeResizeImage?: (image: ImageContent) => Promise<ImageContent>;
	unlinkFile?: (filePath: string) => void;
};

export type AttachmentEditorDeps = ImageAttachmentBehaviorDeps & {
	BaseEditor: EditorBaseConstructor;
};

const BRACKETED_PASTE_START = "\u001b[200~";
const BRACKETED_PASTE_END = "\u001b[201~";

function extractBracketedPaste(data: string): string | null {
	if (!data.startsWith(BRACKETED_PASTE_START) || !data.endsWith(BRACKETED_PASTE_END)) {
		return null;
	}
	return data.slice(BRACKETED_PASTE_START.length, -BRACKETED_PASTE_END.length);
}

function isRuntimeKeybindings(value: unknown): value is RuntimeKeybindings {
	return typeof value === "object" && value !== null && typeof (value as RuntimeKeybindings).matches === "function";
}

function matchesSubmitInput(keybindings: RuntimeKeybindings | undefined, data: string): boolean {
	if (!keybindings) {
		return false;
	}

	return keybindings.matches(data, "tui.input.submit");
}

export function createImageAttachmentEditor(deps: AttachmentEditorDeps, hooks: EditorHooks) {
	const BaseEditor = deps.BaseEditor;

	return class ImageAttachmentEditor extends BaseEditor {
		constructor(tui: any, theme: any, keybindings: any) {
			super(tui, theme, keybindings);
			attachImageAttachmentBehavior(this, keybindings, deps, hooks);
		}
	};
}

export function attachImageAttachmentBehavior(
	editor: EditorBase,
	keybindings: unknown,
	deps: ImageAttachmentBehaviorDeps,
	hooks: EditorHooks,
): EditorBase {
	let attachments: DraftAttachment[] = [];
	const runtimeKeybindings = isRuntimeKeybindings(keybindings) ? keybindings : undefined;

	const setText = editor.setText.bind(editor);
	const getText = editor.getText.bind(editor);
	const insertTextAtCursor = editor.insertTextAtCursor?.bind(editor) ??
		((text: string) => setText(`${getText()}${text}`));
	const handleInput = editor.handleInput.bind(editor);
	const getExpandedText = editor.getExpandedText?.bind(editor);
	const isShowingAutocomplete = editor.isShowingAutocomplete?.bind(editor);

	const publishDraft = () => {
		hooks.publishDraft(attachments);
	};

	const syncAttachments = () => {
		const text = getText();
		attachments = attachments.filter((attachment) => text.includes(attachment.placeholder));
	};

	const clearDraft = () => {
		attachments = [];
		setText("");
		publishDraft();
	};

	const nextPlaceholderNumber = () => {
		const maxNumber = attachments.reduce((highest, attachment) => {
			const match = attachment.placeholder.match(/\[Image #(\d+)\]/);
			const current = match ? Number.parseInt(match[1] ?? "0", 10) : 0;
			return Math.max(highest, current);
		}, 0);
		return maxNumber + 1;
	};

	const tryAttachPastedPath = (rawText: string) => {
		const normalized = normalizePastedPath(rawText);
		if (!normalized) {
			return false;
		}

		const resolvedPath = resolveMaybeRelativePath(normalized, deps.resolveCwd());
		if (!deps.looksLikeImagePath(resolvedPath)) {
			return false;
		}

		const image = deps.readImageContentFromPath(resolvedPath);
		if (!image) {
			return false;
		}

		const placeholder = createImagePlaceholder(nextPlaceholderNumber());
		const attachment: DraftAttachment = {
			placeholder,
			image,
			label: path.basename(resolvedPath),
			originalPath: resolvedPath,
		};

		attachments.push(attachment);
		insertTextAtCursor(`${placeholder} `);
		publishDraft();

		if (deps.maybeResizeImage) {
			void deps.maybeResizeImage(image)
				.then((resized) => {
					attachment.image = resized;
				})
				.catch(() => {
					// Keep original image if resize fails.
				});
		}

		if (isClipboardTempFile(resolvedPath)) {
			try {
				deps.unlinkFile?.(resolvedPath);
			} catch {
				// Best effort cleanup only.
			}
		}

		return true;
	};

	editor.setText = (text: string) => {
		setText(text);
		syncAttachments();
		publishDraft();
	};

	editor.insertTextAtCursor = (text: string) => {
		if (tryAttachPastedPath(text)) {
			return;
		}

		insertTextAtCursor(text);
		syncAttachments();
		publishDraft();
	};

	editor.handleInput = (data: string) => {
		const bracketedPaste = extractBracketedPaste(data);
		if (bracketedPaste !== null && tryAttachPastedPath(bracketedPaste)) {
			return;
		}

		const isSubmit = matchesSubmitInput(runtimeKeybindings, data) && !(isShowingAutocomplete?.() ?? false);
		if (isSubmit && attachments.length > 0) {
			const fullText = (getExpandedText?.() ?? getText()).trim();
			const usedAttachments = sortByPlaceholderNumber(
				attachments.filter((attachment) => fullText.includes(attachment.placeholder)),
			);

			if (usedAttachments.length > 0 && !fullText.startsWith("/") && !fullText.trimStart().startsWith("!")) {
				const transformedText = removeImagePlaceholders(fullText);
				const images = usedAttachments.map((attachment) => attachment.image);

				if (!transformedText) {
					clearDraft();
					hooks.sendImagesOnly(images);
					return;
				}

				hooks.queuePendingSubmission({
					matchText: fullText,
					transformedText,
					images,
				});
			}
		}

		const beforeText = getText();
		handleInput(data);
		if (getText() !== beforeText) {
			syncAttachments();
			publishDraft();
		}
	};

	return editor;
}
