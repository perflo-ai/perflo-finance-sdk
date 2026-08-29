// Shared TypeScript AST parsing and inspection helpers belong here.

import ts from "typescript";

export function parseTypeScript(filename, source) {
  const sourceFile = ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const diagnostics = sourceFile.parseDiagnostics ?? [];
  if (diagnostics.length > 0) {
    const message = ts.flattenDiagnosticMessageText(
      diagnostics[0].messageText,
      "\n",
    );
    throw new TypeError(`Invalid TypeScript in ${filename}: ${message}`);
  }
  return sourceFile;
}

export function hasExportModifier(node) {
  return node.modifiers?.some(
    (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
  );
}

export function objectPropertyName(property) {
  if (
    "name" in property &&
    property.name !== undefined &&
    (ts.isIdentifier(property.name) ||
      ts.isStringLiteral(property.name) ||
      ts.isNumericLiteral(property.name))
  ) {
    return property.name.text;
  }
  return undefined;
}
