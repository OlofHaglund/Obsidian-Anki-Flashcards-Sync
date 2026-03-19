# Obsidian Anki

**NOTE:** This is an early version and released early to catch hiccups in the distribution flow. 

Obsidian plugin that renders `flashcard` code blocks as card previews and syncs them to Anki through AnkiConnect.

## What it does

- Renders `flashcard` code blocks in Reading view and Live Preview.
- Loads note type/card template definitions from markdown files in `Anki/`.
- Uses note frontmatter as card field values.
- Renders one preview card per card template with a front/back toggle.
- Replaces `{{Audio}}` in preview with a play button that plays the referenced vault audio file.
- Syncs flashcards to Anki (create/update) using a deterministic source tag per block.
- Auto-creates missing decks and missing note types in Anki.

## Requirements

- Obsidian desktop.
- [Anki](https://apps.ankiweb.net/) desktop.
- [AnkiConnect](https://ankiweb.net/shared/info/2055492159) enabled in Anki (default endpoint: `http://127.0.0.1:8765`).

## Note type definitions (`Anki/` folder)

Create one markdown file per note type under `Anki/`.
Only frontmatter is used.

Example: `Anki/French Sentence.md`

```md
---
name: French Sentence
cards:
  - name: With Sound Cue
    front_template: |
      {{french}}
      <br>
      {{Audio}}
    back_template: |
      {{FrontSide}}
      <hr>
      {{english}}
  - name: Without Sound Cue
    front_template: "{{french}}"
    back_template: |
      {{FrontSide}}
      <br>
      {{Audio}}
      <hr>
      {{english}}
style: |
  .card {
    font-family: Arial;
    font-size: 20px;
    text-align: center;
  }
---
# French Sentence
This text is not read and can be used a comment to the note .
```

Notes:
- Quote single-line template values when using `{{...}}` on one line.
- `style` and `styling` are both accepted.
- If `fields` is omitted, fields are inferred from template placeholders.

## Flashcard block format

Put flashcards in normal notes using fenced code blocks:

```flashcard
deck: French::Sentences
note_type: French Sentence
fields:
- french
- english
- Audio
```

Meaning:
- `deck`: target Anki deck (`::` supports subdecks).
- `note_type`: note type name matching `Anki/*.md` `name`.
- `fields`: frontmatter keys for this note. If omitted, inferred from the note type templates.

## Field values from frontmatter

Values are read from the note's frontmatter.

Example note:

```md
---
french: Ça va
english: How are you?
Audio: [[ca-va.wav]]
---
```

`Audio` supports:
- `[[file.wav]]`
- `![[file.wav]]`
- `[label](file.wav)`
- direct vault path (`French/Sound Files/file.wav`)

## Sync behavior

Command: `Sync flashcards to Anki`

Per flashcard block:
- Resolves note type from `Anki/*.md`.
- Validates required fields exist in note frontmatter.
- Ensures deck exists.
- Ensures note type exists (creates if missing).
- Finds existing note by deterministic source tag.
- Creates or updates note fields and tags.

## Settings

- `AnkiConnect URL`
- `Default deck`
- `Default note type`
- `Default tags`
- `Auto sync` (currently config only)
- `Sync scope` (`active-file`, `vault`, `folder`)
- `Sync folder` (when scope is `folder`)

## Troubleshooting

- `Missing frontmatter key`: add the key to the source note frontmatter or adjust `fields`.
- Audio button says `Audio not found`: verify the file exists in the vault and link/path is valid.
- If sync fails, the popup shows the first error and console logs detailed failures.

## Security and privacy

- Preview HTML is sanitized before rendering.
- Network calls are only made to the configured AnkiConnect URL.
- Data sent to Anki is limited to resolved card fields, deck/model names, and tags for sync.

## Development

```bash
npm install
npm run dev
npm run build
```
