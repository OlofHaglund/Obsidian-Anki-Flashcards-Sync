import {App, PluginSettingTab, Setting} from "obsidian";
import ObsidianAnkiPlugin from "./main";

export type SyncScope = "active-file" | "vault" | "folder";

/**
 * User-configurable plugin settings.
 */
export interface ObsidianAnkiPluginSettings {
	ankiConnectUrl: string;
	defaultDeck: string;
	defaultNoteType: string;
	defaultTags: string[];
	autoSync: boolean;
	syncScope: SyncScope;
	syncFolder: string;
}

/**
 * Baseline settings for first run and partial config migrations.
 */
export const DEFAULT_SETTINGS: ObsidianAnkiPluginSettings = {
	ankiConnectUrl: "http://127.0.0.1:8765",
	defaultDeck: "Default",
	defaultNoteType: "Basic",
	defaultTags: ["obsidian"],
	autoSync: false,
	syncScope: "active-file",
	syncFolder: "",
};

/**
 * Settings tab for the plugin.
 */
export class ObsidianAnkiSettingTab extends PluginSettingTab {
	plugin: ObsidianAnkiPlugin;

	constructor(app: App, plugin: ObsidianAnkiPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	/**
	 * Rebuilds settings UI from the current plugin settings state.
	 */
	display(): void {
		const {containerEl} = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("AnkiConnect URL")
			.setDesc("Local AnkiConnect endpoint used for all sync operations.")
			.addText((text) => text
				.setPlaceholder("http://127.0.0.1:8765")
				.setValue(this.plugin.settings.ankiConnectUrl)
				.onChange(async (value) => {
					this.plugin.settings.ankiConnectUrl = value.trim();
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("Default deck")
			.setDesc("Fallback Anki deck when a flashcard block omits a deck.")
			.addText((text) => text
				.setPlaceholder("Default")
				.setValue(this.plugin.settings.defaultDeck)
				.onChange(async (value) => {
					this.plugin.settings.defaultDeck = value.trim();
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("Default note type")
			.setDesc("Fallback Anki note type when a flashcard block omits note_type.")
			.addText((text) => text
				.setPlaceholder("Basic")
				.setValue(this.plugin.settings.defaultNoteType)
				.onChange(async (value) => {
					this.plugin.settings.defaultNoteType = value.trim();
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("Default tags")
			.setDesc("Comma-separated list of tags to apply when syncing notes.")
			.addText((text) => text
				.setPlaceholder("obsidian, flashcard")
				.setValue(this.plugin.settings.defaultTags.join(", "))
				.onChange(async (value) => {
					this.plugin.settings.defaultTags = value
						.split(",")
						.map((tag) => tag.trim())
						.filter((tag) => tag.length > 0);
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("Auto sync")
			.setDesc("Automatically sync flashcards after relevant file changes.")
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.autoSync)
				.onChange(async (value) => {
					this.plugin.settings.autoSync = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("Sync scope")
			.setDesc("Controls which notes are considered during sync.")
			.addDropdown((dropdown) => dropdown
				.addOption("active-file", "Active file")
				.addOption("vault", "Whole vault")
				.addOption("folder", "Specific folder")
				.setValue(this.plugin.settings.syncScope)
				.onChange(async (value: SyncScope) => {
					this.plugin.settings.syncScope = value;
					await this.plugin.saveSettings();
					this.display();
				}));

		if (this.plugin.settings.syncScope === "folder") {
			new Setting(containerEl)
				.setName("Sync folder")
				.setDesc("Vault-relative path used when sync scope is set to folder.")
				.addText((text) => text
					.setPlaceholder("Language/French")
					.setValue(this.plugin.settings.syncFolder)
					.onChange(async (value) => {
						this.plugin.settings.syncFolder = value.trim();
						await this.plugin.saveSettings();
					}));
		}
	}
}
