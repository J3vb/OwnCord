import ts from "typescript";

/** Tokenize Rust, ignoring comments (including nested block comments) and strings.
 * This is a registration-list parser, not a count of command declarations. */
function rustTokens(source: string): string[] {
  const tokens: string[] = [];
  for (let i = 0; i < source.length;) {
    const rest = source.slice(i);
    if (rest.startsWith("//")) {
      const end = source.indexOf("\n", i);
      i = end < 0 ? source.length : end;
    } else if (rest.startsWith("/*")) {
      let depth = 1;
      i += 2;
      while (depth && i < source.length) {
        if (source.startsWith("/*", i)) {
          depth++;
          i += 2;
        } else if (source.startsWith("*/", i)) {
          depth--;
          i += 2;
        } else i++;
      }
      if (depth) throw new Error("Unclosed Rust comment");
    } else {
      const raw = /^(?:br|r)(#*)"/.exec(rest);
      const quoted = /^(?:b|c)?"(?:\\[\s\S]|[^"\\])*"/.exec(rest);
      const char = /^(?:b)?'(?:\\(?:u\{[\da-fA-F]+\}|x[\da-fA-F]{2}|.)|[^'\\])'/.exec(rest);
      if (raw) {
        const end = source.indexOf(`"${raw[1]}`, i + raw[0].length);
        if (end < 0) throw new Error("Unclosed Rust raw string");
        i = end + 1 + raw[1]!.length;
      } else if (quoted || char) {
        i += (quoted ?? char)![0].length;
      } else {
        const token = /^(?:r#)?[A-Za-z_][A-Za-z_0-9]*|^::|^\S/.exec(rest);
        if (token) {
          tokens.push(token[0]);
          i += token[0].length;
        } else i++;
      }
    }
  }
  return tokens;
}

/** Union across all lists/configurations: Linux and devtools are documented too. */
export function registeredCommands(sources: string[]): Set<string> {
  const names = new Set<string>();
  for (const source of sources) {
    const tokens = rustTokens(source);
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i] !== "generate_handler" || tokens[i + 1] !== "!") continue;
      if (tokens[i + 2] !== "[") throw new Error("Expected generate_handler![...]");
      i += 3;
      while (tokens[i] !== "]") {
        // Attributes can contain brackets themselves; never interpret cfg as a command.
        while (tokens[i] === "#" && tokens[i + 1] === "[") {
          i += 2;
          let depth = 1;
          while (depth && i < tokens.length) {
            if (tokens[i] === "[") depth++;
            if (tokens[i] === "]") depth--;
            i++;
          }
        }
        let name = tokens[i++];
        if (!name || !/^(?:r#)?[A-Za-z_]\w*$/.test(name)) {
          throw new Error("Expected command path in generate_handler!");
        }
        while (tokens[i] === "::") {
          name = tokens[i + 1];
          i += 2;
        }
        if (!name || !/^(?:r#)?[A-Za-z_]\w*$/.test(name)) throw new Error("Invalid command path");
        names.add(name.replace(/^r#/, ""));
        if (tokens[i] === ",") i++;
        else if (tokens[i] !== "]") throw new Error("Expected comma in generate_handler!");
      }
    }
  }
  return names;
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

/** Follow the platform service bindings to the SDK, rather than spelling a
 * wrapper name. The checker handles aliases, generics and typed callbacks;
 * declarations/assignments/returns cover the lazy getInvoke and socket bindings. */
export function platformInvokes(
  program: ts.Program,
  files: ts.SourceFile[],
): {
  commands: Set<string>;
  importers: number;
} {
  const checker = program.getTypeChecker();
  const commands = new Set<string>();
  const assignments = new Map<ts.Symbol, ts.Expression[]>();
  for (const file of files)
    walk(file, (node) => {
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        const symbol = checker.getSymbolAtLocation(node.left);
        if (symbol) assignments.set(symbol, [...(assignments.get(symbol) ?? []), node.right]);
      }
    });
  function isInvoke(expr: ts.Expression, seen = new Set<ts.Node>()): boolean {
    if (seen.has(expr)) return false;
    seen.add(expr);
    if (
      ts.isAwaitExpression(expr) ||
      ts.isParenthesizedExpression(expr) ||
      ts.isNonNullExpression(expr)
    ) {
      return isInvoke(expr.expression, seen);
    }
    const type = checker.getNonNullableType(checker.getTypeAtLocation(expr));
    if (
      type.getCallSignatures().some((sig) => {
        const decl = sig.getDeclaration();
        return (
          decl &&
          /@tauri-apps\/api\/core\.d\.ts$/.test(
            decl.getSourceFile().fileName.replaceAll("\\", "/"),
          ) &&
          decl.name?.getText() === "invoke"
        );
      })
    )
      return true;
    const symbol = checker.getSymbolAtLocation(expr);
    for (const rhs of (symbol && assignments.get(symbol)) ?? []) {
      if (isInvoke(rhs, new Set(seen))) return true;
    }
    for (const decl of symbol?.declarations ?? []) {
      if (
        ts.isVariableDeclaration(decl) &&
        decl.initializer &&
        isInvoke(decl.initializer, new Set(seen))
      )
        return true;
    }
    if (ts.isCallExpression(expr)) {
      const decl = checker.getResolvedSignature(expr)?.getDeclaration();
      if (decl && ts.isFunctionDeclaration(decl) && decl.body) {
        let found = false;
        walk(decl.body, (node) => {
          if (
            ts.isReturnStatement(node) &&
            node.expression &&
            isInvoke(node.expression, new Set(seen))
          )
            found = true;
        });
        return found;
      }
    }
    return false;
  }
  let importers = 0;
  for (const file of files) {
    let importsTauri = false;
    walk(file, (node) => {
      const specifier = ts.isImportDeclaration(node)
        ? node.moduleSpecifier
        : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
          ? node.arguments[0]
          : undefined;
      if (specifier && ts.isStringLiteral(specifier) && specifier.text.startsWith("@tauri-apps/"))
        importsTauri = true;
      if (!ts.isCallExpression(node) || !isInvoke(node.expression)) return;
      const command = node.arguments[0];
      if (!command || !ts.isStringLiteralLike(command)) {
        throw new Error(`Nonliteral platform command in ${file.fileName}: ${node.getText()}`);
      }
      commands.add(command.text);
    });
    if (importsTauri) importers++;
  }
  return { commands, importers };
}

export function documentedCount(doc: string, label: string): number | undefined {
  const row = doc.split("\n").find((line) => line.startsWith("|") && line.includes(label));
  const cell = row?.split("|")[2]?.trim();
  return cell !== undefined && /^\d+$/.test(cell) ? Number(cell) : undefined;
}

export function documentedCommands(doc: string): Set<string> {
  const block = /<!-- registered-commands -->\s*```text\n([\s\S]*?)\n```/.exec(doc);
  if (!block) throw new Error("Missing registered command inventory");
  return new Set(block[1]!.trim().split(/\s+/));
}
