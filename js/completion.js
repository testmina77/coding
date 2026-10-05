// completion.js — completion + hover providers

import { project } from "./project.js";

let symbolCache = [];
let cacheDirty = true;

export function invalidateCompletionCache() {
  cacheDirty = true;
}

const RX_FUNC =
  /\b(?:void|int|char|short|long|float|double|bool|size_t|ssize_t|uint\d+_t|int\d+_t|u?intptr_t|HRESULT|BOOL|DWORD|HWND|LPSTR|LPCSTR|LPWSTR|LPCWSTR|LPVOID|HANDLE|[A-Z]\w+)\s+\**\s*(\w+)\s*\(/g;
const RX_STRUCT = /\b(?:struct|class|union|enum)\s+(\w+)/g;
const RX_TYPEDEF = /\btypedef\s+(?:struct\s+\w*\s*)?[^;]*?\b(\w+)\s*;/g;
const RX_MACRO = /^\s*#\s*define\s+(\w+)/gm;
const RX_CONSTEXPR = /\bconstexpr\s+\w+\s+(\w+)/g;

function parseSymbols(text, path) {
  const out = [];
  const push = (name, kind) => {
    if (!name || name.length < 2) return;
    out.push({ name, kind, path });
  };
  if (!text || text.length > 500000) return out;
  let m;
  RX_FUNC.lastIndex = 0;
  while ((m = RX_FUNC.exec(text)) !== null) push(m[1], "function");
  RX_STRUCT.lastIndex = 0;
  while ((m = RX_STRUCT.exec(text)) !== null) push(m[1], "struct");
  RX_TYPEDEF.lastIndex = 0;
  while ((m = RX_TYPEDEF.exec(text)) !== null) push(m[1], "type");
  RX_MACRO.lastIndex = 0;
  while ((m = RX_MACRO.exec(text)) !== null) push(m[1], "macro");
  RX_CONSTEXPR.lastIndex = 0;
  while ((m = RX_CONSTEXPR.exec(text)) !== null) push(m[1], "variable");
  return out;
}

function buildSymbolIndex() {
  const seen = new Set();
  const out = [];
  for (const [path, f] of project.files) {
    if (f.binary) continue;
    if (!/\.(c|cpp|cc|cxx|h|hpp|hxx)$/i.test(path)) continue;
    const syms = parseSymbols(f.content, path);
    for (const s of syms) {
      const key = s.kind + ":" + s.name;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(s);
    }
  }
  symbolCache = out;
  cacheDirty = false;
  return out;
}

const COMMON = [
  "auto",
  "break",
  "case",
  "const",
  "continue",
  "default",
  "do",
  "else",
  "enum",
  "extern",
  "for",
  "goto",
  "if",
  "inline",
  "register",
  "return",
  "sizeof",
  "static",
  "struct",
  "switch",
  "typedef",
  "union",
  "unsigned",
  "volatile",
  "while",
  "alignas",
  "alignof",
  "bool",
  "catch",
  "class",
  "constexpr",
  "const_cast",
  "decltype",
  "delete",
  "dynamic_cast",
  "explicit",
  "false",
  "friend",
  "mutable",
  "namespace",
  "new",
  "noexcept",
  "nullptr",
  "operator",
  "override",
  "private",
  "protected",
  "public",
  "reinterpret_cast",
  "static_assert",
  "static_cast",
  "template",
  "this",
  "throw",
  "true",
  "try",
  "typeid",
  "typename",
  "using",
  "virtual",
  "wchar_t",
  "int",
  "char",
  "short",
  "long",
  "float",
  "double",
  "void",
  "size_t",
  "ssize_t",
  "ptrdiff_t",
  "int8_t",
  "int16_t",
  "int32_t",
  "int64_t",
  "uint8_t",
  "uint16_t",
  "uint32_t",
  "uint64_t",
  "intptr_t",
  "uintptr_t",
  "string",
  "wstring",
  "vector",
  "map",
  "set",
  "unordered_map",
  "unique_ptr",
  "shared_ptr",
  "weak_ptr",
  "optional",
  "variant",
  "any",
  "std",
  "cout",
  "cin",
  "cerr",
  "endl",
  "printf",
  "fprintf",
  "sprintf",
  "snprintf",
  "scanf",
  "malloc",
  "calloc",
  "realloc",
  "free",
  "memcpy",
  "memset",
  "memmove",
  "strlen",
  "strcmp",
  "strcpy",
  "strcat",
  "strncpy",
  "strstr",
  "atoi",
  "atof",
  "itoa",
  "exit",
  "abort",
  "MessageBoxA",
  "MessageBoxW",
  "PlaySoundA",
  "PlaySoundW",
  "CreateWindowExA",
  "CreateWindowExW",
  "DestroyWindow",
  "ShowWindow",
  "UpdateWindow",
  "GetMessageA",
  "GetMessageW",
  "TranslateMessage",
  "DispatchMessageA",
  "DispatchMessageW",
  "DefWindowProcA",
  "DefWindowProcW",
  "RegisterClassA",
  "RegisterClassW",
  "LoadIconA",
  "LoadIconW",
  "LoadCursorA",
  "LoadCursorW",
  "LoadStringA",
  "LoadStringW",
  "GetModuleHandleA",
  "GetModuleHandleW",
  "GetLastError",
  "SetLastError",
  "Sleep",
  "SleepEx",
  "WaitForSingleObject",
  "CreateThread",
  "ExitThread",
  "CreateFileA",
  "CreateFileW",
  "ReadFile",
  "WriteFile",
  "CloseHandle",
  "GetStdHandle",
  "SetConsoleTitleA",
  "SetConsoleTitleW",
  "GetTickCount",
  "GetTickCount64",
  "QueryPerformanceCounter",
  "HeapAlloc",
  "HeapFree",
  "GetProcessHeap",
  "VirtualAlloc",
  "VirtualFree",
  "OutputDebugStringA",
  "OutputDebugStringW",
  "BOOL",
  "DWORD",
  "WORD",
  "BYTE",
  "CHAR",
  "WCHAR",
  "TCHAR",
  "LPSTR",
  "LPCSTR",
  "LPWSTR",
  "LPCWSTR",
  "LPVOID",
  "HANDLE",
  "HWND",
  "HINSTANCE",
  "HMODULE",
  "HICON",
  "HCURSOR",
  "HBRUSH",
  "HPEN",
  "HFONT",
  "HMENU",
  "HBITMAP",
  "HDC",
  "HRESULT",
  "LPARAM",
  "WPARAM",
  "LRESULT",
  "CALLBACK",
  "WINAPI",
  "APIENTRY",
  "TRUE",
  "FALSE",
  "NULL",
  "MAX_PATH",
  "INFINITE",
  "MB_OK",
  "MB_ICONERROR",
  "MB_ICONINFORMATION",
  "MB_ICONWARNING",
  "MB_YESNO",
  "MB_OKCANCEL",
  "WM_CREATE",
  "WM_DESTROY",
  "WM_PAINT",
  "WM_CLOSE",
  "WM_COMMAND",
  "WM_KEYDOWN",
  "WM_KEYUP",
  "WM_MOUSEMOVE",
  "WM_LBUTTONDOWN",
  "WM_LBUTTONUP",
  "WM_SIZE",
  "SND_MEMORY",
  "SND_FILENAME",
  "SND_ASYNC",
  "SND_SYNC",
  "SND_LOOP",
  "SND_NODEFAULT",
  "CS_VREDRAW",
  "CS_HREDRAW",
  "CW_USEDEFAULT",
  "SW_SHOW",
  "SW_HIDE",
  "STD_INPUT_HANDLE",
  "STD_OUTPUT_HANDLE",
  "STD_ERROR_HANDLE",
  "FILE_SHARE_READ",
  "FILE_SHARE_WRITE",
  "OPEN_EXISTING",
  "CREATE_ALWAYS",
  "GENERIC_READ",
  "GENERIC_WRITE",
  "INVALID_HANDLE_VALUE",
  "push_back",
  "pop_back",
  "emplace_back",
  "begin",
  "end",
  "size",
  "empty",
  "clear",
  "reserve",
  "resize",
  "insert",
  "erase",
  "find",
  "count",
  "at",
  "front",
  "back",
  "data",
  "c_str",
  "substr",
  "length",
  "capacity",
];

const SNIPPETS = [
  {
    label: "main",
    kind: "Snippet",
    insertText: `int main(int argc, char** argv) {\n    \${1:return 0;}\n}`,
    doc: "main function",
  },
  {
    label: "for",
    kind: "Snippet",
    insertText: `for (int i = 0; i < \${1:n}; i++) {\n    \${2:}\n}`,
    doc: "for loop",
  },
  {
    label: "while",
    kind: "Snippet",
    insertText: `while (\${1:cond}) {\n    \${2:}\n}`,
    doc: "while loop",
  },
  {
    label: "if",
    kind: "Snippet",
    insertText: `if (\${1:cond}) {\n    \${2:}\n}`,
    doc: "if",
  },
  {
    label: "ifelse",
    kind: "Snippet",
    insertText: `if (\${1:cond}) {\n    \${2:}\n} else {\n    \${3:}\n}`,
    doc: "if-else",
  },
  {
    label: "#include",
    kind: "Snippet",
    insertText: `#include <\${1:stdio.h}>`,
    doc: "include system",
  },
  {
    label: '#inc"',
    kind: "Snippet",
    insertText: `#include "\${1:file.h}"`,
    doc: "include local",
  },
  {
    label: "struct",
    kind: "Snippet",
    insertText: `struct \${1:Name} {\n    \${2:}\n};`,
    doc: "struct",
  },
  {
    label: "class",
    kind: "Snippet",
    insertText: `class \${1:Name} {\npublic:\n    \${2:}\n};`,
    doc: "class",
  },
  {
    label: "printf",
    kind: "Snippet",
    insertText: `printf("\${1:%d}\\\\n", \${2:val});`,
    doc: "printf",
  },
  {
    label: "cout",
    kind: "Snippet",
    insertText: `std::cout << \${1:"text"} << std::endl;`,
    doc: "cout",
  },
];

let registered = false;

export function registerCompletion(monaco) {
  if (registered) return;
  registered = true;

  const KIND = {
    function: monaco.languages.CompletionItemKind.Function,
    struct: monaco.languages.CompletionItemKind.Struct,
    class: monaco.languages.CompletionItemKind.Class,
    type: monaco.languages.CompletionItemKind.TypeParameter,
    macro: monaco.languages.CompletionItemKind.Constant,
    variable: monaco.languages.CompletionItemKind.Variable,
    keyword: monaco.languages.CompletionItemKind.Keyword,
    snippet: monaco.languages.CompletionItemKind.Snippet,
  };

  const provider = {
    triggerCharacters: [".", ">", ":", "#", "(", " "],
    provideCompletionItems(model, position) {
      const word = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };
      const items = [];
      const projSyms = cacheDirty ? buildSymbolIndex() : symbolCache;
      for (const s of projSyms) {
        items.push({
          label: s.name,
          kind: KIND[s.kind] || KIND.variable,
          detail: s.kind,
          documentation: s.path,
          insertText: s.name,
          range,
        });
      }
      for (const name of COMMON) {
        items.push({
          label: name,
          kind: KIND.keyword,
          insertText: name,
          range,
        });
      }
      for (const s of SNIPPETS) {
        items.push({
          label: s.label,
          kind: KIND.snippet,
          insertText: s.insertText,
          insertTextRules:
            monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          documentation: s.doc,
          range,
        });
      }
      return { suggestions: items };
    },
  };

  monaco.languages.registerCompletionItemProvider("c", provider);
  monaco.languages.registerCompletionItemProvider("cpp", provider);
}

export function registerHover(monaco) {
  const hoverProvider = {
    provideHover(model, position) {
      const word = model.getWordAtPosition(position);
      if (!word) return null;
      const name = word.word;
      const projSyms = cacheDirty ? buildSymbolIndex() : symbolCache;
      const matches = projSyms.filter((s) => s.name === name);
      if (matches.length === 0) return null;

      const contents = matches.map((m) => ({
        value: `**${m.kind}** \`${m.name}\`\n\nFrom: \`${m.path}\``,
      }));
      return {
        range: new monaco.Range(
          position.lineNumber,
          word.startColumn,
          position.lineNumber,
          word.endColumn,
        ),
        contents,
      };
    },
  };

  monaco.languages.registerHoverProvider("c", hoverProvider);
  monaco.languages.registerHoverProvider("cpp", hoverProvider);
}
