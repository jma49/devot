# ENEX Import

Imports `.enex` export files through Devot's plugin import API (version 3).
Install this folder with Settings > Plugins, enable it, then choose its format under File > Import.
Each file imports into a notebook named after the file, under the notebook currently shown.
Supported images, tags and dates are kept; other attachments and encrypted content are reported as skipped.

Rebuild `main.js` from `source.ts` with `pnpm plugin-enex:build` at the repository root.
The browser bundle includes saxes 6.0.0 for XML, character-entities 2.0.2 for XHTML entities, and @noble/hashes 1.8.0 for resource MD5 hashes.
No external entities, DTDs or network resources are fetched.
