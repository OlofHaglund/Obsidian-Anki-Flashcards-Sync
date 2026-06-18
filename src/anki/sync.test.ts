import {describe, expect, it} from "vitest";
import {__syncTestables} from "./sync";

describe("sync helpers", () => {
	it("normalizes wiki links and markdown links to raw audio path", () => {
		expect(__syncTestables.normalizeAudioLinkValue("[[ca-va.wav]]")).toBe("ca-va.wav");
		expect(__syncTestables.normalizeAudioLinkValue("![[Audio/ca-va.wav|Play]]")).toBe("Audio/ca-va.wav");
		expect(__syncTestables.normalizeAudioLinkValue("[Play](Audio/ca va.wav \"title\")")).toBe("Audio/ca va.wav");
	});

	it("detects existing Anki sound tokens", () => {
		expect(__syncTestables.containsAnkiSoundToken("[sound:ca-va.wav]")).toBe(true);
		expect(__syncTestables.containsAnkiSoundToken("[SOUND:ca-va.wav]")).toBe(true);
		expect(__syncTestables.containsAnkiSoundToken("ca-va.wav")).toBe(false);
	});

	it("accepts supported audio extensions", () => {
		expect(__syncTestables.isSupportedAudioPath("x.wav")).toBe(true);
		expect(__syncTestables.isSupportedAudioPath("x.MP3")).toBe(true);
		expect(__syncTestables.isSupportedAudioPath("x.txt")).toBe(false);
	});

	it("builds deterministic media file names", () => {
		const first = __syncTestables.buildAnkiMediaName("Audio/ca va.wav");
		const second = __syncTestables.buildAnkiMediaName("Audio/ca va.wav");
		const other = __syncTestables.buildAnkiMediaName("Audio/autre.wav");

		expect(first).toBe(second);
		expect(first).toMatch(/^obsidian-anki-ca_va-[0-9a-f]+\.wav$/);
		expect(other).not.toBe(first);
	});

	it("builds default card template when cards are missing", () => {
		expect(__syncTestables.buildAnkiCardTemplates([], ["Front", "Back"])).toEqual([
			{
				Name: "Card 1",
				Front: "{{Front}}",
				Back: "{{FrontSide}}<hr id=answer>{{Back}}",
			},
		]);
	});

	it("extracts flashcard blocks with stable indices", () => {
		const markdown = [
			"Some text",
			"```flashcard",
			"deck: A",
			"```",
			"",
			"```flashcard",
			"deck: B",
			"```",
		].join("\n");

		const blocks = __syncTestables.extractFlashcardBlocks(markdown);
		expect(blocks).toHaveLength(2);
		expect(blocks[0]?.blockIndex).toBe(0);
		expect(blocks[1]?.blockIndex).toBe(1);
		expect(blocks[0]?.source).toContain("deck: A");
		expect(blocks[1]?.source).toContain("deck: B");
	});

	it("detects field changes only when values differ", () => {
		const unchanged = __syncTestables.hasFieldChanges({
			fields: {
				front: {value: "Bonjour"},
				back: {value: "Hello"},
			},
			tags: [],
		}, {
			front: "Bonjour",
			back: "Hello",
		});

		const changed = __syncTestables.hasFieldChanges({
			fields: {
				front: {value: "Bonjour"},
				back: {value: "Hello"},
			},
			tags: [],
		}, {
			front: "Bonjour",
			back: "Hi",
		});

		expect(unchanged).toBe(false);
		expect(changed).toBe(true);
	});

	it("computes missing tags", () => {
		const missing = __syncTestables.getMissingTags(
			["obsidian", "synced"],
			["obsidian", "synced", "new-tag"],
		);
		expect(missing).toEqual(["new-tag"]);
	});

	it("builds stable content hashes regardless of tag/field order", () => {
		const noteType = {
			name: "Basic",
			fields: ["front", "back"],
			styling: ".card {}",
			cards: [{
				name: "Card 1",
				front_template: "{{front}}",
				back_template: "{{FrontSide}}<hr id=answer>{{back}}",
			}],
		};

		const first = __syncTestables.buildSyncContentHash(
			"Deck",
			"Basic",
			["tag-b", "tag-a"],
			{
				back: "Hello",
				front: "Bonjour",
			},
			noteType,
		);
		const second = __syncTestables.buildSyncContentHash(
			"Deck",
			"Basic",
			["tag-a", "tag-b"],
			{
				front: "Bonjour",
				back: "Hello",
			},
			noteType,
		);
		const changed = __syncTestables.buildSyncContentHash(
			"Deck",
			"Basic",
			["tag-a", "tag-b"],
			{
				front: "Salut",
				back: "Hello",
			},
			noteType,
		);

		expect(first).toBe(second);
		expect(changed).not.toBe(first);
	});

	it("counts as updated when sync payload changed even without field or tag deltas", () => {
		expect(__syncTestables.shouldCountAsUpdated(false, 0, true, "none")).toBe(true);
		expect(__syncTestables.shouldCountAsUpdated(false, 0, false, "none")).toBe(false);
		expect(__syncTestables.shouldCountAsUpdated(false, 0, false, "deck")).toBe(true);
		expect(__syncTestables.shouldCountAsUpdated(false, 0, false, "model")).toBe(true);
	});

	it("detects deck/model rename actions from persisted state", () => {
		const persisted = {
			noteId: 42,
			contentHash: "abc",
			modelName: "Old model",
			deckName: "Old deck",
			updatedAt: 1,
		};

		expect(__syncTestables.determineRenameAction(persisted, "Old model", "New deck", "Old model")).toBe("deck");
		expect(__syncTestables.determineRenameAction(persisted, "Old model", "Old deck", "New model")).toBe("model");
		expect(__syncTestables.determineRenameAction(undefined, "Basic", "Deck", "Basic")).toBe("none");
	});

	it("rejects unsupported field value types", () => {
		const unsupported = __syncTestables.toFieldTextResult(Symbol("audio"));
		const supported = __syncTestables.toFieldTextResult(["a", 1, true]);

		expect(unsupported.error).toContain("not supported");
		expect(supported).toEqual({text: "a, 1, true"});
	});

	it("validates per-field and total payload byte limits", () => {
		const fieldTooLarge = __syncTestables.validateFieldPayloadSizes(
			{front: "abcde"},
			{maxFieldBytes: 4, maxTotalBytes: 10},
		);
		const totalTooLarge = __syncTestables.validateFieldPayloadSizes(
			{front: "abc", back: "def"},
			{maxFieldBytes: 10, maxTotalBytes: 5},
		);
		const valid = __syncTestables.validateFieldPayloadSizes(
			{front: "abc", back: "de"},
			{maxFieldBytes: 10, maxTotalBytes: 10},
		);

		expect(fieldTooLarge[0]).toContain("front");
		expect(totalTooLarge[0]).toContain("Total field payload");
		expect(valid).toEqual([]);
	});
});
