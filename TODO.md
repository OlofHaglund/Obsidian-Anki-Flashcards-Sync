# 1.0 Release Checklist

## Anki integration hardening

- [ ] Update existing note types when templates/style/fields change (not only create-missing).
- [ ] Add AnkiConnect capability checks for model actions (create/update endpoints).
- [ ] Add fallback behavior when model-update actions are unavailable.
- [ ] Add persistent sync state in plugin data (note IDs + content hash) to reduce tag-only reliance.
- [ ] Define and implement behavior for deck/model renames.

## Data and media handling

- [ ] Define `Audio` sync behavior for Anki media:
  - [ ] copy/upload media to Anki collection when needed
  - [ ] write `[sound:filename]` format in fields for Anki notes
- [ ] Validate outgoing field payload sizes and unsupported value types.
- [ ] Add clearer skip reasons for missing fields and invalid templates in sync summary.

## reliability

- [ ] Add retry/backoff or clearer recovery flow when AnkiConnect is offline.


## Documentation

- [ ] Video demoing the plugin
- [ ] Better documention in the README of how the fields works.
- [ ] Description of the mapping between Anki and Obsidan data.
