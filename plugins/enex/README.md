# ENEX Import

Imports `.enex` export files through Devot's plugin import API (version 3).
Install this folder with Settings > Plugins, enable it, then choose its format under File > Import.
Each file imports into a notebook named after the file, under the notebook currently shown.
Supported images, tags and dates are kept; other attachments and encrypted content are reported as skipped.

Rebuild `main.js` from `source.ts` with `pnpm plugin-enex:build` at the repository root.
The bundle's build-only dependencies are pinned exactly in `package.json` and `pnpm-lock.yaml`, without version ranges.
`saxes` 6.0.0 provides `SaxesParser` for the export's XML and the embedded ENML, including CDATA and entity parsing.
`character-entities` 2.0.2 supplies named XHTML entities to the embedded ENML parser only.
`@noble/hashes` 1.8.0 supplies `md5` over decoded resource bytes and `bytesToHex` to match those resources with `en-media` hashes; MD5 is a resource identifier, not a security check.
No external entities, DTDs or network resources are fetched.
