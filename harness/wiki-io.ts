// Thin wrapper around memory-io for wiki/** paths.
// The allowlist permits wiki/** with the same rules as memory/**.
export {
  SchemaViolation,
  validateFrontmatter,
  parsePage,
  serializePage,
  readMemoryPage as readWikiPage,
  writeMemoryPage as writeWikiPage,
} from './memory-io.js';

export type {
  PageType,
  Tag,
  SourceEntry,
  PageFrontmatter,
  MemoryPage,
} from './memory-io.js';
