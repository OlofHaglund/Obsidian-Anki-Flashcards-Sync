import {Plugin, TFile} from "obsidian";
import {parseFlashcardBlock} from "./parser";
import {FlashcardBlockConfig, FlashcardTemplateConfig} from "./types";

const DEFAULT_CARD_NAME = "Default card";
const DEFAULT_CARD_FRONT = "{{front}}";
const DEFAULT_CARD_BACK = "{{FrontSide}}<hr id=answer>{{back}}";
const DEFAULT_NOTE_STYLING = `.card { font-family: Arial, sans-serif; font-size: 1rem; line-height: 1.4; color: var(--text-normal); }
hr#answer { margin: 0.75rem 0; border: 0; border-top: 1px solid var(--background-modifier-border); }`;

/**
 * Registers renderer hooks for `flashcard` code blocks.
 */
export function registerFlashcardCodeBlockRenderer(plugin: Plugin): void {
	plugin.registerMarkdownCodeBlockProcessor("flashcard", (source, el, ctx) => {
		renderFlashcardBlock(plugin, source, el, ctx.sourcePath);
	});

	plugin.registerMarkdownPostProcessor((rootEl, ctx) => {
		const codeBlocks = Array.from(rootEl.querySelectorAll("pre > code.language-flashcard"));

		for (const codeBlock of codeBlocks) {
			const pre = codeBlock.parentElement;
			if (!(pre instanceof HTMLElement)) {
				continue;
			}

			const source = codeBlock.textContent ?? "";
			const replacement = document.createElement("div");
			renderFlashcardBlock(plugin, source, replacement, ctx.sourcePath);

			pre.replaceWith(replacement);
		}
	});
}

/**
 * Parses and renders a flashcard block into the target element.
 */
function renderFlashcardBlock(
	plugin: Plugin,
	source: string,
	targetEl: HTMLElement,
	sourcePath: string,
): void {
	const parsed = parseFlashcardBlock(source);
	const errors = [...parsed.errors];
	let fieldValues: Record<string, string> = {};
	let resolvedNoteType: FlashcardBlockConfig["note_type"] | undefined;
	const frontmatter = getFrontmatter(plugin, sourcePath);

	if (parsed.config) {
		resolvedNoteType = resolveNoteTypeDefinition(plugin, parsed.config.note_type, errors);
		if (resolvedNoteType) {
			const resolved = resolveFieldValues(resolvedNoteType.fields, frontmatter);
			errors.push(...resolved.errors);
			fieldValues = resolved.values;
		}
	}

	targetEl.empty();

	if (!parsed.config || !resolvedNoteType || errors.length > 0) {
		renderWarning(targetEl, errors);
		return;
	}

	renderPreview(
		plugin,
		targetEl,
		{
			deck: parsed.config.deck,
			note_type: resolvedNoteType,
		},
		fieldValues,
		sourcePath,
	);
}

/**
 * Gets frontmatter for a markdown file path.
 */
function getFrontmatter(plugin: Plugin, sourcePath: string): Record<string, unknown> {
	const file = plugin.app.vault.getAbstractFileByPath(sourcePath);
	if (!(file instanceof TFile)) {
		return {};
	}

	const cache = plugin.app.metadataCache.getFileCache(file);
	const frontmatter = cache?.frontmatter;

	if (!isRecord(frontmatter)) {
		return {};
	}

	return frontmatter;
}

/**
 * Resolves configured field keys from note frontmatter.
 */
function resolveFieldValues(
	keys: string[],
	frontmatter: Record<string, unknown>,
): {values: Record<string, string>; errors: string[]} {
	const values: Record<string, string> = {};
	const errors: string[] = [];

	for (const key of keys) {
		const value = frontmatter[key];
		if (value === undefined || value === null) {
			errors.push(`Missing frontmatter key: ${key}`);
			continue;
		}

		values[key] = toFieldText(value);
	}

	return {values, errors};
}

/**
 * Resolves note type definition from inline config or `Anki/*.md` frontmatter files.
 */
function resolveNoteTypeDefinition(
	plugin: Plugin,
	noteType: FlashcardBlockConfig["note_type"],
	errors: string[],
): FlashcardBlockConfig["note_type"] | undefined {
	const hasInlineDefinition = noteType.cards.length > 0 || noteType.styling.length > 0;
	if (hasInlineDefinition) {
		if (noteType.fields.length === 0) {
			errors.push("note_type.fields must contain at least one field.");
			return undefined;
		}
		return noteType;
	}

	const registry = getAnkiNoteTypeRegistry(plugin);
	const definition = registry[noteType.name];
	if (!definition) {
		if (noteType.fields.length > 0) {
			// Legacy fallback: allow block-defined fields even when no shared note type file exists.
			return noteType;
		}
		errors.push(`Missing shared note type file definition for: ${noteType.name}`);
		return undefined;
	}

	const fields = definition.fields.length > 0
		? definition.fields
		: (noteType.fields.length > 0 ? noteType.fields : extractFieldsFromCards(definition.cards));
	if (fields.length === 0) {
		errors.push(`Shared note type ${noteType.name} has no resolvable fields.`);
		return undefined;
	}

	return {
		name: noteType.name,
		fields,
		cards: definition.cards,
		styling: definition.styling,
	};
}

/**
 * Renders flashcard preview cards, one preview per note-type card template.
 */
function renderPreview(
	plugin: Plugin,
	el: HTMLElement,
	config: FlashcardBlockConfig,
	fields: Record<string, string>,
	sourcePath: string,
): void {
	const container = el.createDiv({cls: "obsidian-anki-flashcard"});

	const header = container.createDiv({cls: "obsidian-anki-flashcard__header"});
	header.createSpan({
		cls: "obsidian-anki-flashcard__deck",
		text: config.deck,
	});
	header.createSpan({
		cls: "obsidian-anki-flashcard__note-type",
		text: config.note_type.name,
	});

	const cards = config.note_type.cards.length > 0
		? config.note_type.cards
		: [buildDefaultTemplate(config.note_type.fields)];

	const cardsContainer = container.createDiv({cls: "obsidian-anki-flashcard__cards"});
	for (const cardTemplate of cards) {
		renderTemplatePreviewCard(plugin, cardsContainer, cardTemplate, fields, config.note_type.styling, sourcePath);
	}
}

/**
 * Renders an interactive card preview (front/back toggle).
 */
function renderTemplatePreviewCard(
	plugin: Plugin,
	container: HTMLElement,
	template: FlashcardTemplateConfig,
	fields: Record<string, string>,
	styling: string,
	sourcePath: string,
): void {
	const cardShell = container.createDiv({cls: "obsidian-anki-preview-card"});

	const toolbar = cardShell.createDiv({cls: "obsidian-anki-preview-card__toolbar"});
	toolbar.createSpan({
		cls: "obsidian-anki-preview-card__title",
		text: template.name,
	});

	const sideToggle = toolbar.createEl("button", {
		cls: "obsidian-anki-preview-card__toggle",
		text: "Show back",
	});
	sideToggle.type = "button";

	const previewHost = cardShell.createDiv({cls: "obsidian-anki-preview-card__host"});
	const shadowRoot = previewHost.attachShadow({mode: "open"});

	const styleSheet = new CSSStyleSheet();
	styleSheet.replaceSync(`${DEFAULT_NOTE_STYLING}\n${styling}`);
	shadowRoot.adoptedStyleSheets = [...shadowRoot.adoptedStyleSheets, styleSheet];

	const cardSurface = document.createElement("div");
	cardSurface.className = "card";
	shadowRoot.appendChild(cardSurface);

	let currentSide: "front" | "back" = "front";

	const renderedFront = renderAnkiTemplate(template.front_template, fields);
	const renderedBack = renderAnkiTemplate(template.back_template, fields, renderedFront);

	const applySide = (side: "front" | "back"): void => {
		currentSide = side;
		sideToggle.textContent = side === "front" ? "Show back" : "Show front";
		const html = side === "front" ? renderedFront : renderedBack;
		cardSurface.replaceChildren(sanitizeTemplateFragment(html));
		hydrateAudioTokens(plugin, cardSurface, sourcePath);
	};

	sideToggle.addEventListener("click", () => {
		applySide(currentSide === "front" ? "back" : "front");
	});

	applySide("front");
}

/**
 * Provides a default card template when no templates are defined.
 */
function buildDefaultTemplate(fields: string[]): FlashcardTemplateConfig {
	const frontField = fields[0] ?? "";
	const backField = fields[1] ?? fields[0] ?? "";

	return {
		name: DEFAULT_CARD_NAME,
		front_template: DEFAULT_CARD_FRONT.replace("front", frontField),
		back_template: DEFAULT_CARD_BACK.replace("back", backField),
	};
}

/**
 * Renders Anki-style `{{field}}` placeholders.
 */
function renderAnkiTemplate(
	template: string,
	fields: Record<string, string>,
	frontSide = "",
): string {
	return template.replace(/{{\s*([^}]+)\s*}}/g, (_match, token: string) => {
		const normalizedToken = normalizePlaceholderToken(token);
		if (normalizedToken === "FrontSide") {
			return frontSide;
		}
		const value = fields[normalizedToken] ?? "";
		if (normalizedToken === "Audio" && value.length > 0) {
			return buildAudioPlaceholder(value);
		}
		return value;
	});
}

/**
 * Creates a placeholder marker for audio fields before hydration.
 */
function buildAudioPlaceholder(value: string): string {
	return `<span class="obsidian-anki-audio-token" data-audio-path="${encodeURIComponent(value)}"></span>`;
}

/**
 * Replaces audio placeholders with clickable play buttons.
 */
function hydrateAudioTokens(plugin: Plugin, cardSurface: HTMLElement, sourcePath: string): void {
	const placeholders = Array.from(cardSurface.querySelectorAll("span.obsidian-anki-audio-token"));

	for (const placeholder of placeholders) {
		const encodedPath = placeholder.getAttribute("data-audio-path") ?? "";
		const audioPath = safeDecodeURIComponent(encodedPath);
		const button = document.createElement("button");
		button.type = "button";
		button.className = "obsidian-anki-audio-button";
		button.textContent = "Play audio";

		button.addEventListener("click", () => {
			const resolvedUrl = resolveAudioResourceUrl(plugin, audioPath, sourcePath);
			if (!resolvedUrl) {
				button.textContent = "Audio not found";
				return;
			}

			const audio = new Audio(resolvedUrl);
			void audio.play();
		});

		placeholder.replaceWith(button);
	}
}

/**
 * Sanitizes template HTML before insertion.
 */
function sanitizeTemplateFragment(rawHtml: string): DocumentFragment {
	const parser = new DOMParser();
	const parsed = parser.parseFromString(rawHtml, "text/html");
	const fragment = document.createDocumentFragment();

	const blockedTags = ["script", "iframe", "object", "embed", "link", "meta"];
	for (const blockedTag of blockedTags) {
		const nodes = Array.from(parsed.body.querySelectorAll(blockedTag));
		for (const node of nodes) {
			node.remove();
		}
	}

	const allElements = Array.from(parsed.body.querySelectorAll("*"));
	for (const element of allElements) {
		const attributes = Array.from(element.attributes);
		for (const attribute of attributes) {
			const name = attribute.name.toLowerCase();
			const value = attribute.value.trim().toLowerCase();
			if (name.startsWith("on")) {
				element.removeAttribute(attribute.name);
				continue;
			}
			if ((name === "href" || name === "src") && value.startsWith("javascript:")) {
				element.removeAttribute(attribute.name);
			}
		}
	}

	while (parsed.body.firstChild) {
		fragment.appendChild(parsed.body.firstChild);
	}

	return fragment;
}

/**
 * Renders inline warning for invalid blocks.
 */
function renderWarning(el: HTMLElement, errors: string[]): void {
	const warning = el.createDiv({cls: "obsidian-anki-warning"});
	warning.createDiv({
		cls: "obsidian-anki-warning__title",
		text: "Invalid flashcard block",
	});

	const list = warning.createEl("ul", {cls: "obsidian-anki-warning__list"});
	if (errors.length === 0) {
		list.createEl("li", {text: "Unknown flashcard block validation error."});
		return;
	}

	for (const error of errors) {
		list.createEl("li", {text: error});
	}
}

/**
 * Guards plain object-like values.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Converts frontmatter values into stable text for preview.
 */
function toFieldText(value: unknown): string {
	if (typeof value === "string") {
		return value;
	}
	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	if (Array.isArray(value)) {
		return value.map((item) => toFieldText(item)).join(", ");
	}
	if (value === null || value === undefined) {
		return "";
	}

	try {
		return JSON.stringify(value);
	} catch {
		return "[unserializable value]";
	}
}

/**
 * Loads shared note type definitions from markdown files in `Anki/`.
 */
function getAnkiNoteTypeRegistry(plugin: Plugin): Record<string, FlashcardBlockConfig["note_type"]> {
	const registry: Record<string, FlashcardBlockConfig["note_type"]> = {};
	const noteTypeFiles = plugin.app.vault.getMarkdownFiles()
		.filter((file) => file.path.startsWith("Anki/"));

	for (const file of noteTypeFiles) {
		const cache = plugin.app.metadataCache.getFileCache(file);
		const frontmatter = cache?.frontmatter;
		if (!isRecord(frontmatter)) {
			continue;
		}

		const name = typeof frontmatter.name === "string" ? frontmatter.name.trim() : "";
		if (!name) {
			continue;
		}

		const cards = parseSharedTemplateCards(frontmatter.cards);
		const styling = typeof frontmatter.style === "string"
			? frontmatter.style
			: (typeof frontmatter.styling === "string" ? frontmatter.styling : "");

		const fieldsFromFrontmatter = parseStringArray(frontmatter.fields);
		const fields = fieldsFromFrontmatter.length > 0
			? fieldsFromFrontmatter
			: extractFieldsFromCards(cards);

		registry[name] = {
			name,
			fields,
			cards,
			styling,
		};
	}

	return registry;
}

/**
 * Parses card templates from note-type frontmatter.
 */
function parseSharedTemplateCards(value: unknown): FlashcardTemplateConfig[] {
	if (!Array.isArray(value)) {
		return [];
	}

	const cards: FlashcardTemplateConfig[] = [];
	for (const item of value) {
		if (!isRecord(item)) {
			continue;
		}

		const name = typeof item.name === "string" ? item.name.trim() : "";
		const frontTemplate = normalizeTemplateValue(item.front_template);
		const backTemplate = normalizeTemplateValue(item.back_template);
		if (!name || !frontTemplate || !backTemplate) {
			continue;
		}

		cards.push({
			name,
			front_template: frontTemplate,
			back_template: backTemplate,
		});
	}

	return cards;
}

/**
 * Normalizes template values from frontmatter parsing.
 * Accepts YAML parser edge-cases like unquoted `{{field}}`.
 */
function normalizeTemplateValue(value: unknown): string {
	if (typeof value === "string") {
		return value;
	}
	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	if (isRecord(value)) {
		const keys = Object.keys(value);
		if (keys.length === 1) {
			const rawKey = keys[0];
			const fieldName = rawKey ? normalizePlaceholderToken(rawKey) : "";
			const nestedValue = rawKey ? value[rawKey] : undefined;
			if (fieldName && (nestedValue === null || nestedValue === undefined || nestedValue === "")) {
				return `{{${fieldName}}}`;
			}
		}
		try {
			return JSON.stringify(value);
		} catch {
			return "";
		}
	}
	return "";
}

/**
 * Parses a string array value.
 */
function parseStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}

	return value
		.filter((item): item is string => typeof item === "string")
		.map((item) => item.trim())
		.filter((item) => item.length > 0);
}

/**
 * Extracts unique template placeholders as field names.
 */
function extractFieldsFromCards(cards: FlashcardTemplateConfig[]): string[] {
	const uniqueFields = new Set<string>();

	for (const card of cards) {
		const templates = [card.front_template, card.back_template];
		for (const template of templates) {
			const matches = template.matchAll(/{{\s*([^}]+)\s*}}/g);
			for (const match of matches) {
				const token = normalizePlaceholderToken(match[1] ?? "");
				if (!token || token === "FrontSide") {
					continue;
				}
				uniqueFields.add(token);
			}
		}
	}

	return Array.from(uniqueFields);
}

/**
 * Normalizes placeholder tokens to clean field names.
 */
function normalizePlaceholderToken(token: string): string {
	let normalized = token.trim();
	normalized = normalized.replace(/^\{+/, "").replace(/\}+$/, "").trim();
	return normalized;
}

/**
 * Resolves a frontmatter audio value to a playable vault resource URL.
 */
function resolveAudioResourceUrl(plugin: Plugin, value: string, sourcePath: string): string | undefined {
	const cleaned = normalizeAudioLinkValue(value);
	if (!cleaned) {
		return undefined;
	}

	const linked = plugin.app.metadataCache.getFirstLinkpathDest(cleaned, sourcePath);
	if (linked instanceof TFile) {
		return plugin.app.vault.getResourcePath(linked);
	}

	const byPath = plugin.app.vault.getAbstractFileByPath(cleaned);
	if (byPath instanceof TFile) {
		return plugin.app.vault.getResourcePath(byPath);
	}

	return undefined;
}

/**
 * Normalizes wiki-style and markdown-style audio link values.
 */
function normalizeAudioLinkValue(value: string): string {
	let normalized = value.trim();
	if (!normalized) {
		return "";
	}

	normalized = normalized.replace(/^!\[\[/, "").replace(/^\[\[/, "").replace(/\]\]$/, "");
	const markdownLinkMatch = normalized.match(/^\[[^\]]*]\(([^)]+)\)$/);
	if (markdownLinkMatch?.[1]) {
		return markdownLinkMatch[1].trim();
	}

	return normalized.trim();
}

/**
 * Safely decodes URI-encoded placeholder values.
 */
function safeDecodeURIComponent(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}
