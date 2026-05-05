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
const IMAGE_ATTACHMENT_BEHAVIOR = Symbol("pi-image-attachment-behavior");

type ImageAttachmentBehaviorState = {
	attachments: DraftAttachment[];
	keybindings: RuntimeKeybindings | undefined;
	deps: ImageAttachmentBehaviorDeps;
	hooks: EditorHooks;
	setText: (text: string) => void;
	getText: () => string;
	insertTextAtCursor: (text: string) => void;
	handleInput: (data: string) => void;
	getExpandedText?: () => string;
	isShowingAutocomplete?: () => boolean;
};

type EditorWithImageAttachmentBehavior = EditorBase & {
	[IMAGE_ATTACHMENT_BEHAVIOR]?: ImageAttachmentBehaviorState;
};

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
	const editorWithBehavior = editor as EditorWithImageAttachmentBehavior;
	const existingState = editorWithBehavior[IMAGE_ATTACHMENT_BEHAVIOR];
	if (existingState) {
		existingState.keybindings = isRuntimeKeybindings(keybindings) ? keybindings : undefined;
		existingState.deps = deps;
		existingState.hooks = hooks;
		return editor;
	}

	const setText = editorWithBehavior.setText.bind(editorWithBehavior);
	const getText = editorWithBehavior.getText.bind(editorWithBehavior);
	const insertTextAtCursor = editorWithBehavior.insertTextAtCursor?.bind(editorWithBehavior) ??
		((text: string) => setText(`${getText()}${text}`));
	const state: ImageAttachmentBehaviorState = {
		attachments: [],
		keybindings: isRuntimeKeybindings(keybindings) ? keybindings : undefined,
		deps,
		hooks,
		setText,
		getText,
		insertTextAtCursor,
		handleInput: editorWithBehavior.handleInput.bind(editorWithBehavior),
		getExpandedText: editorWithBehavior.getExpandedText?.bind(editorWithBehavior),
		isShowingAutocomplete: editorWithBehavior.isShowingAutocomplete?.bind(editorWithBehavior),
	};
	editorWithBehavior[IMAGE_ATTACHMENT_BEHAVIOR] = state;

	const publishDraft = () => {
		state.hooks.publishDraft(state.attachments);
	};

	const syncAttachments = () => {
		const text = state.getText();
		state.attachments = state.attachments.filter((attachment) => text.includes(attachment.placeholder));
	};

	const clearDraft = () => {
		state.attachments = [];
		state.setText("");
		publishDraft();
	};

	const nextPlaceholderNumber = () => {
		const maxNumber = state.attachments.reduce((highest, attachment) => {
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

		const resolvedPath = resolveMaybeRelativePath(normalized, state.deps.resolveCwd());
		if (!state.deps.looksLikeImagePath(resolvedPath)) {
			return false;
		}

		const image = state.deps.readImageContentFromPath(resolvedPath);
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

		state.attachments.push(attachment);
		state.insertTextAtCursor(`${placeholder} `);
		publishDraft();

		if (state.deps.maybeResizeImage) {
			void state.deps.maybeResizeImage(image)
				.then((resized) => {
					attachment.image = resized;
				})
				.catch(() => {
					// Keep original image if resize fails.
				});
		}

		if (isClipboardTempFile(resolvedPath)) {
			try {
				state.deps.unlinkFile?.(resolvedPath);
			} catch {
				// Best effort cleanup only.
			}
		}

		return true;
	};

	editorWithBehavior.setText = (text: string) => {
		state.setText(text);
		syncAttachments();
		publishDraft();
	};

	editorWithBehavior.insertTextAtCursor = (text: string) => {
		if (tryAttachPastedPath(text)) {
			return;
		}

		state.insertTextAtCursor(text);
		syncAttachments();
		publishDraft();
	};

	editorWithBehavior.handleInput = (data: string) => {
		const bracketedPaste = extractBracketedPaste(data);
		if (bracketedPaste !== null && tryAttachPastedPath(bracketedPaste)) {
			return;
		}

		const isSubmit = matchesSubmitInput(state.keybindings, data) && !(state.isShowingAutocomplete?.() ?? false);
		if (isSubmit && state.attachments.length > 0) {
			const fullText = (state.getExpandedText?.() ?? state.getText()).trim();
			const usedAttachments = sortByPlaceholderNumber(
				state.attachments.filter((attachment) => fullText.includes(attachment.placeholder)),
			);

			if (usedAttachments.length > 0 && !fullText.startsWith("/") && !fullText.trimStart().startsWith("!")) {
				const transformedText = removeImagePlaceholders(fullText);
				const images = usedAttachments.map((attachment) => attachment.image);

				if (!transformedText) {
					clearDraft();
					state.hooks.sendImagesOnly(images);
					return;
				}

				state.hooks.queuePendingSubmission({
					matchText: fullText,
					transformedText,
					images,
				});
			}
		}

		const beforeText = state.getText();
		state.handleInput(data);
		if (state.getText() !== beforeText) {
			syncAttachments();
			publishDraft();
		}
	};

	return editorWithBehavior;
}
