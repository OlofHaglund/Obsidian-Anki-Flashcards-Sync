/**
 * Card template configuration under a note type.
 */
export interface FlashcardTemplateConfig {
	name: string;
	front_template: string;
	back_template: string;
}

/**
 * Note type configuration used for rendering and Anki mapping.
 */
export interface FlashcardNoteTypeConfig {
	name: string;
	fields: string[];
	cards: FlashcardTemplateConfig[];
	styling: string;
}

/**
 * YAML config found inside a `flashcard` fenced code block.
 */
export interface FlashcardBlockConfig {
	deck: string;
	note_type: FlashcardNoteTypeConfig;
}

/**
 * Source location metadata for traceability and diagnostics.
 */
export interface FlashcardSourceContext {
	filePath: string;
	blockIndex: number;
	lineStart?: number;
	lineEnd?: number;
}

/**
 * Parsed flashcard block with validation details.
 */
export interface ParsedFlashcardBlock {
	config?: FlashcardBlockConfig;
	errors: string[];
	raw: string;
}

/**
 * Normalized representation of a flashcard note to sync with Anki.
 */
export interface FlashcardNote {
	deck: string;
	noteType: string;
	fields: Record<string, string>;
	tags: string[];
	source: FlashcardSourceContext;
}
