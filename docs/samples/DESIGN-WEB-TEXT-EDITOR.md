# Design: Web-Based Text Editor

## Overview

A modern, browser-based rich text editor built with React, TypeScript, and Tiptap (ProseMirror). Supports Markdown as the primary document format, multi-tab editing, local persistence, and a clean distraction-free UI.

## Goals

- Fast, responsive editing experience for documents and notes
- First-class Markdown support (import, export, live preview)
- Rich text formatting via toolbar and keyboard shortcuts
- Multi-document tab management
- Offline-capable with auto-save to IndexedDB
- Code block syntax highlighting
- Search and replace across document content
- Accessible, keyboard-driven workflow

## Non-Goals (v1)

- Real-time collaboration / multiplayer editing
- Server-side storage or user authentication
- Plugin/extension system
- PDF or DOCX export
- Mobile-optimized layout

## Architecture

```
┌─────────────────────────────────────────────────┐
│                   App Shell                      │
│  ┌───────────────────────────────────────────┐  │
│  │              Tab Bar                       │  │
│  │  [Doc1.md ×] [Doc2.md ×] [+]              │  │
│  ├───────────────────────────────────────────┤  │
│  │           Formatting Toolbar               │  │
│  │  B  I  U  H1 H2  •  1.  ""  <>  ─  🔗    │  │
│  ├───────────────────────────────────────────┤  │
│  │                                           │  │
│  │           Tiptap Editor Canvas            │  │
│  │                                           │  │
│  │   Content area with ProseMirror under     │  │
│  │   the hood. Renders rich text with        │  │
│  │   inline formatting, headings, lists,     │  │
│  │   code blocks, blockquotes, links,        │  │
│  │   and horizontal rules.                   │  │
│  │                                           │  │
│  ├───────────────────────────────────────────┤  │
│  │  Status Bar: word count │ line │ saved ✓  │  │
│  └───────────────────────────────────────────┘  │
│                                                  │
│  ┌──────────────────────┐  (overlay, toggled)   │
│  │  Search & Replace    │                        │
│  │  Find: [________] ↑↓ │                        │
│  │  Replace: [______] ⟳ │                        │
│  └──────────────────────┘                        │
└─────────────────────────────────────────────────┘
```

## Tech Stack

| Layer          | Choice                        | Rationale                                      |
|----------------|-------------------------------|-------------------------------------------------|
| Framework      | React 19 + TypeScript         | Matches existing TaskBoard UI stack             |
| Build          | Vite                          | Fast HMR, ESBuild-powered                      |
| Editor engine  | Tiptap v2 (ProseMirror)       | Extensible, headless, great React bindings      |
| Markdown I/O   | tiptap markdown extension     | Bidirectional Markdown ↔ ProseMirror conversion |
| Syntax HL      | lowlight (highlight.js core)  | Tiptap CodeBlockLowlight extension              |
| Persistence    | IndexedDB via idb             | Structured offline storage, large doc support   |
| Styling        | Tailwind CSS                  | Utility-first, fast iteration                   |
| Testing        | Vitest + Playwright           | Unit + E2E coverage                             |

## Data Model

### Document

```typescript
interface EditorDocument {
  id: string;            // UUID
  title: string;         // Display name / filename
  content: string;       // Markdown string (source of truth)
  createdAt: string;     // ISO 8601
  updatedAt: string;     // ISO 8601
  isDirty: boolean;      // Unsaved changes flag (transient, not persisted)
}
```

### IndexedDB Schema

- **Database**: `text-editor-db`
- **Object store**: `documents`
  - Key path: `id`
  - Indexes: `title`, `updatedAt`

### App State (React Context)

```typescript
interface EditorState {
  documents: EditorDocument[];    // All open documents
  activeDocId: string | null;     // Currently focused tab
  searchState: SearchState;       // Search/replace UI state
}

interface SearchState {
  isOpen: boolean;
  query: string;
  replacement: string;
  matchCount: number;
  currentMatch: number;
  caseSensitive: boolean;
}
```

## Component Hierarchy

```
<App>
  <EditorProvider>           // React context for global state
    <AppShell>
      <TabBar />             // Document tabs with close/add
      <Toolbar />            // Formatting buttons
      <EditorCanvas />       // Tiptap useEditor hook
      <StatusBar />          // Word count, cursor position, save state
      <SearchPanel />        // Slide-down search/replace overlay
      <FileDialog />         // Open/save modal
    </AppShell>
  </EditorProvider>
</App>
```

## Key Behaviors

### File Operations
- **New**: Creates untitled document, opens in new tab
- **Open**: File picker reads `.md` / `.txt` from disk via File System Access API (with fallback to `<input type="file">`)
- **Save**: Writes Markdown to disk via File System Access API (with fallback to download)
- **Save As**: Prompts for new filename, then saves

### Markdown Round-Trip
- Documents are stored as Markdown strings
- On load: Markdown → ProseMirror document (via tiptap-markdown)
- On save: ProseMirror document → Markdown string
- Preserves structure through round-trips (headings, lists, code, links, images)

### Auto-Save
- Debounced save to IndexedDB on every content change (1.5s debounce)
- Visual indicator in status bar: "Saving..." → "Saved ✓"
- On app load: restore all documents from IndexedDB, reopen tabs

### Search & Replace
- Activated via Ctrl/Cmd+F (search) or Ctrl/Cmd+H (replace)
- Highlights all matches in editor
- Navigate between matches with Enter / Shift+Enter or arrow buttons
- Replace current or replace all
- Case-sensitive toggle

### Keyboard Shortcuts

| Shortcut          | Action              |
|-------------------|----------------------|
| Ctrl/Cmd + B      | Bold                 |
| Ctrl/Cmd + I      | Italic               |
| Ctrl/Cmd + U      | Underline            |
| Ctrl/Cmd + Shift+1| Heading 1            |
| Ctrl/Cmd + Shift+2| Heading 2            |
| Ctrl/Cmd + Shift+3| Heading 3            |
| Ctrl/Cmd + Shift+8| Bullet list          |
| Ctrl/Cmd + Shift+9| Ordered list         |
| Ctrl/Cmd + E      | Code (inline)        |
| Ctrl/Cmd + Shift+E| Code block           |
| Ctrl/Cmd + N      | New document         |
| Ctrl/Cmd + O      | Open file            |
| Ctrl/Cmd + S      | Save                 |
| Ctrl/Cmd + Shift+S| Save As              |
| Ctrl/Cmd + W      | Close tab            |
| Ctrl/Cmd + F      | Search               |
| Ctrl/Cmd + H      | Search & Replace     |
| Ctrl/Cmd + Tab    | Next tab             |

## Story Dependency Graph (DAG)

```
T-ED-1  Project Scaffolding
  │
  ▼
T-ED-2  Core Editor Component ──────────────────┐
  │                                              │
  ├──► T-ED-3  Rich Text Toolbar ──┐             │
  │                                │             │
  ├──► T-ED-4  Markdown I/O        │             │
  │     │                          │             │
  │     ▼                          │             │
  ├──► T-ED-5  File Operations ◄───┘             │
  │     │                                        │
  │     ├──► T-ED-7  Multi-Tab Management        │
  │     │     │                                  │
  │     │     ▼                                  │
  │     └──► T-ED-10 Auto-Save & Persistence     │
  │                                              │
  ├──► T-ED-6  Keyboard Shortcuts ◄── T-ED-3     │
  │                                              │
  ├──► T-ED-8  Search & Replace ◄────────────────┘
  │
  └──► T-ED-9  Code Block Syntax Highlighting ◄── T-ED-3
```

## Stories Summary

| ID      | Title                              | Priority | Depends On         |
|---------|------------------------------------|---------:|---------------------|
| T-ED-1  | Project Scaffolding & Dev Setup    |        1 | —                   |
| T-ED-2  | Core Editor Component              |        1 | T-ED-1              |
| T-ED-3  | Rich Text Formatting Toolbar       |        2 | T-ED-2              |
| T-ED-4  | Markdown Serialization             |        2 | T-ED-2              |
| T-ED-5  | File Operations                    |        3 | T-ED-2, T-ED-3, T-ED-4 |
| T-ED-6  | Keyboard Shortcuts                 |        3 | T-ED-3, T-ED-5     |
| T-ED-7  | Multi-Tab Document Management      |        4 | T-ED-5              |
| T-ED-8  | Search & Replace                   |        4 | T-ED-2              |
| T-ED-9  | Code Block Syntax Highlighting     |        4 | T-ED-3              |
| T-ED-10 | Auto-Save & Persistence            |        5 | T-ED-5, T-ED-7     |

---

## Story Details

---

### T-ED-1: Project Scaffolding & Dev Environment Setup

**Priority**: 1 &nbsp;|&nbsp; **Status**: Backlog &nbsp;|&nbsp; **Repo**: `web-text-editor`
**Labels**: `infra`, `setup`, `editor`
**Depends On**: —

#### Description

Bootstrap the web-based text editor project using Vite + React 19 + TypeScript. Configure Tailwind CSS for styling, Vitest for unit tests, and Playwright for E2E tests. Set up the project structure with placeholder components and a working dev server.

#### Technical Details

- Initialize with `npm create vite@latest` using the react-ts template
- Install and configure Tailwind CSS v4 with PostCSS
- Install Vitest with React Testing Library and jsdom environment
- Install Playwright with chromium browser
- Create directory structure:
  ```
  src/
    components/    # React components
    hooks/         # Custom hooks
    context/       # React context providers
    lib/           # Utilities, types, constants
    styles/        # Global styles
  ```
- Create `<App>` shell component rendering a centered placeholder
- Add npm scripts: `dev`, `build`, `preview`, `test`, `test:e2e`
- Add a basic Playwright test that loads the app and asserts the shell renders
- Add a `.env.example` with any needed variables
- Dockerfile for containerized dev (optional stretch)

#### Acceptance Criteria

1. Running `npm run dev` starts the Vite dev server and renders the App shell in a browser
2. Running `npm run build` produces a production bundle with zero errors
3. Running `npm test` executes Vitest and at least one passing unit test exists
4. Running `npm run test:e2e` executes Playwright and at least one passing E2E test exists
5. Tailwind CSS utility classes are functional in components
6. TypeScript strict mode is enabled with no type errors
7. Directory structure matches the specification

#### Test Plan

1. Clone the repo and run `npm install` — verify no dependency errors
2. Run `npm run dev` — verify the dev server starts and the browser shows the App shell
3. Run `npm run build` — verify a clean production build
4. Run `npm test` — verify Vitest runs and the placeholder test passes
5. Run `npm run test:e2e` — verify Playwright loads the app and the smoke test passes
6. Open a component file, add a Tailwind class, verify it renders correctly
7. Introduce a type error in a .tsx file, verify `tsc --noEmit` catches it

---

### T-ED-2: Core Editor Component with Tiptap

**Priority**: 1 &nbsp;|&nbsp; **Status**: Backlog &nbsp;|&nbsp; **Repo**: `web-text-editor`
**Labels**: `editor`, `core`, `tiptap`
**Depends On**: T-ED-1

#### Description

Integrate Tiptap v2 as the editor engine. Create the `<EditorCanvas>` component using the `useEditor` hook with a baseline set of extensions. Create the `<EditorProvider>` context to manage editor state across the app. The editor should accept and render rich text content with basic nodes (paragraphs, headings, lists).

#### Technical Details

- Install: `@tiptap/react`, `@tiptap/starter-kit`, `@tiptap/pm`
- Create `EditorCanvas.tsx`:
  - Uses `useEditor` with StarterKit (includes paragraph, heading, bold, italic, strike, code, blockquote, bullet list, ordered list, horizontal rule, hard break)
  - Renders `<EditorContent editor={editor} />` inside a styled container
  - Editor area should have comfortable padding, max-width of ~720px, centered on page
  - Typography styles: proper font sizes for h1-h3, paragraph line height, list indentation
- Create `EditorProvider.tsx` (React context):
  - Holds `EditorDocument[]`, `activeDocId`, exposes `createDocument`, `setActiveDoc`, `updateContent`
  - On mount, creates one default untitled document
- Create `StatusBar.tsx`:
  - Displays word count (computed from editor text content)
  - Displays character count
  - Displays current cursor line/column position
- Wire `<App>` to render `<EditorProvider>` > `<EditorCanvas>` > `<StatusBar>`
- Editor content area should have a clean white background with subtle border/shadow

#### Acceptance Criteria

1. The editor renders in the browser and accepts typed text input
2. Paragraphs are created on Enter, line breaks on Shift+Enter
3. StarterKit nodes render correctly: headings, bold, italic, strikethrough, code, blockquotes, bullet lists, ordered lists, horizontal rules
4. Status bar shows live word count and character count that update as the user types
5. Status bar shows cursor line and column position
6. EditorProvider context is accessible from child components
7. A default untitled document is created on app load
8. Editor area is styled with proper typography and centered layout

#### Test Plan

1. Load the app — verify the editor canvas renders with a blinking cursor
2. Type text — verify characters appear and word/character counts update in the status bar
3. Press Enter — verify a new paragraph is created
4. Press Shift+Enter — verify a line break (not new paragraph) is created
5. Select text and apply bold/italic via ProseMirror commands — verify formatting renders
6. Verify EditorProvider context holds the default document with correct initial state
7. Unit test: EditorProvider creates a document on mount with expected shape
8. Unit test: word count utility returns correct count for sample text

---

### T-ED-3: Rich Text Formatting Toolbar

**Priority**: 2 &nbsp;|&nbsp; **Status**: Backlog &nbsp;|&nbsp; **Repo**: `web-text-editor`
**Labels**: `editor`, `toolbar`, `ui`
**Depends On**: T-ED-2

#### Description

Build the `<Toolbar>` component with formatting buttons that drive the Tiptap editor. Buttons should reflect active state (e.g., Bold button is highlighted when cursor is in bold text). The toolbar should be responsive and visually clean.

#### Technical Details

- Create `Toolbar.tsx` with grouped formatting buttons:
  - **Text**: Bold, Italic, Underline (add `@tiptap/extension-underline`), Strikethrough
  - **Headings**: H1, H2, H3 (dropdown or toggle buttons)
  - **Lists**: Bullet list, Ordered list
  - **Blocks**: Blockquote, Code block, Horizontal rule
  - **Insert**: Link (add `@tiptap/extension-link` — prompts for URL)
- Each button:
  - Calls the corresponding Tiptap chain command (e.g., `editor.chain().focus().toggleBold().run()`)
  - Uses `editor.isActive('bold')` to toggle active styling
  - Has a tooltip showing the action name and shortcut hint
  - Is disabled when the command cannot be executed (`editor.can()...`)
- Toolbar layout:
  - Horizontal bar pinned below the tab bar
  - Buttons grouped by category with subtle dividers
  - Uses icon-based buttons (use simple SVG icons or a lightweight icon set)
  - Active state: highlighted background, pressed appearance
  - Disabled state: reduced opacity
- Link insertion: clicking the link button opens a small popover/modal to enter URL, with the selected text as the link text

#### Acceptance Criteria

1. Toolbar renders with all specified formatting buttons grouped logically
2. Clicking Bold toggles bold on selected text or at cursor position
3. Clicking Italic toggles italic on selected text or at cursor position
4. Clicking Underline toggles underline on selected text or at cursor position
5. Heading buttons (H1, H2, H3) toggle the current paragraph to the corresponding heading level
6. List buttons toggle bullet list and ordered list
7. Blockquote button wraps/unwraps the current block
8. Code block button toggles a code block
9. Horizontal rule button inserts a horizontal rule at cursor
10. Link button opens a URL input and creates a link on the selected text
11. Active formatting is visually indicated on the toolbar buttons
12. Disabled buttons have reduced opacity and are not clickable
13. Each button shows a tooltip with action name and keyboard shortcut

#### Test Plan

1. Load the app — verify all toolbar buttons render with icons
2. Select text, click Bold — verify text becomes bold and button shows active state
3. Click Bold again — verify bold is removed and button returns to inactive
4. Repeat for Italic, Underline, Strikethrough
5. Click H1 with cursor in a paragraph — verify it becomes a heading
6. Click H1 again — verify it reverts to a paragraph
7. Click Bullet List — verify a bullet list is created
8. Click Link, enter a URL — verify the selected text becomes a hyperlink
9. Place cursor outside formatted text — verify active states clear
10. Hover over buttons — verify tooltips appear
11. Unit test: Toolbar renders correct number of buttons
12. E2E test: click Bold, verify text element has bold styling

---

### T-ED-4: Markdown Serialization (Import/Export)

**Priority**: 2 &nbsp;|&nbsp; **Status**: Backlog &nbsp;|&nbsp; **Repo**: `web-text-editor`
**Labels**: `editor`, `markdown`, `serialization`
**Depends On**: T-ED-2

#### Description

Add bidirectional Markdown conversion so documents can be loaded from and saved as Markdown. This is the internal storage format — all document persistence uses Markdown strings as the source of truth.

#### Technical Details

- Install `tiptap-markdown` extension for bidirectional conversion
- Configure the Markdown extension on the editor:
  - `html: false` (strict Markdown, no raw HTML)
  - `transformPastedText: true` (pasting Markdown renders as rich text)
  - `transformCopiedText: true` (copying from editor produces Markdown)
- Create utility functions in `src/lib/markdown.ts`:
  - `getMarkdown(editor: Editor): string` — serializes current editor content to Markdown
  - `setMarkdown(editor: Editor, markdown: string): void` — loads Markdown into the editor
- Update `EditorProvider`:
  - Store document content as Markdown string in state
  - On editor `update` event: serialize to Markdown, update document state
  - On active document change: load the document's Markdown into the editor
- Handle round-trip fidelity for:
  - Headings (h1-h3 via `#`, `##`, `###`)
  - Bold (`**text**`), Italic (`*text*`), Strikethrough (`~~text~~`)
  - Inline code (`` `code` ``), Code blocks (``` ``` ```)
  - Bullet lists (`- item`), Ordered lists (`1. item`)
  - Blockquotes (`> text`)
  - Links (`[text](url)`)
  - Horizontal rules (`---`)
- Clipboard behavior: pasting Markdown from external sources renders as formatted rich text

#### Acceptance Criteria

1. `getMarkdown()` returns valid Markdown for all supported node types
2. `setMarkdown()` correctly loads Markdown and renders as rich text in the editor
3. Round-trip test: Markdown → editor → Markdown produces equivalent output for all supported elements
4. Pasting Markdown text from clipboard renders as formatted rich text (not literal asterisks)
5. Copying formatted text from the editor produces Markdown in the clipboard
6. Document state stores content as Markdown strings
7. Switching between documents preserves each document's Markdown content

#### Test Plan

1. Call `setMarkdown` with sample Markdown containing headings, lists, bold, code — verify editor renders all elements correctly
2. Edit content in the editor, call `getMarkdown` — verify output is well-formed Markdown
3. Round-trip test: load sample.md → `getMarkdown` → compare with original (structural equivalence)
4. Paste raw Markdown text (`**bold** and *italic*`) into the editor — verify it renders as bold and italic, not literal asterisks
5. Select formatted text, copy, paste into a plain text field — verify Markdown syntax is in clipboard
6. Unit tests for `getMarkdown` covering each node type
7. Unit tests for `setMarkdown` covering each node type
8. Regression test: load a complex Markdown document, make no changes, export — verify no drift

---

### T-ED-5: File Operations (New / Open / Save / Save As)

**Priority**: 3 &nbsp;|&nbsp; **Status**: Backlog &nbsp;|&nbsp; **Repo**: `web-text-editor`
**Labels**: `editor`, `file-ops`, `ui`
**Depends On**: T-ED-2, T-ED-3, T-ED-4

#### Description

Implement file operations for creating, opening, and saving documents. Use the File System Access API where available (Chromium browsers) with fallback to traditional file input and download for other browsers.

#### Technical Details

- Create `src/lib/file-system.ts` with platform-abstracted file operations:
  - `openFile(): Promise<{ name: string; content: string } | null>` — opens file picker, reads text content
  - `saveFile(content: string, suggestedName: string, existingHandle?: FileSystemFileHandle): Promise<FileSystemFileHandle | null>` — saves to disk
  - `saveFileAs(content: string, suggestedName: string): Promise<FileSystemFileHandle | null>` — always prompts for location
  - Detect File System Access API support: `'showOpenFilePicker' in window`
  - Fallback: `<input type="file">` for open, programmatic `<a download>` for save
- Create `<FileDialog>` component (optional, for save-before-close confirmation):
  - "You have unsaved changes. Save before closing?" with Save / Don't Save / Cancel
- Update `EditorProvider` with new actions:
  - `newDocument()` — creates untitled doc, switches to it
  - `openDocument()` — calls `openFile`, creates doc from content, switches to it
  - `saveDocument(docId?)` — saves active (or specified) doc via `saveFile`
  - `saveDocumentAs(docId?)` — saves via `saveFileAs`
  - Track file handle per document (for subsequent saves without re-prompting)
- Add a minimal menu/action bar or integrate into the toolbar:
  - New, Open, Save, Save As buttons or a File dropdown menu
- Update `isDirty` flag: set true on edit, clear on save
- Status bar: show document title and dirty indicator (dot or asterisk)

#### Acceptance Criteria

1. Clicking New creates a new untitled document and switches the editor to it
2. Clicking Open shows a file picker, loads the selected `.md` or `.txt` file into a new document
3. Clicking Save writes the current document to disk as Markdown
4. If the document was previously opened or saved, Save writes to the same file without re-prompting
5. Clicking Save As always prompts for a file location
6. On browsers without File System Access API, Open uses a file input and Save triggers a download
7. The dirty indicator shows when a document has unsaved changes
8. The dirty indicator clears after a successful save
9. Attempting to close a dirty document shows a save confirmation dialog
10. The document title in the status bar reflects the filename

#### Test Plan

1. Click New — verify a new tab appears with "Untitled" title and empty editor
2. Click Open, select a `.md` file — verify content loads and renders correctly
3. Type in the editor — verify dirty indicator appears
4. Click Save — verify the file is written (or downloaded in fallback mode)
5. After Save — verify dirty indicator clears
6. Edit again, click Save — verify it saves to the same file without re-prompting (File System Access API)
7. Click Save As — verify a new file location can be chosen
8. Unit test: `openFile` returns correct name and content from a mock file
9. Unit test: `saveFile` calls the appropriate API with correct content
10. E2E test: full open → edit → save flow

---

### T-ED-6: Keyboard Shortcuts

**Priority**: 3 &nbsp;|&nbsp; **Status**: Backlog &nbsp;|&nbsp; **Repo**: `web-text-editor`
**Labels**: `editor`, `keyboard`, `ux`
**Depends On**: T-ED-3, T-ED-5

#### Description

Implement comprehensive keyboard shortcuts for formatting, file operations, and navigation. Shortcuts should follow platform conventions (Ctrl on Windows/Linux, Cmd on macOS) and not conflict with browser defaults.

#### Technical Details

- Tiptap already handles basic formatting shortcuts from StarterKit (bold, italic, strike). Verify these work and add missing ones.
- Create `src/hooks/useKeyboardShortcuts.ts`:
  - Registers document-level keyboard event listeners
  - Maps shortcuts to EditorProvider actions and editor commands
  - Detects platform (Mac vs other) for modifier key display
- Shortcut map:
  - **Formatting** (handled by Tiptap extensions, verify/configure):
    - `Mod+B` → Bold
    - `Mod+I` → Italic
    - `Mod+U` → Underline
    - `Mod+Shift+X` → Strikethrough
    - `Mod+E` → Inline code
    - `Mod+Shift+1/2/3` → Heading 1/2/3
    - `Mod+Shift+8` → Bullet list
    - `Mod+Shift+9` → Ordered list
    - `Mod+Shift+B` → Blockquote
    - `Mod+Shift+E` → Code block
  - **File operations** (custom, via `useKeyboardShortcuts`):
    - `Mod+N` → New document
    - `Mod+O` → Open file
    - `Mod+S` → Save
    - `Mod+Shift+S` → Save As
    - `Mod+W` → Close tab
  - **Navigation**:
    - `Mod+Tab` / `Mod+Shift+Tab` → Next/previous tab
  - **Search**:
    - `Mod+F` → Open search
    - `Mod+H` → Open search & replace
    - `Escape` → Close search panel
- Prevent browser default for overridden shortcuts (e.g., Ctrl+S should not trigger browser save dialog)
- Update toolbar button tooltips to show the correct platform-specific shortcut

#### Acceptance Criteria

1. Ctrl/Cmd+B toggles bold at cursor or on selection
2. Ctrl/Cmd+I toggles italic at cursor or on selection
3. Ctrl/Cmd+U toggles underline at cursor or on selection
4. Ctrl/Cmd+S saves the current document (does not trigger browser save dialog)
5. Ctrl/Cmd+N creates a new document (does not trigger browser new window)
6. Ctrl/Cmd+O opens the file picker (does not trigger browser open file)
7. Ctrl/Cmd+W closes the current tab (does not close the browser tab)
8. Ctrl/Cmd+F opens the search panel
9. Ctrl/Cmd+H opens the search & replace panel
10. Escape closes the search panel when it is open
11. Ctrl/Cmd+Tab cycles to the next document tab
12. Toolbar tooltips show platform-correct shortcuts (Cmd on Mac, Ctrl on others)
13. All shortcuts work in both the editor focus and document focus contexts

#### Test Plan

1. Focus the editor, press Ctrl/Cmd+B — verify bold toggles
2. Press Ctrl/Cmd+S — verify save is triggered and browser save dialog does NOT appear
3. Press Ctrl/Cmd+N — verify new document is created and browser new window does NOT open
4. Press Ctrl/Cmd+O — verify file picker opens
5. Press Ctrl/Cmd+W — verify the current tab closes and the browser tab does NOT close
6. Press Ctrl/Cmd+F — verify search panel opens
7. Press Escape — verify search panel closes
8. Open multiple tabs, press Ctrl/Cmd+Tab — verify focus cycles to next tab
9. Verify tooltips show "Cmd" on macOS and "Ctrl" on other platforms
10. E2E test: simulate Ctrl+B keypress, verify bold formatting applied

---

### T-ED-7: Multi-Tab Document Management

**Priority**: 4 &nbsp;|&nbsp; **Status**: Backlog &nbsp;|&nbsp; **Repo**: `web-text-editor`
**Labels**: `editor`, `tabs`, `ui`
**Depends On**: T-ED-5

#### Description

Implement a tab bar that supports multiple simultaneously open documents. Users can switch between tabs, close tabs (with unsaved-changes protection), reorder tabs via drag-and-drop, and create new documents from the tab bar.

#### Technical Details

- Create `TabBar.tsx`:
  - Renders a horizontal scrollable tab strip
  - Each tab shows: document title (or "Untitled"), dirty indicator (dot), close button (×)
  - Active tab is visually distinct (background, border, or underline)
  - "+" button at the end to create a new document
  - Tabs are scrollable if they overflow the container width
- Tab interactions:
  - Click tab → switch active document (preserving scroll/cursor position in each doc)
  - Click × → close tab (with dirty-check dialog if unsaved)
  - Middle-click tab → close tab
  - Drag tab → reorder (use native HTML drag or a lightweight library)
  - Double-click tab title → rename document
- Update `EditorProvider`:
  - `closeDocument(docId)` — removes from state, switches to adjacent tab
  - `reorderDocuments(fromIndex, toIndex)` — updates document array order
  - `renameDocument(docId, newTitle)` — updates title
  - Preserve editor state (scroll position, selection) per document when switching
- Edge cases:
  - Closing the last tab creates a new untitled document (app never has zero tabs)
  - Opening a file that is already open switches to its existing tab
  - Tab title truncation for long filenames with tooltip showing full name

#### Acceptance Criteria

1. Tab bar renders with one tab on initial load
2. Clicking the "+" button creates a new tab with an untitled document
3. Clicking a tab switches the editor to that document's content
4. Switching tabs preserves each document's content, scroll position, and cursor
5. The active tab is visually distinct from inactive tabs
6. Clicking the × button on a clean tab closes it immediately
7. Clicking the × button on a dirty tab shows a save confirmation dialog
8. Closing the last tab creates a new untitled document
9. Tabs can be reordered via drag-and-drop
10. Double-clicking a tab title allows renaming
11. Long tab titles are truncated with a tooltip showing the full name
12. Opening a file already open in a tab switches to that tab instead of creating a duplicate

#### Test Plan

1. Load the app — verify one tab appears
2. Click "+" three times — verify three new tabs appear
3. Click each tab — verify editor content switches correctly
4. Type different text in each tab, switch between them — verify content is preserved
5. Click × on a clean tab — verify it closes and adjacent tab activates
6. Click × on a dirty tab — verify the save dialog appears
7. Close all tabs — verify a new untitled tab is created automatically
8. Drag a tab to a new position — verify tabs reorder
9. Double-click a tab title, type a new name — verify it updates
10. Open the same file twice — verify no duplicate tab is created
11. Create many tabs — verify horizontal scrolling works
12. E2E test: create 3 tabs, type in each, switch and verify content

---

### T-ED-8: Search and Replace

**Priority**: 4 &nbsp;|&nbsp; **Status**: Backlog &nbsp;|&nbsp; **Repo**: `web-text-editor`
**Labels**: `editor`, `search`, `ux`
**Depends On**: T-ED-2

#### Description

Implement a search and replace panel that allows users to find text in the current document, navigate between matches, and replace single or all occurrences.

#### Technical Details

- Install `@tiptap/extension-search-and-replace` or implement using ProseMirror's `prosemirror-search` / custom decoration plugin:
  - If no maintained Tiptap extension exists, implement a custom ProseMirror plugin that:
    - Scans document for query matches
    - Applies highlight decorations to all matches
    - Tracks current match index for navigation
- Create `SearchPanel.tsx`:
  - Slide-down panel anchored to the top-right of the editor area (similar to VS Code)
  - Search input field with match count display (e.g., "3 of 12")
  - Up/down navigation buttons to cycle through matches
  - Replace input field (shown when in replace mode)
  - Replace and Replace All buttons
  - Case-sensitive toggle button
  - Close button (×)
- Search behavior:
  - Real-time search as the user types in the search field (debounced 200ms)
  - Current match is highlighted differently from other matches (e.g., orange vs yellow)
  - Editor scrolls to show the current match
  - Wraps around at document boundaries
- Replace behavior:
  - Replace: replaces current match and advances to next
  - Replace All: replaces all matches at once, shows count of replacements
- Update `EditorProvider` with `searchState` management
- Keyboard integration:
  - Enter in search field → next match
  - Shift+Enter in search field → previous match
  - Escape → close panel, clear highlights

#### Acceptance Criteria

1. Ctrl/Cmd+F opens the search panel with the search input focused
2. Typing in the search field highlights all matches in the document in real-time
3. Match count displays correctly (e.g., "3 of 12 matches")
4. Up/down buttons cycle through matches, scrolling the editor to each one
5. The current match has a distinct highlight color from other matches
6. Search wraps from the last match back to the first (and vice versa)
7. Ctrl/Cmd+H opens the panel in replace mode with both fields visible
8. Replace button replaces the current match and advances to the next
9. Replace All button replaces all matches and shows the count replaced
10. Case-sensitive toggle changes search behavior
11. Escape closes the panel and clears all match highlights
12. Enter in search field navigates to the next match
13. The panel does not cover or obstruct the editor content at the current scroll position

#### Test Plan

1. Press Ctrl/Cmd+F — verify search panel slides open with focus in search input
2. Type a word that appears multiple times — verify all instances are highlighted
3. Verify the match counter shows correct numbers
4. Click the down arrow — verify the next match is highlighted as current and scrolled into view
5. Navigate past the last match — verify it wraps to the first
6. Toggle case sensitivity — verify match results change appropriately
7. Open replace mode, type replacement text, click Replace — verify the current match is replaced
8. Click Replace All — verify all remaining matches are replaced and count is shown
9. Press Escape — verify panel closes and highlights are cleared
10. Search for a term that doesn't exist — verify "0 matches" is shown
11. Unit test: search logic returns correct match positions for sample text
12. E2E test: open search, find text, replace, verify document content changes

---

### T-ED-9: Code Block Syntax Highlighting

**Priority**: 4 &nbsp;|&nbsp; **Status**: Backlog &nbsp;|&nbsp; **Repo**: `web-text-editor`
**Labels**: `editor`, `syntax-highlighting`, `code`
**Depends On**: T-ED-3

#### Description

Add syntax highlighting for code blocks in the editor. Users should be able to insert code blocks, select a language, and see syntax-highlighted code with a monospace font and language label.

#### Technical Details

- Install: `@tiptap/extension-code-block-lowlight`, `lowlight`, plus language grammars
- Replace the StarterKit `codeBlock` with `CodeBlockLowlight`:
  - Configure lowlight with common languages: javascript, typescript, python, json, html, css, bash, sql, markdown, go, rust, java, c, cpp, yaml, xml
  - Use `lowlight.createLowlight(common)` for a reasonable bundle size
- Create `CodeBlock.tsx` custom node view (optional, for enhanced UX):
  - Language selector dropdown in the top-right corner of the code block
  - Copy button to copy code block content to clipboard
  - Code block has a distinct background (light gray or dark theme)
  - Monospace font (JetBrains Mono, Fira Code, or system monospace)
  - Line numbers (optional stretch goal)
- Syntax highlighting theme:
  - Choose or create a highlight.js CSS theme that works with the editor's overall design
  - Support both the editor's light theme and a dark code block variant
- Markdown integration:
  - Code blocks with language hints (` ```python `) should preserve the language through Markdown round-trips
  - Language is stored in the `language` attribute of the code block node
- Tab key behavior inside code blocks:
  - Tab inserts 2 spaces (not a tab character, configurable)
  - Shift+Tab dedents the current line

#### Acceptance Criteria

1. Code blocks render with syntax highlighting for at least 10 languages
2. The language selector dropdown appears on hover or focus of a code block
3. Changing the language re-highlights the code block immediately
4. Code blocks have a visually distinct background and monospace font
5. The copy button copies code block content to the clipboard
6. Tab key inserts spaces inside code blocks instead of moving focus
7. Shift+Tab dedents the current line in a code block
8. Code blocks with language hints round-trip correctly through Markdown
9. The syntax highlighting theme is visually consistent with the editor design
10. Creating a code block via toolbar or Markdown (` ``` `) works correctly

#### Test Plan

1. Insert a code block via the toolbar — verify it renders with a distinct background
2. Type JavaScript code — verify syntax highlighting applies (keywords, strings, etc.)
3. Change the language selector to Python — verify highlighting updates
4. Copy a code block — verify clipboard contains the plain code text
5. Press Tab inside a code block — verify spaces are inserted, not a tab character
6. Press Shift+Tab — verify the line is dedented
7. Write a Markdown code block with language hint (` ```typescript `), save as Markdown, reload — verify language is preserved
8. Test highlighting for 5+ different languages
9. Unit test: CodeBlockLowlight extension is registered and configured with expected languages
10. E2E test: create code block, type code, verify syntax highlight classes are present in DOM

---

### T-ED-10: Auto-Save & IndexedDB Persistence

**Priority**: 5 &nbsp;|&nbsp; **Status**: Backlog &nbsp;|&nbsp; **Repo**: `web-text-editor`
**Labels**: `editor`, `persistence`, `auto-save`
**Depends On**: T-ED-5, T-ED-7

#### Description

Implement automatic document persistence using IndexedDB so that documents survive page reloads, browser crashes, and accidental tab closures. All open documents and their state are automatically saved and restored.

#### Technical Details

- Install `idb` (lightweight IndexedDB wrapper with Promise API)
- Create `src/lib/storage.ts`:
  - Database: `text-editor-db`, version 1
  - Object store: `documents` with keyPath `id`
  - Indexes: `updatedAt` (for sorting), `title` (for searching)
  - CRUD operations:
    - `saveDocument(doc: EditorDocument): Promise<void>`
    - `loadAllDocuments(): Promise<EditorDocument[]>`
    - `deleteDocument(id: string): Promise<void>`
    - `saveAppState(state: { openDocIds: string[], activeDocId: string }): Promise<void>`
    - `loadAppState(): Promise<{ openDocIds: string[], activeDocId: string } | null>`
- Auto-save behavior:
  - On every editor content change, debounce 1500ms, then save to IndexedDB
  - Update `updatedAt` timestamp on each save
  - Visual feedback in status bar: "Saving..." during write, "Saved ✓" on completion
  - Save app state (open tab order, active tab) on every tab change
- Startup restore:
  - On app load, read all documents and app state from IndexedDB
  - Reopen tabs in the saved order, activate the last active tab
  - Restore each document's content into the editor
  - If IndexedDB is empty (first launch), create a default untitled document
- `beforeunload` handler:
  - If any document is dirty (changed since last auto-save), show the browser's native "unsaved changes" warning
  - Trigger an immediate save attempt for all dirty documents
- Storage management:
  - Display storage usage in a settings/about panel (optional stretch)
  - Handle IndexedDB quota errors gracefully with a user-visible warning

#### Acceptance Criteria

1. Typing in the editor triggers an auto-save to IndexedDB after 1.5 seconds of inactivity
2. Status bar shows "Saving..." during auto-save and "Saved ✓" on completion
3. Refreshing the page restores all previously open documents with their content
4. Tab order and active tab are preserved across page reloads
5. Closing a tab removes the document from the open set but keeps it in IndexedDB
6. The `beforeunload` warning appears when dirty documents exist and the user tries to close the browser tab
7. First launch (empty IndexedDB) creates a default untitled document
8. Documents saved to IndexedDB include correct `updatedAt` timestamps
9. IndexedDB quota errors are caught and displayed as a user warning
10. Auto-save does not cause editor lag or cursor jumps

#### Test Plan

1. Type text in the editor, wait 2 seconds — verify "Saved ✓" appears in status bar
2. Refresh the page — verify the document content is restored exactly
3. Open 3 tabs with different content, refresh — verify all 3 tabs reopen with correct content and order
4. Close a tab, refresh — verify the closed tab is not reopened but its content remains in IndexedDB
5. Open browser DevTools > Application > IndexedDB — verify documents are stored with correct schema
6. Type text and immediately close the browser tab — verify the `beforeunload` warning appears
7. Clear IndexedDB, refresh — verify a new untitled document is created
8. Rapidly type many characters — verify no lag or cursor position jumps from auto-save
9. Unit test: `saveDocument` stores correct data in IndexedDB (using `fake-indexeddb`)
10. Unit test: `loadAllDocuments` returns all saved documents
11. Unit test: debounced auto-save fires after 1500ms of no changes
12. E2E test: type content, reload page, verify content persists
