import {Plugin, TFile} from "obsidian";
import {AnkiConnectClient} from "./client";
import {parseFlashcardBlock} from "../flashcards/parser";
import {FlashcardBlockConfig, FlashcardTemplateConfig} from "../flashcards/types";
import {ObsidianAnkiPluginSettings, SyncScope} from "../settings";

const SYNC_STATE_STORAGE_KEY = "__syncState";
const SYNC_STATE_VERSION = 1;
const MAX_MEDIA_FILE_BYTES = 100 * 1024 * 1024;
const MAX_FIELD_VALUE_BYTES = 1 * 1024 * 1024;
const MAX_NOTE_FIELD_PAYLOAD_BYTES = 5 * 1024 * 1024;
const UTF8_ENCODER = new TextEncoder();

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

interface PersistedSyncEntry {
	noteId: number;
	contentHash: string;
	modelName: string;
	deckName: string;
	updatedAt: number;
}

interface PersistedSyncState {
	version: number;
	entries: Record<string, PersistedSyncEntry>;
}

interface AnkiNoteInfo {
	fields: Record<string, {value: string}>;
	tags: string[];
	modelName?: string;
}

type RenameAction = "none" | "deck" | "model";

type ModelActionName =
	| "createModel"
	| "modelFieldNames"
	| "modelFieldAdd"
	| "updateModelTemplates"
	| "updateModelStyling";

interface ModelActionCapabilities {
	createModel: boolean;
	modelFieldNames: boolean;
	modelFieldAdd: boolean;
	updateModelTemplates: boolean;
	updateModelStyling: boolean;
}

/**
 * Discovers flashcards in the configured scope and syncs them to Anki.
 * Pass `scopeOverride` to sync a different scope than the configured `settings.syncScope`
 * (e.g. forcing "vault" for a "sync everything" command) without changing the user's setting.
 */
export async function syncFlashcardsFromVault(
	plugin: Plugin,
	client: AnkiConnectClient,
	settings: ObsidianAnkiPluginSettings,
	scopeOverride?: SyncScope,
): Promise<SyncSummary> {
	const summary: SyncSummary = {
		created: 0,
		updated: 0,
		skipped: 0,
		failed: 0,
		failures: [],
	};

	const files = getScopeFiles(plugin, settings, scopeOverride);
	const noteTypeRegistry = getAnkiNoteTypeRegistry(plugin);
	const ensuredModels = new Set<string>();
	const uploadedMedia = new Map<string, string>();
	const modelCapabilities = await detectModelActionCapabilities(client);
	const warnedUnsupportedModelActions = new Set<ModelActionName>();
	const syncState = await loadSyncState(plugin);
	let syncStateDirty = false;

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
				const syncedFieldValues = await resolveFieldsForSync(
					plugin,
					client,
					fieldResolution.values,
					file.path,
					uploadedMedia,
				);
				const payloadSizeErrors = validateFieldPayloadSizes(syncedFieldValues);
				if (payloadSizeErrors.length > 0) {
					summary.skipped += 1;
					continue;
				}

				const contentHash = buildSyncContentHash(
					deckName,
					modelName,
					tags,
					syncedFieldValues,
					resolvedNoteType,
				);

				await ensureDeckExists(client, deckName);
				await ensureModelUpToDate(
							client,
						modelName,
						resolvedNoteType,
						ensuredModels,
					modelCapabilities,
					warnedUnsupportedModelActions,
				);

				const persistedEntry = syncState.entries[sourceTag];
				const persistedNoteId = persistedEntry?.noteId;
				const hasSyncPayloadChanged = persistedEntry?.contentHash !== contentHash;
				if (persistedEntry && persistedNoteId !== undefined) {
					const persistedNoteInfo = await getNoteInfo(client, persistedNoteId);
					if (persistedNoteInfo && persistedEntry.contentHash === contentHash) {
						summary.skipped += 1;
						continue;
					}
				}

				let noteId: number | undefined = persistedNoteId;
				let noteInfo: AnkiNoteInfo | undefined;
				if (noteId !== undefined) {
					noteInfo = await getNoteInfo(client, noteId);
					if (!noteInfo) {
						noteId = undefined;
					}
				}

				if (noteId === undefined) {
					const existingIds = await client.request<{query: string}, number[]>("findNotes", {
						query: `tag:${sourceTag}`,
					});
					noteId = existingIds[0];
					if (noteId !== undefined) {
						noteInfo = await getNoteInfo(client, noteId);
					}
				}

				if (noteId === undefined) {
					await client.request<{note: unknown}, number>("addNote", {
						note: {
							deckName,
							modelName,
							fields: syncedFieldValues,
							tags,
							options: {
								allowDuplicate: true,
							},
						},
					});
					const createdIds = await client.request<{query: string}, number[]>("findNotes", {
						query: `tag:${sourceTag}`,
					});
					const createdId = createdIds[0];
					if (createdId !== undefined) {
						syncState.entries[sourceTag] = {
							noteId: createdId,
							contentHash,
							modelName,
							deckName,
							updatedAt: Date.now(),
						};
						syncStateDirty = true;
					}
					summary.created += 1;
					continue;
				}

				if (!noteInfo) {
					summary.failed += 1;
					continue;
				}

				const renameAction = determineRenameAction(persistedEntry, noteInfo.modelName, deckName, modelName);
				if (renameAction === "model") {
					noteId = await recreateNoteForModelChange(
						client,
						noteId,
						deckName,
						modelName,
						syncedFieldValues,
						tags,
					);
					noteInfo = await getNoteInfo(client, noteId);
					if (!noteInfo) {
						summary.failed += 1;
						continue;
					}
				} else if (renameAction === "deck") {
					await changeNoteDeck(client, noteId, deckName);
				}

				const needsFieldUpdate = hasFieldChanges(noteInfo, syncedFieldValues);
				const missingTags = getMissingTags(noteInfo.tags, tags);

				if (!needsFieldUpdate && missingTags.length === 0) {
					syncState.entries[sourceTag] = {
						noteId,
						contentHash,
						modelName,
						deckName,
						updatedAt: Date.now(),
					};
					syncStateDirty = true;
					if (shouldCountAsUpdated(needsFieldUpdate, missingTags.length, hasSyncPayloadChanged, renameAction)) {
						summary.updated += 1;
					} else {
						summary.skipped += 1;
					}
					continue;
				}

				if (needsFieldUpdate) {
					await client.request<{note: unknown}, null>("updateNoteFields", {
						note: {
							id: noteId,
							fields: syncedFieldValues,
						},
					});
				}

				if (missingTags.length > 0) {
					await client.request<{notes: number[]; tags: string}, null>("addTags", {
						notes: [noteId],
						tags: missingTags.join(" "),
					});
				}

				syncState.entries[sourceTag] = {
					noteId,
					contentHash,
					modelName,
					deckName,
					updatedAt: Date.now(),
				};
				syncStateDirty = true;
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

	if (syncStateDirty) {
		await saveSyncState(plugin, syncState);
	}

	return summary;
}

/**
 * Loads persisted sync state from plugin data.
 */
async function loadSyncState(plugin: Plugin): Promise<PersistedSyncState> {
	const rawData: unknown = await plugin.loadData();
	if (!isRecord(rawData)) {
		return {version: SYNC_STATE_VERSION, entries: {}};
	}

	const rawState = rawData[SYNC_STATE_STORAGE_KEY];
	if (!isRecord(rawState)) {
		return {version: SYNC_STATE_VERSION, entries: {}};
	}

	const entriesNode = rawState.entries;
	if (!isRecord(entriesNode)) {
		return {version: SYNC_STATE_VERSION, entries: {}};
	}

	const entries: Record<string, PersistedSyncEntry> = {};
	for (const [sourceTag, entry] of Object.entries(entriesNode)) {
		if (!isRecord(entry)) {
			continue;
		}
		const noteId = typeof entry.noteId === "number" ? entry.noteId : undefined;
		const contentHash = typeof entry.contentHash === "string" ? entry.contentHash : "";
		const modelName = typeof entry.modelName === "string" ? entry.modelName : "";
		const deckName = typeof entry.deckName === "string" ? entry.deckName : "";
		const updatedAt = typeof entry.updatedAt === "number" ? entry.updatedAt : 0;

		if (noteId === undefined || !contentHash || !modelName || !deckName) {
			continue;
		}

		entries[sourceTag] = {
			noteId,
			contentHash,
			modelName,
			deckName,
			updatedAt,
		};
	}

	return {
		version: typeof rawState.version === "number" ? rawState.version : SYNC_STATE_VERSION,
		entries,
	};
}

/**
 * Persists sync state while preserving existing settings keys.
 */
async function saveSyncState(plugin: Plugin, syncState: PersistedSyncState): Promise<void> {
	const rawData: unknown = await plugin.loadData();
	const payload = isRecord(rawData) ? {...rawData} : {};
	payload[SYNC_STATE_STORAGE_KEY] = syncState;
	await plugin.saveData(payload);
}

/**
 * Resolves field values for sync and uploads linked audio to Anki media when needed.
 */
async function resolveFieldsForSync(
	plugin: Plugin,
	client: AnkiConnectClient,
	fields: Record<string, string>,
	sourcePath: string,
	uploadedMedia: Map<string, string>,
): Promise<Record<string, string>> {
	const resolved: Record<string, string> = {};
	const entries = Object.entries(fields);

	for (const [key, value] of entries) {
		const mediaFileName = await maybeUploadAudioFieldValue(
			plugin,
			client,
			value,
			sourcePath,
			uploadedMedia,
		);
		resolved[key] = mediaFileName ? `[sound:${mediaFileName}]` : value;
	}

	return resolved;
}

/**
 * Uploads audio linked in a field value and returns Anki media filename.
 */
async function maybeUploadAudioFieldValue(
	plugin: Plugin,
	client: AnkiConnectClient,
	value: string,
	sourcePath: string,
	uploadedMedia: Map<string, string>,
): Promise<string | undefined> {
	if (containsAnkiSoundToken(value)) {
		return undefined;
	}

	const cleaned = normalizeAudioLinkValue(value);
	if (!cleaned || !isSupportedAudioPath(cleaned)) {
		return undefined;
	}

	const audioFile = resolveAudioFile(plugin, cleaned, sourcePath);
	if (!(audioFile instanceof TFile)) {
		throw new Error(`Audio file not found: ${value}`);
	}
	const mediaFileBytes = getFileSizeBytes(audioFile);
	if (mediaFileBytes !== undefined && mediaFileBytes > MAX_MEDIA_FILE_BYTES) {
		throw new Error(`Audio file exceeds ${MAX_MEDIA_FILE_BYTES} bytes: ${audioFile.path}`);
	}

	const cachedName = uploadedMedia.get(audioFile.path);
	if (cachedName) {
		return cachedName;
	}

	const binary = await plugin.app.vault.readBinary(audioFile);
	if (binary.byteLength > MAX_MEDIA_FILE_BYTES) {
		throw new Error(`Audio file exceeds ${MAX_MEDIA_FILE_BYTES} bytes: ${audioFile.path}`);
	}
	const mediaName = buildAnkiMediaName(audioFile.path);
	await client.request<{filename: string; data: string}, null>("storeMediaFile", {
		filename: mediaName,
		data: arrayBufferToBase64(binary),
	});

	uploadedMedia.set(audioFile.path, mediaName);
	return mediaName;
}

/**
 * Resolves a vault file from an audio-like link value.
 */
function resolveAudioFile(plugin: Plugin, cleanedValue: string, sourcePath: string): TFile | undefined {
	const linked = plugin.app.metadataCache.getFirstLinkpathDest(cleanedValue, sourcePath);
	if (linked instanceof TFile) {
		return linked;
	}

	const byPath = plugin.app.vault.getAbstractFileByPath(cleanedValue);
	if (byPath instanceof TFile) {
		return byPath;
	}

	return undefined;
}

/**
 * Normalizes wiki-style and markdown-style links to raw path values.
 */
function normalizeAudioLinkValue(value: string): string {
	let normalized = value.trim();
	if (!normalized) {
		return "";
	}

	const wikiMatch = normalized.match(/^!?\[\[([^[\]]+)\]\]$/);
	if (wikiMatch?.[1]) {
		const target = wikiMatch[1].split("|")[0];
		return target ? target.trim() : "";
	}

	const markdownLinkMatch = normalized.match(/^\[[^\]]*]\((.+?)(?:\s+"[^"]*")?\)$/);
	if (markdownLinkMatch?.[1]) {
		return markdownLinkMatch[1].trim();
	}

	return normalized;
}

/**
 * Detects whether a value already contains Anki sound markup.
 */
function containsAnkiSoundToken(value: string): boolean {
	return /\[sound:[^\]]+]/i.test(value);
}

/**
 * Accepts known audio file extensions for media upload.
 */
function isSupportedAudioPath(path: string): boolean {
	const extension = path.split(".").pop()?.toLowerCase();
	if (!extension) {
		return false;
	}

	const supported = new Set([
		"aac",
		"flac",
		"m4a",
		"mp3",
		"ogg",
		"opus",
		"wav",
		"webm",
	]);

	return supported.has(extension);
}

/**
 * Reads file size in bytes when available.
 */
function getFileSizeBytes(file: TFile): number | undefined {
	const sized = file as TFile & {stat?: {size?: number}};
	return typeof sized.stat?.size === "number" ? sized.stat.size : undefined;
}

/**
 * Builds a deterministic media filename to avoid collisions in Anki media.
 */
function buildAnkiMediaName(filePath: string): string {
	const extension = filePath.split(".").pop()?.toLowerCase() ?? "dat";
	const withNoExt = filePath.replace(/\.[^.]+$/, "");
	const baseName = withNoExt.split("/").pop() ?? "audio";
	const safeBase = baseName.replace(/[^A-Za-z0-9._-]/g, "_");
	const hash = createStableHash(filePath);
	return `obsidian-anki-${safeBase}-${hash}.${extension}`;
}

/**
 * Converts binary payload into base64 for AnkiConnect storeMediaFile.
 */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	const chunkSize = 0x8000;
	let binary = "";

	for (let index = 0; index < bytes.length; index += chunkSize) {
		const chunk = bytes.subarray(index, index + chunkSize);
		binary += String.fromCharCode(...chunk);
	}

	return btoa(binary);
}

/**
 * Small deterministic hash for stable media names.
 */
function createStableHash(value: string): string {
	let hash = 2166136261;
	for (let index = 0; index < value.length; index += 1) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}

	return (hash >>> 0).toString(16);
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
 * Ensures note type model exists and syncs its mutable schema when already present.
 */
async function ensureModelUpToDate(
	client: AnkiConnectClient,
	modelName: string,
	noteType: FlashcardBlockConfig["note_type"],
	ensuredModels: Set<string>,
	modelCapabilities: ModelActionCapabilities,
	warnedUnsupportedModelActions: Set<ModelActionName>,
): Promise<void> {
	if (ensuredModels.has(modelName)) {
		return;
	}

	const existingModels = await client.request<undefined, string[]>("modelNames");
	if (existingModels.includes(modelName)) {
		await updateExistingModel(
			client,
			modelName,
			noteType,
			modelCapabilities,
			warnedUnsupportedModelActions,
		);
		ensuredModels.add(modelName);
		return;
	}

	const fields = noteType.fields.length > 0 ? noteType.fields : ["Front", "Back"];
	const cardTemplates = buildAnkiCardTemplates(noteType.cards, fields);

	await requestModelAction<{
		modelName: string;
		inOrderFields: string[];
		css: string;
		cardTemplates: Array<{Name: string; Front: string; Back: string}>;
	}, null>("createModel", {
		modelName,
		inOrderFields: fields,
		css: noteType.styling,
		cardTemplates,
	}, client, modelCapabilities);

	ensuredModels.add(modelName);
}

/**
 * Updates mutable model pieces for an existing Anki note type.
 */
async function updateExistingModel(
	client: AnkiConnectClient,
	modelName: string,
	noteType: FlashcardBlockConfig["note_type"],
	modelCapabilities: ModelActionCapabilities,
	warnedUnsupportedModelActions: Set<ModelActionName>,
): Promise<void> {
	const fields = noteType.fields.length > 0 ? noteType.fields : ["Front", "Back"];
	await ensureModelFields(client, modelName, fields, modelCapabilities, warnedUnsupportedModelActions);

	const templates = buildAnkiCardTemplates(noteType.cards, fields);
	await updateModelTemplates(
		client,
		modelName,
		templates,
		modelCapabilities,
		warnedUnsupportedModelActions,
	);
	await updateModelStyling(
		client,
		modelName,
		noteType.styling,
		modelCapabilities,
		warnedUnsupportedModelActions,
	);
}

/**
 * Adds missing fields to an existing model while preserving existing field order/data.
 */
async function ensureModelFields(
	client: AnkiConnectClient,
	modelName: string,
	desiredFields: string[],
	modelCapabilities: ModelActionCapabilities,
	warnedUnsupportedModelActions: Set<ModelActionName>,
): Promise<void> {
	const existingFields = await requestModelActionOptional<{modelName: string}, string[]>("modelFieldNames", {
		modelName,
	}, client, modelCapabilities, warnedUnsupportedModelActions);
	if (!existingFields) {
		return;
	}

	const existing = new Set(existingFields);
	for (const fieldName of desiredFields) {
		if (existing.has(fieldName)) {
			continue;
		}

		const added = await requestModelActionOptional<{modelName: string; fieldName: string}, null>("modelFieldAdd", {
			modelName,
			fieldName,
		}, client, modelCapabilities, warnedUnsupportedModelActions);
		if (added === undefined) {
			return;
		}
		existing.add(fieldName);
	}
}

/**
 * Updates all card templates for an existing model by name.
 */
async function updateModelTemplates(
	client: AnkiConnectClient,
	modelName: string,
	templates: Array<{Name: string; Front: string; Back: string}>,
	modelCapabilities: ModelActionCapabilities,
	warnedUnsupportedModelActions: Set<ModelActionName>,
): Promise<void> {
	const byName: Record<string, {Front: string; Back: string}> = {};
	for (const template of templates) {
		byName[template.Name] = {
			Front: template.Front,
			Back: template.Back,
		};
	}

	await requestModelActionOptional<{
		model: {
			name: string;
			templates: Record<string, {Front: string; Back: string}>;
		};
	}, null>("updateModelTemplates", {
		model: {
			name: modelName,
			templates: byName,
		},
	}, client, modelCapabilities, warnedUnsupportedModelActions);
}

/**
 * Updates CSS styling for an existing model.
 */
async function updateModelStyling(
	client: AnkiConnectClient,
	modelName: string,
	css: string,
	modelCapabilities: ModelActionCapabilities,
	warnedUnsupportedModelActions: Set<ModelActionName>,
): Promise<void> {
	await requestModelActionOptional<{
		model: {
			name: string;
			css: string;
		};
	}, null>("updateModelStyling", {
		model: {
			name: modelName,
			css,
		},
	}, client, modelCapabilities, warnedUnsupportedModelActions);
}

/**
 * Detects whether model-related actions are supported by the connected AnkiConnect instance.
 */
async function detectModelActionCapabilities(client: AnkiConnectClient): Promise<ModelActionCapabilities> {
	await client.request<undefined, number>("version");

	return {
		createModel: true,
		modelFieldNames: await probeModelAction(client, "modelFieldNames", {
			modelName: "__obsidian_anki_probe__",
		}),
		modelFieldAdd: await probeModelAction(client, "modelFieldAdd", {
			modelName: "__obsidian_anki_probe__",
			fieldName: "__probe_field__",
		}),
		updateModelTemplates: await probeModelAction(client, "updateModelTemplates", {
			model: {
				name: "__obsidian_anki_probe__",
				templates: {},
			},
		}),
		updateModelStyling: await probeModelAction(client, "updateModelStyling", {
			model: {
				name: "__obsidian_anki_probe__",
				css: "",
			},
		}),
	};
}

/**
 * Probes whether an AnkiConnect action exists without requiring successful semantics.
 */
async function probeModelAction<TParams>(
	client: AnkiConnectClient,
	action: ModelActionName,
	params: TParams,
): Promise<boolean> {
	try {
		await client.request<TParams, unknown>(action, params);
		return true;
	} catch (error: unknown) {
		return !isUnsupportedActionError(error);
	}
}

/**
 * Executes model actions with capability gating and clear unsupported-endpoint errors.
 */
async function requestModelAction<TParams, TResult>(
	action: ModelActionName,
	params: TParams,
	client: AnkiConnectClient,
	capabilities: ModelActionCapabilities,
): Promise<TResult> {
	if (!capabilities[action]) {
		throw new Error(`AnkiConnect does not support required action: ${action}`);
	}

	try {
		return await client.request<TParams, TResult>(action, params);
	} catch (error: unknown) {
		if (isUnsupportedActionError(error)) {
			capabilities[action] = false;
			throw new Error(`AnkiConnect does not support required action: ${action}`);
		}
		throw error;
	}
}

/**
 * Executes model actions in best-effort mode and falls back when unsupported.
 */
async function requestModelActionOptional<TParams, TResult>(
	action: ModelActionName,
	params: TParams,
	client: AnkiConnectClient,
	capabilities: ModelActionCapabilities,
	warnedActions: Set<ModelActionName>,
): Promise<TResult | undefined> {
	if (!capabilities[action]) {
		warnUnsupportedModelAction(action, warnedActions);
		return undefined;
	}

	try {
		return await client.request<TParams, TResult>(action, params);
	} catch (error: unknown) {
		if (isUnsupportedActionError(error)) {
			capabilities[action] = false;
			warnUnsupportedModelAction(action, warnedActions);
			return undefined;
		}
		throw error;
	}
}

/**
 * Identifies unsupported-action errors returned by AnkiConnect.
 */
function isUnsupportedActionError(error: unknown): boolean {
	if (!(error instanceof Error)) {
		return false;
	}

	return /unsupported action|unknown action/i.test(error.message);
}

/**
 * Emits one warning per unsupported model action during a sync run.
 */
function warnUnsupportedModelAction(action: ModelActionName, warnedActions: Set<ModelActionName>): void {
	if (warnedActions.has(action)) {
		return;
	}

	warnedActions.add(action);
	console.warn(`[Obsidian Anki] Falling back: AnkiConnect action not supported: ${action}`);
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
function getScopeFiles(plugin: Plugin, settings: ObsidianAnkiPluginSettings, scopeOverride?: SyncScope): TFile[] {
	const scope = scopeOverride ?? settings.syncScope;

	if (scope === "active-file") {
		const activeFile = plugin.app.workspace.getActiveFile();
		return activeFile ? [activeFile] : [];
	}

	const markdownFiles = plugin.app.vault.getMarkdownFiles();
	if (scope === "folder") {
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
		const fieldResult = toFieldTextResult(value);
		if (fieldResult.error) {
			errors.push(`Unsupported value for key ${key}: ${fieldResult.error}`);
			continue;
		}
		values[key] = fieldResult.text;
	}

	return {values, errors};
}

/**
 * Converts frontmatter values into stable text for note fields.
 */
function toFieldTextResult(value: unknown): {text: string; error?: undefined} | {text: ""; error: string} {
	if (typeof value === "string") {
		return {text: value};
	}
	if (typeof value === "number" || typeof value === "boolean") {
		return {text: String(value)};
	}
	if (Array.isArray(value)) {
		const parts: string[] = [];
		for (const item of value) {
			const result = toFieldTextResult(item);
			if (result.error) {
				return result;
			}
			parts.push(result.text);
		}
		return {text: parts.join(", ")};
	}
	if (value === null || value === undefined) {
		return {text: ""};
	}
	if (typeof value === "bigint" || typeof value === "function" || typeof value === "symbol") {
		return {text: "", error: `type '${typeof value}' is not supported`};
	}

	try {
		const serialized = JSON.stringify(value);
		if (serialized === undefined) {
			return {text: "", error: "value cannot be serialized"};
		}
		return {text: serialized};
	} catch {
		return {text: "", error: "value cannot be serialized"};
	}
}

/**
 * Validates outgoing field payload sizes in bytes.
 */
function validateFieldPayloadSizes(
	fields: Record<string, string>,
	limits: {maxFieldBytes: number; maxTotalBytes: number} = {
		maxFieldBytes: MAX_FIELD_VALUE_BYTES,
		maxTotalBytes: MAX_NOTE_FIELD_PAYLOAD_BYTES,
	},
): string[] {
	const errors: string[] = [];
	let totalBytes = 0;

	for (const [field, value] of Object.entries(fields)) {
		const bytes = utf8ByteLength(value);
		totalBytes += bytes;
		if (bytes > limits.maxFieldBytes) {
			errors.push(`Field '${field}' exceeds ${limits.maxFieldBytes} bytes.`);
		}
	}

	if (totalBytes > limits.maxTotalBytes) {
		errors.push(`Total field payload exceeds ${limits.maxTotalBytes} bytes.`);
	}

	return errors;
}

/**
 * Returns UTF-8 byte length of a string.
 */
function utf8ByteLength(value: string): number {
	return UTF8_ENCODER.encode(value).byteLength;
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

/**
 * Compares desired fields against current Anki note fields.
 */
function hasFieldChanges(noteInfo: AnkiNoteInfo, desiredFields: Record<string, string>): boolean {
	const entries = Object.entries(desiredFields);
	for (const [field, desiredValue] of entries) {
		const currentValue = noteInfo.fields[field]?.value ?? "";
		if (currentValue !== desiredValue) {
			return true;
		}
	}

	return false;
}

/**
 * Returns tags that are not currently present on the note.
 */
function getMissingTags(existingTags: string[], desiredTags: string[]): string[] {
	const existing = new Set(existingTags);
	return desiredTags.filter((tag) => !existing.has(tag));
}

/**
 * Determines whether a sync block should be reported as updated.
 */
function shouldCountAsUpdated(
	needsFieldUpdate: boolean,
	missingTagCount: number,
	hasSyncPayloadChanged: boolean,
	renameAction: RenameAction,
): boolean {
	return renameAction !== "none" || needsFieldUpdate || missingTagCount > 0 || hasSyncPayloadChanged;
}

/**
 * Determines if deck/model was renamed between persisted and desired sync state.
 */
function determineRenameAction(
	persistedEntry: PersistedSyncEntry | undefined,
	currentModelName: string | undefined,
	desiredDeckName: string,
	desiredModelName: string,
): RenameAction {
	const modelRenamed = (persistedEntry?.modelName !== undefined && persistedEntry.modelName !== desiredModelName)
		|| (currentModelName !== undefined && currentModelName !== desiredModelName);
	if (modelRenamed) {
		return "model";
	}

	const deckRenamed = persistedEntry?.deckName !== undefined && persistedEntry.deckName !== desiredDeckName;
	if (deckRenamed) {
		return "deck";
	}

	return "none";
}

/**
 * Moves a note to a different deck.
 */
async function changeNoteDeck(client: AnkiConnectClient, noteId: number, deckName: string): Promise<void> {
	await client.request<{notes: number[]; deck: string}, null>("changeDeck", {
		notes: [noteId],
		deck: deckName,
	});
}

/**
 * Recreates a note for model rename and removes the old note.
 */
async function recreateNoteForModelChange(
	client: AnkiConnectClient,
	noteId: number,
	deckName: string,
	modelName: string,
	fields: Record<string, string>,
	tags: string[],
): Promise<number> {
	const newNoteId = await client.request<{note: unknown}, number>("addNote", {
		note: {
			deckName,
			modelName,
			fields,
			tags,
			options: {
				allowDuplicate: true,
			},
		},
	});

	await client.request<{notes: number[]}, null>("deleteNotes", {
		notes: [noteId],
	});

	return newNoteId;
}

/**
 * Retrieves note info for one note ID.
 */
async function getNoteInfo(client: AnkiConnectClient, noteId: number): Promise<AnkiNoteInfo | undefined> {
	const notesInfo = await client.request<{notes: number[]}, AnkiNoteInfo[]>("notesInfo", {
		notes: [noteId],
	});

	return notesInfo[0];
}

/**
 * Builds deterministic hash input for sync-state change detection.
 */
function buildSyncContentHash(
	deckName: string,
	modelName: string,
	tags: string[],
	fields: Record<string, string>,
	noteType: FlashcardBlockConfig["note_type"],
): string {
	const sortedFieldEntries = Object.entries(fields)
		.sort(([left], [right]) => left.localeCompare(right));
	const sortedTagList = [...tags].sort((left, right) => left.localeCompare(right));
	const payload = {
		deckName,
		modelName,
		fields: sortedFieldEntries,
		tags: sortedTagList,
		noteType: {
			name: noteType.name,
			fields: [...noteType.fields],
			styling: noteType.styling,
			cards: noteType.cards.map((card) => ({
				name: card.name,
				front_template: card.front_template,
				back_template: card.back_template,
			})),
		},
	};

	return hashString(JSON.stringify(payload));
}

/**
 * Test-only exports for pure helper coverage.
 */
export const __syncTestables = {
	buildSyncContentHash,
	buildAnkiCardTemplates,
	buildAnkiMediaName,
	buildSourceTag,
	containsAnkiSoundToken,
	createStableHash,
	determineRenameAction,
	extractFlashcardBlocks,
	getMissingTags,
	getFileSizeBytes,
	hasFieldChanges,
	isSupportedAudioPath,
	normalizeAudioLinkValue,
	resolveNoteTypeDefinition,
	shouldCountAsUpdated,
	toFieldTextResult,
	validateFieldPayloadSizes,
};
