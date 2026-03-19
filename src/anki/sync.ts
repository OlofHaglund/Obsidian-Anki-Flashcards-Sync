import {Plugin, TFile} from "obsidian";
import {AnkiConnectClient} from "./client";
import {parseFlashcardBlock} from "../flashcards/parser";
import {FlashcardBlockConfig, FlashcardTemplateConfig} from "../flashcards/types";
import {ObsidianAnkiPluginSettings} from "../settings";

/**
 * Summary of sync work performed.
 */
export interface SyncSummary {
	created: number;
	updated: number;
	skipped: number;
	failed: number;
	failures: string[];
}

interface FlashcardBlockMatch {
	blockIndex: number;
	source: string;
}

/**
 * Discovers flashcards in the configured scope and syncs them to Anki.
 */
export async function syncFlashcardsFromVault(
	plugin: Plugin,
	client: AnkiConnectClient,
	settings: ObsidianAnkiPluginSettings,
): Promise<SyncSummary> {
	const summary: SyncSummary = {
		created: 0,
		updated: 0,
		skipped: 0,
		failed: 0,
		failures: [],
	};

	const files = getScopeFiles(plugin, settings);
	const noteTypeRegistry = getAnkiNoteTypeRegistry(plugin);
	const ensuredModels = new Set<string>();

	for (const file of files) {
		const markdown = await plugin.app.vault.cachedRead(file);
		const blocks = extractFlashcardBlocks(markdown);
		if (blocks.length === 0) {
			continue;
		}

		const frontmatter = getFrontmatter(plugin, file.path);
		for (const block of blocks) {
			const parsed = parseFlashcardBlock(block.source);
			if (!parsed.config) {
				summary.skipped += 1;
				continue;
			}

			const resolvedNoteType = resolveNoteTypeDefinition(
				parsed.config.note_type,
				noteTypeRegistry,
			);
			if (!resolvedNoteType) {
				summary.skipped += 1;
				continue;
			}

			const fieldResolution = resolveFieldValues(resolvedNoteType.fields, frontmatter);
			if (fieldResolution.errors.length > 0) {
				summary.skipped += 1;
				continue;
			}

			const sourceTag = buildSourceTag(file.path, block.blockIndex, parsed.config.note_type.name);
			const tags = Array.from(new Set([...settings.defaultTags, sourceTag]));
			const deckName = parsed.config.deck || settings.defaultDeck;
			const modelName = resolvedNoteType.name || settings.defaultNoteType;

			try {
				await ensureDeckExists(client, deckName);
				await ensureModelExists(client, modelName, resolvedNoteType, ensuredModels);

				const existingIds = await client.request<{query: string}, number[]>("findNotes", {
					query: `tag:${sourceTag}`,
				});

				if (existingIds.length === 0) {
					await client.request<{note: unknown}, number>("addNote", {
						note: {
							deckName,
							modelName,
							fields: fieldResolution.values,
							tags,
							options: {
								allowDuplicate: true,
							},
						},
					});
					summary.created += 1;
					continue;
				}

				const noteId = existingIds[0];
				if (noteId === undefined) {
					summary.failed += 1;
					continue;
				}
				await client.request<{note: unknown}, null>("updateNoteFields", {
					note: {
						id: noteId,
						fields: fieldResolution.values,
					},
				});

				await client.request<{notes: number[]; tags: string}, null>("addTags", {
					notes: [noteId],
					tags: tags.join(" "),
				});

				summary.updated += 1;
			} catch (error: unknown) {
				summary.failed += 1;
				const message = error instanceof Error ? error.message : "Unknown sync error.";
				const failureMessage = `${file.path} [block ${block.blockIndex + 1}]: ${message}`;
				summary.failures.push(failureMessage);
				console.error("[Obsidian Anki] Flashcard sync failure", {
					file: file.path,
					blockIndex: block.blockIndex,
					error,
				});
			}
		}
	}

	return summary;
}

/**
 * Ensures target deck exists before add/update.
 */
async function ensureDeckExists(client: AnkiConnectClient, deckName: string): Promise<void> {
	await client.request<{deck: string}, null>("createDeck", {
		deck: deckName,
	});
}

/**
 * Ensures note type model exists in Anki; creates it from definition when missing.
 */
async function ensureModelExists(
	client: AnkiConnectClient,
	modelName: string,
	noteType: FlashcardBlockConfig["note_type"],
	ensuredModels: Set<string>,
): Promise<void> {
	if (ensuredModels.has(modelName)) {
		return;
	}

	const existingModels = await client.request<undefined, string[]>("modelNames");
	if (existingModels.includes(modelName)) {
		ensuredModels.add(modelName);
		return;
	}

	const fields = noteType.fields.length > 0 ? noteType.fields : ["Front", "Back"];
	const cardTemplates = buildAnkiCardTemplates(noteType.cards, fields);

	await client.request<{
		modelName: string;
		inOrderFields: string[];
		css: string;
		cardTemplates: Array<{Name: string; Front: string; Back: string}>;
	}, null>("createModel", {
		modelName,
		inOrderFields: fields,
		css: noteType.styling,
		cardTemplates,
	});

	ensuredModels.add(modelName);
}

/**
 * Converts template definitions to AnkiConnect createModel format.
 */
function buildAnkiCardTemplates(
	cards: FlashcardTemplateConfig[],
	fields: string[],
): Array<{Name: string; Front: string; Back: string}> {
	if (cards.length === 0) {
		const frontField = fields[0] ?? "Front";
		const backField = fields[1] ?? fields[0] ?? "Back";
		return [{
			Name: "Card 1",
			Front: `{{${frontField}}}`,
			Back: `{{FrontSide}}<hr id=answer>{{${backField}}}`,
		}];
	}

	return cards.map((card) => ({
		Name: card.name,
		Front: card.front_template,
		Back: card.back_template,
	}));
}

/**
 * Returns markdown files in sync scope.
 */
function getScopeFiles(plugin: Plugin, settings: ObsidianAnkiPluginSettings): TFile[] {
	if (settings.syncScope === "active-file") {
		const activeFile = plugin.app.workspace.getActiveFile();
		return activeFile ? [activeFile] : [];
	}

	const markdownFiles = plugin.app.vault.getMarkdownFiles();
	if (settings.syncScope === "folder") {
		const prefix = settings.syncFolder.trim();
		if (!prefix) {
			return [];
		}
		const normalizedPrefix = prefix.endsWith("/") ? prefix : `${prefix}/`;
		return markdownFiles.filter((file) => file.path.startsWith(normalizedPrefix));
	}

	return markdownFiles;
}

/**
 * Extracts fenced `flashcard` code blocks from markdown.
 */
function extractFlashcardBlocks(markdown: string): FlashcardBlockMatch[] {
	const matches: FlashcardBlockMatch[] = [];
	const regex = /```flashcard[^\n]*\n([\s\S]*?)```/g;
	let blockIndex = 0;

	for (let match = regex.exec(markdown); match !== null; match = regex.exec(markdown)) {
		const source = match[1] ?? "";
		matches.push({
			blockIndex,
			source,
		});
		blockIndex += 1;
	}

	return matches;
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
 * Resolves note type from inline config or shared `Anki/*.md` files.
 */
function resolveNoteTypeDefinition(
	noteType: FlashcardBlockConfig["note_type"],
	registry: Record<string, FlashcardBlockConfig["note_type"]>,
): FlashcardBlockConfig["note_type"] | undefined {
	const hasInlineDefinition = noteType.cards.length > 0 || noteType.styling.length > 0;
	if (hasInlineDefinition) {
		if (noteType.fields.length === 0) {
			return undefined;
		}
		return noteType;
	}

	const definition = registry[noteType.name];
	if (!definition) {
		if (noteType.fields.length > 0) {
			return noteType;
		}
		return undefined;
	}

	const fields = definition.fields.length > 0
		? definition.fields
		: (noteType.fields.length > 0 ? noteType.fields : extractFieldsFromCards(definition.cards));
	if (fields.length === 0) {
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
 * Converts frontmatter values into stable text for note fields.
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
		return String(value);
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
 * Builds a deterministic source tag used to upsert notes.
 */
function buildSourceTag(path: string, blockIndex: number, noteTypeName: string): string {
	const sourceKey = `${path}|${blockIndex}|${noteTypeName}`;
	return `obsidian_anki_src_${hashString(sourceKey)}`;
}

/**
 * Simple deterministic hash for source keys.
 */
function hashString(value: string): string {
	let hash = 2166136261;
	for (let index = 0; index < value.length; index += 1) {
		hash ^= value.charCodeAt(index);
		hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
	}

	return (hash >>> 0).toString(16);
}

/**
 * Guards plain object-like values.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
