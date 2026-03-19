import {parseYaml} from "obsidian";
import {FlashcardBlockConfig, FlashcardNoteTypeConfig, FlashcardTemplateConfig, ParsedFlashcardBlock} from "./types";

const DEFAULT_NOTE_TYPE_NAME = "Basic";

/**
 * Parses and validates a raw `flashcard` code block as YAML.
 */
export function parseFlashcardBlock(raw: string): ParsedFlashcardBlock {
	const result: ParsedFlashcardBlock = {
		errors: [],
		raw,
	};

	const trimmed = raw.trim();
	if (trimmed.length === 0) {
		result.errors.push("Flashcard block is empty.");
		return result;
	}

	let parsedYaml: unknown;
	try {
		parsedYaml = parseYaml(raw);
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : "Unknown YAML parse error.";
		result.errors.push(`Invalid YAML: ${message}`);
		return result;
	}

	if (!isRecord(parsedYaml)) {
		result.errors.push("Flashcard block must be a YAML object.");
		return result;
	}

	const deck = getRequiredString(parsedYaml.deck);
	if (!deck) {
		result.errors.push("Missing required key: deck (string).");
	}

	const noteType = parseNoteTypeConfig(parsedYaml, result.errors);
	if (!noteType) {
		return result;
	}

	if (result.errors.length > 0) {
		return result;
	}

	result.config = {
		deck,
		note_type: noteType,
	} satisfies FlashcardBlockConfig;

	return result;
}

/**
 * Parses `note_type` as either legacy string or object config.
 */
function parseNoteTypeConfig(
	yaml: Record<string, unknown>,
	errors: string[],
): FlashcardNoteTypeConfig | undefined {
	const noteTypeNode = yaml.note_type;
	const legacyFields = getStringArray(yaml.fields);
	const legacyStyling = getOptionalString(yaml.styling);
	const legacyCards = parseCards(yaml.cards, errors, "cards");

	if (typeof noteTypeNode === "string") {
		const name = noteTypeNode.trim();
		if (!name) {
			errors.push("note_type must be a non-empty string when using legacy format.");
			return undefined;
		}

		return {
			name,
			fields: legacyFields,
			cards: legacyCards,
			styling: legacyStyling,
		};
	}

	if (noteTypeNode === undefined || noteTypeNode === null) {
		if (legacyFields.length === 0) {
			errors.push("Missing note_type config and fields for default fallback.");
			return undefined;
		}

		return {
			name: DEFAULT_NOTE_TYPE_NAME,
			fields: legacyFields,
			cards: legacyCards,
			styling: legacyStyling,
		};
	}

	if (!isRecord(noteTypeNode)) {
		errors.push("note_type must be either a string or object.");
		return undefined;
	}

	const name = getRequiredString(noteTypeNode.name);
	const fields = getStringArray(noteTypeNode.fields);
	const cards = parseCards(noteTypeNode.cards, errors, "note_type.cards");
	const styling = getOptionalString(noteTypeNode.styling) || getOptionalString(noteTypeNode.style);

	if (!name) {
		errors.push("Missing required key: note_type.name (string).");
	}
	if (fields.length === 0) {
		errors.push("Missing required key: note_type.fields (non-empty string array).");
	}

	if (errors.length > 0) {
		return undefined;
	}

	return {
		name,
		fields,
		cards,
		styling,
	};
}

/**
 * Parses card template list.
 */
function parseCards(
	value: unknown,
	errors: string[],
	path: string,
): FlashcardTemplateConfig[] {
	if (value === undefined || value === null) {
		return [];
	}

	if (!Array.isArray(value)) {
		errors.push(`${path} must be an array when provided.`);
		return [];
	}

	const cards: FlashcardTemplateConfig[] = [];
	for (let index = 0; index < value.length; index += 1) {
		const node = value[index];
		if (!isRecord(node)) {
			errors.push(`${path}[${index}] must be an object.`);
			continue;
		}

		const name = getRequiredString(node.name);
		const frontTemplate = getRequiredString(node.front_template);
		const backTemplate = getRequiredString(node.back_template);

		if (!name) {
			errors.push(`${path}[${index}].name must be a non-empty string.`);
		}
		if (!frontTemplate) {
			errors.push(`${path}[${index}].front_template must be a non-empty string.`);
		}
		if (!backTemplate) {
			errors.push(`${path}[${index}].back_template must be a non-empty string.`);
		}

		if (name && frontTemplate && backTemplate) {
			cards.push({
				name,
				front_template: frontTemplate,
				back_template: backTemplate,
			});
		}
	}

	return cards;
}

/**
 * Guards plain object-like YAML nodes.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Returns a trimmed string for required scalar values.
 */
function getRequiredString(value: unknown): string {
	if (typeof value !== "string") {
		return "";
	}

	return value.trim();
}

/**
 * Returns optional string or empty string.
 */
function getOptionalString(value: unknown): string {
	if (typeof value !== "string") {
		return "";
	}

	return value;
}

/**
 * Returns a normalized list of trimmed non-empty strings.
 */
function getStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}

	const normalized = value
		.filter((entry): entry is string => typeof entry === "string")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);

	if (normalized.length !== value.length) {
		return [];
	}

	return normalized;
}
